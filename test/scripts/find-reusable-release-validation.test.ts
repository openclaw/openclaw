// Covers policy selection layered on the strict normalized release evidence
// produced by release-ci-summary.mjs. Topology validation belongs there.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT_PATH = join(process.cwd(), "scripts/github/find-reusable-release-validation.sh");
// Homebrew Bash 5.3 can deadlock in nested command substitutions under Node's
// synchronous child runner on macOS; CI executes this script with system Bash.
const BASH_PATH = process.platform === "darwin" ? "/bin/bash" : "bash";
const tempDirs = createTempDirTracker();
const sharedTempDirs = createTempDirTracker();

const REPOSITORY = "openclaw/openclaw";
const PRODUCER_SHA = "0".repeat(40);
const VERIFIER_SHA = "c".repeat(40);
const DEFAULT_INPUTS = {
  provider: "openai",
  mode: "both",
};

interface ChildTuple {
  conclusion: string;
  policyPassed?: boolean;
  reportPublication?: string;
  role: string;
  runId: string;
  sourceParentRunId: string;
  status: string;
  workflowSha: string;
}

type NormalizedEvidence = ReturnType<typeof normalizedEvidence>;

interface RunFixture {
  error?: string;
  exitCode?: number;
  record?: NormalizedEvidence;
  runId: string;
}

afterEach(() => tempDirs.cleanup());
afterAll(() => sharedTempDirs.cleanup());

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commitFile(repo: string, filePath: string, content: string, message: string): string {
  writeFileSync(join(repo, filePath), content);
  git(repo, ["add", filePath]);
  git(repo, ["-c", "commit.gpgSign=false", "commit", "-qm", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

function plistFor(shortVersion: string, buildVersion: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleShortVersionString</key><string>${shortVersion}</string>
<key>CFBundleVersion</key><string>${buildVersion}</string>
</dict></plist>\n`;
}

function createRepo(
  options: { plistBuildVersion?: string; version?: string } = {},
  dirs = tempDirs,
) {
  const origin = dirs.make("evidence-reuse-origin-");
  git(origin, ["init", "-q", "-b", "main"]);
  git(origin, ["config", "user.email", "test-user@example.invalid"]);
  git(origin, ["config", "user.name", "Test User"]);
  git(origin, ["config", "uploadpack.allowReachableSHA1InWant", "true"]);
  writeFileSync(
    join(origin, "package.json"),
    `${JSON.stringify({ name: "x", version: options.version ?? "2026.7.1" }, null, 2)}\n`,
  );
  mkdirSync(join(origin, "apps/macos/Sources/OpenClaw/Resources"), { recursive: true });
  writeFileSync(
    join(origin, "apps/macos/Sources/OpenClaw/Resources/Info.plist"),
    plistFor("2026.7.1", options.plistBuildVersion ?? "2026070100"),
  );
  writeFileSync(join(origin, "CHANGELOG.md"), "# Changelog\n");
  writeFileSync(join(origin, "index.ts"), "export const value = 1;\n");
  git(origin, ["add", "-A"]);
  git(origin, ["-c", "commit.gpgSign=false", "commit", "-qm", "seed"]);
  return { origin, priorSha: git(origin, ["rev-parse", "HEAD"]) };
}

function cloneHead(origin: string, dirs = tempDirs): string {
  const clone = dirs.make("evidence-reuse-clone-");
  execFileSync("git", ["clone", "-q", "--depth=1", origin, clone], { encoding: "utf8" });
  return clone;
}

let sharedRepo: { clone: string; priorSha: string } | undefined;

function getSharedRepo(): { clone: string; priorSha: string } {
  if (!sharedRepo) {
    // The resolver only reads its target checkout, so policy cases can share one immutable clone.
    const { origin, priorSha } = createRepo({}, sharedTempDirs);
    sharedRepo = { clone: cloneHead(origin, sharedTempDirs), priorSha };
  }
  return sharedRepo;
}

function normalizedEvidence(
  options: {
    producerSha?: string;
    releaseProfile?: string;
    soak?: boolean;
    targetSha?: string;
    validationInputs?: Record<string, string> | null;
    workflowRef?: string;
    trustedWorkflowRef?: string;
  } = {},
) {
  const runId = "111";
  const producerSha = options.producerSha ?? PRODUCER_SHA;
  const releaseProfile = options.releaseProfile ?? "full";
  const soak = options.soak ?? true;
  const workflowRef = options.workflowRef ?? "main";
  const workflowFullRef = `refs/heads/${workflowRef}`;
  const shaPinned = workflowRef.startsWith("release-ci/");
  const trustedWorkflowRef = options.trustedWorkflowRef ?? "main";
  const protectedTagRoute = trustedWorkflowRef.startsWith("release-publish/");
  const trustedWorkflowFullRef = protectedTagRoute
    ? `refs/tags/${trustedWorkflowRef}`
    : "refs/heads/main";
  const validationInputs: Record<string, string> | null =
    options.validationInputs === undefined ? DEFAULT_INPUTS : options.validationInputs;
  const npmBetaCoverage = validationInputs?.coveragePolicy === "npm-beta-v1";
  const npmTelegramRequired =
    !npmBetaCoverage &&
    validationInputs !== null &&
    !validationInputs.telegramWaiver &&
    Boolean(validationInputs.npmTelegramPackageSpec || validationInputs.releasePackageSpec);
  // Model the normalized fields this consumer reads, not the upstream manifest/topology.
  // release-ci-summary.test.ts owns construction and validation of that complete report.
  const root = {
    artifact: { digest: `sha256:${"a".repeat(64)}` },
    manifestVersion: 4,
    runId,
    targetSha: options.targetSha ?? getSharedRepo().priorSha,
    url: `https://example.test/runs/${runId}`,
    producerOnTrustedMainLineage: !protectedTagRoute,
    workflowFullRef,
    workflowPath: ".github/workflows/full-release-validation.yml",
    workflowQualifiedPath: `.github/workflows/full-release-validation.yml@${workflowFullRef}`,
    workflowRef,
    workflowRefProof: protectedTagRoute
      ? "manifest-v3-protected-tag-exact-sha"
      : shaPinned
        ? "manifest-v3-sha-pinned-main-ancestry"
        : "manifest-v3-branch",
    workflowRefType: "branch",
    workflowRunPath: shaPinned
      ? `.github/workflows/full-release-validation.yml@${workflowFullRef}`
      : ".github/workflows/full-release-validation.yml",
    workflowSha: producerSha,
  };
  const roles: [string, string][] = [
    ["normalCi", "201"],
    ["pluginPrereleaseIndependent", "202"],
    ["pluginPrereleaseCandidate", "206"],
    ["releaseChecksIndependent", "203"],
    ["releaseChecksCandidate", "207"],
    ...(npmTelegramRequired ? ([["npmTelegram", "205"]] as const) : []),
    ["productPerformance", "204"],
  ];
  const children: ChildTuple[] = roles
    .filter(([role]) => !npmBetaCoverage || role !== "productPerformance")
    .map(([role, childRunId]) =>
      Object.assign(
        {
          conclusion: "success",
          policyPassed: true,
          role,
          runId: childRunId,
          sourceParentRunId: runId,
          status: "completed",
          workflowSha: producerSha,
        },
        role === "productPerformance" ? { reportPublication: "artifact-only" } : {},
      ),
    );
  const optional: {
    evidenceReuse: Record<string, unknown> | null;
    qualificationAdmission?: { coverage: { children: { key: string }[] } };
  } = { evidenceReuse: null };
  return {
    ...optional,
    children,
    conclusions: {
      allRequiredSucceeded: true,
      children: Object.fromEntries(children.map((child) => [child.role, child.conclusion])),
      current: "success",
      root: "success",
    },
    controls: {
      performanceReportPublication: "artifact-only",
    },
    current: structuredClone(root),
    directRoot: true,
    manifest: {},
    releaseProfile,
    repository: REPOSITORY,
    rerunGroup: "all",
    root,
    runReleaseSoak: soak,
    schema: "openclaw.release-validation-evidence/v4",
    producerOnTrustedMainLineage: !protectedTagRoute,
    trustedWorkflowFullRef,
    trustedWorkflowRef,
    valid: true,
    validationInputs,
    verifier: {
      schemaVersion: 3,
      sourceSha: VERIFIER_SHA,
    },
  };
}

const FAKE_GH = `#!/usr/bin/env bash
set -euo pipefail
[[ "\${1:-}" == "api" ]] || { echo "unexpected gh command: $*" >&2; exit 1; }
shift
jq_expr=""
endpoint=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -X|-F) shift 2 ;;
    --jq) jq_expr="$2"; shift 2 ;;
    *) [[ -n "$endpoint" ]] || endpoint="$1"; shift ;;
  esac
done
fixture="\${FAKE_GH_FIXTURES}/$(printf '%s' "$endpoint" | tr '/?' '__')"
[[ -f "\${fixture}.json" ]] || { echo "no fixture for $endpoint" >&2; exit 1; }
if [[ -n "$jq_expr" ]]; then
  exec jq -r "$jq_expr" "\${fixture}.json"
fi
exec cat "\${fixture}.json"
`;

const FAKE_VALIDATOR = `#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

function arg(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) throw new Error("missing validator argument: " + flag);
  return process.argv[index + 1];
}
const expected = {
  "--repo": "openclaw/openclaw",
  "--trusted-workflow-ref": process.env.FAKE_TRUSTED_WORKFLOW_REF,
  "--trusted-workflow-full-ref": process.env.FAKE_TRUSTED_WORKFLOW_FULL_REF,
  "--trusted-workflow-sha": process.env.FAKE_TRUSTED_WORKFLOW_SHA,
  "--verifier-source-sha": process.env.FAKE_VERIFIER_SHA,
  "--verifier-source-file": process.argv[1],
};
if (
  Object.entries(expected).some(([flag, value]) => arg(flag) !== value) ||
  !isDeepStrictEqual(JSON.parse(arg("--reuse-request-json")), JSON.parse(process.env.FAKE_REUSE_REQUEST)) ||
  (process.env.FAKE_QUALIFICATION_REUSE
    ? !isDeepStrictEqual(JSON.parse(arg("--qualification-reuse-json")), JSON.parse(process.env.FAKE_QUALIFICATION_REUSE))
    : process.argv.includes("--qualification-reuse-json")) ||
  !process.argv.includes("--json")
) {
  console.error("validator invocation contract mismatch");
  process.exit(2);
}
const fixture = JSON.parse(
  readFileSync(join(process.env.FAKE_VALIDATOR_FIXTURES, \`\${arg("--validate-run")}.json\`), "utf8"),
);
if (fixture.exitCode) {
  process.stdout.write(
    \`\${JSON.stringify({
      error: fixture.error ?? "fixture validator rejection",
      schema: "openclaw.release-validation-evidence/v3",
      valid: false,
    })}\\n\`,
  );
  process.exit(fixture.exitCode);
}
process.stdout.write(\`\${JSON.stringify(fixture.record)}\\n\`);
`;

function fixtureName(fixtures: string, endpoint: string): string {
  return join(fixtures, `${endpoint.replaceAll(/[/?]/gu, "_")}.json`);
}

function setUpFixtures(runs: RunFixture[]) {
  const root = tempDirs.make("evidence-reuse-fixtures-");
  const fixtures = join(root, "fixtures");
  const binDir = join(root, "bin");
  mkdirSync(fixtures, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "gh"), FAKE_GH);
  chmodSync(join(binDir, "gh"), 0o755);
  const validatorPath = join(root, "validator.mjs");
  writeFileSync(validatorPath, FAKE_VALIDATOR);

  writeFileSync(
    fixtureName(
      fixtures,
      "repos/openclaw/openclaw/actions/workflows/full-release-validation.yml/runs",
    ),
    JSON.stringify({ workflow_runs: runs.map(({ runId }) => ({ id: Number(runId) })) }),
  );
  for (const run of runs) {
    writeFileSync(join(fixtures, `${run.runId}.json`), JSON.stringify(run));
  }
  return { binDir, fixtures, validatorPath };
}

function runResolver(args: {
  binDir: string;
  compareBaseSha?: string;
  compareFiles?: string[];
  compareRenamed?: boolean;
  fixtures: string;
  inputs?: unknown;
  qualificationAdmission?: Record<string, unknown>;
  qualificationInputs?: Record<string, string>;
  releaseProfile?: string;
  repoDir: string;
  runReleaseSoak?: string;
  targetSha: string;
  trustedTagSha?: string;
  trustedTagType?: string;
  trustedWorkflowFullRef?: string;
  trustedWorkflowRef?: string;
  validatorPath: string;
  verifierOnMain?: boolean;
  workflowRef?: string;
  workflowSha?: string;
}) {
  const verifierSha = VERIFIER_SHA;
  const trustedWorkflowRef = args.trustedWorkflowRef ?? "main";
  const trustedWorkflowFullRef =
    args.trustedWorkflowFullRef ??
    (trustedWorkflowRef === "main" ? "refs/heads/main" : `refs/tags/${trustedWorkflowRef}`);
  const trustedWorkflowSha = verifierSha;
  const writeApi = (endpoint: string, response: unknown) =>
    writeFileSync(
      fixtureName(args.fixtures, `repos/${REPOSITORY}/${endpoint}`),
      JSON.stringify(response),
    );
  const request = {
    targetSha: args.targetSha,
    releaseProfile: args.releaseProfile ?? "full",
    runReleaseSoak: args.runReleaseSoak ?? "true",
    validationInputs: args.inputs === undefined ? DEFAULT_INPUTS : args.inputs,
  };
  writeApi(`compare/${verifierSha}...main`, {
    merge_base_commit: { sha: args.verifierOnMain === false ? "f".repeat(40) : verifierSha },
    status: args.verifierOnMain === false ? "diverged" : "ahead",
  });
  if (trustedWorkflowRef !== "main") {
    writeApi(`git/ref/tags/${trustedWorkflowRef}`, {
      object: {
        sha: args.trustedTagSha ?? trustedWorkflowSha,
        type: args.trustedTagType ?? "commit",
      },
    });
  }
  if (args.compareBaseSha) {
    writeApi(`compare/${args.compareBaseSha}...${args.targetSha}`, {
      files: (args.compareFiles ?? ["CHANGELOG.md"]).map((filename, index) =>
        Object.assign(
          {
            filename,
            status: args.compareRenamed && index === 0 ? "renamed" : "modified",
          },
          args.compareRenamed && index === 0 ? { previous_filename: "src/index.ts" } : {},
        ),
      ),
      merge_base_commit: { sha: args.compareBaseSha },
      status: "ahead",
    });
  }
  return spawnSync(
    BASH_PATH,
    [
      SCRIPT_PATH,
      ...Object.entries({
        "target-sha": request.targetSha,
        "workflow-sha": args.workflowSha ?? verifierSha,
        "verifier-source-sha": verifierSha,
        "workflow-ref": args.workflowRef ?? "main",
        "trusted-workflow-ref": trustedWorkflowRef,
        "trusted-workflow-full-ref": trustedWorkflowFullRef,
        "trusted-workflow-sha": trustedWorkflowSha,
        "release-profile": request.releaseProfile,
        "run-release-soak": request.runReleaseSoak,
        "inputs-json": JSON.stringify(request.validationInputs),
        repo: REPOSITORY,
        "repo-dir": args.repoDir,
      }).flatMap(([flag, value]) => [`--${flag}`, value]),
      ...(args.qualificationAdmission
        ? [
            "--qualification-admission-json",
            JSON.stringify(args.qualificationAdmission),
            "--qualification-inputs-json",
            JSON.stringify(args.qualificationInputs),
          ]
        : []),
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_GH_FIXTURES: args.fixtures,
        FAKE_TRUSTED_WORKFLOW_FULL_REF: trustedWorkflowFullRef,
        FAKE_TRUSTED_WORKFLOW_REF: trustedWorkflowRef,
        FAKE_TRUSTED_WORKFLOW_SHA: trustedWorkflowSha,
        FAKE_VALIDATOR_FIXTURES: args.fixtures,
        FAKE_REUSE_REQUEST: JSON.stringify(request),
        FAKE_QUALIFICATION_REUSE: args.qualificationAdmission
          ? JSON.stringify({
              candidateSha: args.targetSha,
              qualificationSha: args.workflowSha ?? verifierSha,
              workflowRef: args.workflowRef ?? "main",
              descriptor: args.qualificationAdmission,
              inputs: args.qualificationInputs,
            })
          : "",
        FAKE_VERIFIER_SHA: verifierSha,
        GITHUB_OUTPUT: "",
        OPENCLAW_RELEASE_CI_SUMMARY_VALIDATOR: args.validatorPath,
        PATH: `${args.binDir}:${process.env.PATH}`,
      },
    },
  );
}

function resolveEvidence(
  record: NormalizedEvidence,
  options: Partial<Parameters<typeof runResolver>[0]> = {},
) {
  return runResolver({
    ...setUpFixtures([{ record, runId: record.root.runId }]),
    repoDir: getSharedRepo().clone,
    targetSha: record.root.targetSha,
    ...options,
  });
}

function parseOutput(output: string): Record<string, string> {
  return Object.fromEntries(
    output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function expectReuse(
  result: ReturnType<typeof runResolver>,
  reuse = true,
  fields: Record<string, string> = {},
) {
  expect(result.status, result.stderr).toBe(0);
  expect(parseOutput(result.stdout), result.stderr).toMatchObject({
    reuse: String(reuse),
    ...fields,
  });
}

const trustedTag = `release-publish/${VERIFIER_SHA.slice(0, 12)}-456`;
const pinnedVerifierRef = `release-ci/${VERIFIER_SHA.slice(0, 12)}-123`;
function protectedEvidence(options: Partial<Parameters<typeof normalizedEvidence>[0]> = {}) {
  return normalizedEvidence({
    producerSha: VERIFIER_SHA,
    targetSha: getSharedRepo().priorSha,
    trustedWorkflowRef: trustedTag,
    workflowRef: `release-ci/${VERIFIER_SHA.slice(0, 12)}-122`,
    ...options,
  });
}

function resolveProtectedEvidence(
  record: NormalizedEvidence,
  options: Partial<Parameters<typeof runResolver>[0]> = {},
) {
  return resolveEvidence(record, {
    trustedWorkflowRef: trustedTag,
    verifierOnMain: false,
    workflowRef: pinnedVerifierRef,
    ...options,
  });
}

function changedEvidence(label: string, fields: Partial<NormalizedEvidence>) {
  return { label, mutate: (record: NormalizedEvidence) => Object.assign(record, fields) };
}

function incompatible(
  label: string,
  expected: string,
  recordOptions: Parameters<typeof normalizedEvidence>[0],
  resolverOptions: Partial<Parameters<typeof runResolver>[0]> = {},
) {
  return { label, expected, recordOptions, resolverOptions };
}

describe("scripts/github/find-reusable-release-validation.sh", () => {
  it.each(["main", `release-publish/${VERIFIER_SHA.slice(0, 12)}-456`])(
    "selects candidate-owned evidence through admitted P on %s",
    (trustedWorkflowRef) => {
      const { priorSha } = getSharedRepo();
      const record = normalizedEvidence({
        targetSha: priorSha,
        producerSha: priorSha,
        workflowRef: `release-ci/${priorSha.slice(0, 12)}-122`,
        trustedWorkflowRef,
      });
      record.producerOnTrustedMainLineage = false;
      for (const tuple of [record.current, record.root]) {
        tuple.producerOnTrustedMainLineage = false;
        tuple.workflowRefProof = "candidate-owned-admission-v1";
      }
      record.qualificationAdmission = {
        coverage: { children: record.children.map(({ role }) => ({ key: role })) },
      };
      const options = {
        workflowSha: priorSha,
        workflowRef: `release-ci/${priorSha.slice(0, 12)}-123`,
        trustedWorkflowRef,
        qualificationAdmission: { workflowSha: VERIFIER_SHA, artifactId: 789 },
        qualificationInputs: { ref: priorSha, expected_sha: priorSha },
      };
      const result = resolveEvidence(record, options);
      expect(result.status).toBe(0);
      expect(parseOutput(result.stdout)).toMatchObject({ reuse: "true", evidence_run_id: "111" });

      const missingAdmission = resolveEvidence(record, {
        ...options,
        qualificationAdmission: undefined,
        qualificationInputs: undefined,
      });
      expect(parseOutput(missingAdmission.stdout)).toMatchObject({ reuse: "false" });
    },
  );

  it.each(["main", "protected tooling lineage"])(
    "reuses strict SHA-pinned evidence through %s",
    (route) => {
      const protectedRoute = route !== "main";
      const producerSha = "d".repeat(40);
      const makeEvidence = protectedRoute ? protectedEvidence : normalizedEvidence;
      const record = makeEvidence({
        producerSha,
        workflowRef: `release-ci/${producerSha.slice(0, 12)}-122`,
      });
      if (protectedRoute) {
        record.current.workflowRefProof = "manifest-v3-protected-tag-tooling-lineage";
        record.root.workflowRefProof = "manifest-v3-protected-tag-tooling-lineage";
      }
      const result = protectedRoute
        ? resolveProtectedEvidence(record)
        : resolveEvidence(record, { workflowRef: pinnedVerifierRef });
      expectReuse(result, true, { evidence_run_id: "111" });
    },
  );

  it.each(["", "2026.8.1"])(
    "reuses strict protected-tag evidence with Telegram waiver %j",
    (version) => {
      const record = protectedEvidence({
        validationInputs: version
          ? {
              ...DEFAULT_INPUTS,
              telegramWaiver: `${version}-owner-approved`,
              targetVersion: version,
              releasePackageSpec: `openclaw@${version}`,
            }
          : DEFAULT_INPUTS,
      });

      const result = resolveProtectedEvidence(record, {
        inputs: record.validationInputs,
      });

      expectReuse(result, true, { evidence_run_id: "111" });
    },
  );

  it("rejects unrecognized protected tooling proof", () => {
    const workflowRefProof = "manifest-v3-protected-tag-diverged";
    const record = protectedEvidence();
    record.current.workflowRefProof = workflowRefProof;
    record.root.workflowRefProof = workflowRefProof;

    const result = resolveProtectedEvidence(record);

    expectReuse(result, false);
  });

  it.each([
    ["moved protected tag", { trustedTagSha: "d".repeat(40) }],
    ["annotated protected tag", { trustedTagType: "tag" }],
    ["same-name branch", { trustedWorkflowFullRef: `refs/heads/${trustedTag}` }],
  ] as const)("rejects protected tooling identity drift: %s", (_label, options) => {
    const record = protectedEvidence();

    const result = resolveEvidence(record, {
      trustedWorkflowRef: trustedTag,
      workflowRef: pinnedVerifierRef,
      ...options,
    });

    expectReuse(result, false);
  });

  it("reuses Telegram failures only when the strict verifier accepted their policy", () => {
    const validationInputs = {
      ...DEFAULT_INPUTS,
      npmTelegramPackageSpec: "openclaw@2026.7.1",
    };
    const record = normalizedEvidence({ validationInputs });
    for (const child of record.children) {
      if (
        ["npmTelegram", "releaseChecksIndependent", "releaseChecksCandidate"].includes(child.role)
      ) {
        child.conclusion = "failure";
        record.conclusions.children[child.role] = "failure";
      }
    }

    const result = resolveEvidence(record, {
      inputs: validationInputs,
    });

    expectReuse(result, true, { evidence_run_id: "111" });
  });

  it("rejects noncanonical release refs and workflow SHAs outside trusted main", () => {
    const record = normalizedEvidence();

    const forgedRef = resolveEvidence(record, { workflowRef: "release-ci/not-trusted" });
    expect(parseOutput(forgedRef.stdout)).toMatchObject({ reuse: "false" });

    const untrustedSha = resolveEvidence(record, {
      verifierOnMain: false,
      workflowRef: `release-ci/${VERIFIER_SHA.slice(0, 12)}-123`,
    });
    expect(parseOutput(untrustedSha.stdout)).toMatchObject({ reuse: "false" });
  });

  it("surfaces bounded validator rejection and selects the next strict record", () => {
    const { clone, priorSha } = getSharedRepo();
    const record = normalizedEvidence({ targetSha: priorSha });
    const validatorError = `evidence source mismatch\n${"x".repeat(600)}`;
    const { binDir, fixtures, validatorPath } = setUpFixtures([
      { error: validatorError, exitCode: 1, runId: "222" },
      { record, runId: "111" },
    ]);

    const result = runResolver({
      binDir,
      fixtures,
      repoDir: clone,
      targetSha: priorSha,
      validatorPath,
    });

    expectReuse(result, true, { evidence_run_id: "111" });
    expect(result.stderr).toContain(
      `run 222: shared evidence validator rejected the run: evidence source mismatch ${"x".repeat(472)}...; skipping`,
    );
    expect(result.stderr).not.toContain("\nxxxxxxxx");
  });

  it.each([
    changedEvidence("reused wrapper", { directRoot: false, evidenceReuse: { rootRunId: "42" } }),
    changedEvidence("untrusted producer ref", { trustedWorkflowRef: "release/2026.7.1" }),
    changedEvidence("missing trusted-main lineage proof", { producerOnTrustedMainLineage: false }),
    {
      label: "tag-qualified producer workflow",
      mutate(record: NormalizedEvidence) {
        record.root.workflowFullRef = "refs/tags/main";
        record.current.workflowFullRef = "refs/tags/main";
      },
    },
    {
      label: "verifier source drift",
      mutate(record: NormalizedEvidence) {
        record.verifier.sourceSha = "d".repeat(40);
      },
    },
    changedEvidence("non-full rerun group", { rerunGroup: "package" }),
    {
      label: "publishing performance reports",
      mutate(record: NormalizedEvidence) {
        record.controls.performanceReportPublication = "publish";
      },
    },
    {
      label: "missing performance report publication proof",
      mutate(record: NormalizedEvidence) {
        const performance = record.children.find((child) => child.role === "productPerformance");
        if (!performance) {
          throw new Error("missing product performance child");
        }
        delete performance.reportPublication;
      },
    },
    {
      label: "missing required role",
      mutate(record: NormalizedEvidence) {
        record.children.pop();
      },
    },
    {
      label: "duplicate child run id",
      mutate(record: NormalizedEvidence) {
        const firstChild = expectDefined(record.children[0], "first reusable release child");
        const secondChild = expectDefined(record.children[1], "second reusable release child");
        secondChild.runId = firstChild.runId;
      },
    },
    {
      label: "successful child rejected by canonical policy",
      mutate(record: NormalizedEvidence) {
        expectDefined(record.children[0], "reusable release child").policyPassed = false;
      },
    },
    {
      label: "extra child role",
      mutate(record: NormalizedEvidence) {
        record.children.push({
          ...expectDefined(record.children[0], "base reusable release child"),
          role: "npmTelegram",
          runId: "205",
        });
      },
    },
    {
      label: "invalid root artifact digest",
      mutate(record: NormalizedEvidence) {
        record.root.artifact.digest = "sha256:not-a-digest";
        record.current.artifact.digest = "sha256:not-a-digest";
      },
    },
  ])("rejects normalized evidence that is not reusable: $label", (testCase) => {
    const record = normalizedEvidence();
    testCase.mutate(record);

    const result = resolveEvidence(record);

    expectReuse(result, false);
    expect(result.stderr).toContain("not a strict direct-root full validation");
  });

  it.each([
    incompatible(
      "beta evidence for stable",
      "profile beta differs from stable",
      { releaseProfile: "beta" },
      { releaseProfile: "stable" },
    ),
    incompatible("different lane inputs", "validation inputs differ", {
      validationInputs: { ...DEFAULT_INPUTS, provider: "anthropic" },
    }),
    incompatible(
      "owner-waived Telegram evidence for an unwaived request",
      "validation inputs differ",
      {
        validationInputs: {
          ...DEFAULT_INPUTS,
          telegramWaiver: "2026.8.1-owner-approved",
          targetVersion: "2026.8.1",
        },
      },
    ),
    incompatible(
      "missing required soak",
      "soak false differs from true",
      { soak: false },
      { runReleaseSoak: "true" },
    ),
    incompatible(
      "extra soak evidence",
      "soak true differs from false",
      { soak: true },
      { runReleaseSoak: "false" },
    ),
  ])(
    "rejects evidence with incompatible policy coverage: $label",
    ({ expected, recordOptions, resolverOptions }) => {
      const record = normalizedEvidence(recordOptions);

      const result = resolveEvidence(record, resolverOptions);

      expectReuse(result, false);
      expect(result.stderr).toContain(expected);
    },
  );

  it.each([
    { profile: "beta", coverage: "matching" },
    { profile: "stable", coverage: "matching" },
    { profile: "beta", coverage: "legacy-receipt" },
  ])(
    "requires identical npm $profile coverage and context for reuse: $coverage",
    ({ profile, coverage }) => {
      const { clone, priorSha } = getSharedRepo();
      const inputs = {
        ...DEFAULT_INPUTS,
        coveragePolicy: `npm-${profile}-v1`,
        skipPackageTelegramE2e: String(profile === "beta"),
        targetVersion: profile === "beta" ? "2026.8.28-beta.1" : "2026.8.28",
        targetContextRef: "release/2026.8.28",
      };
      const record = normalizedEvidence({
        releaseProfile: profile,
        soak: profile === "stable",
        targetSha: priorSha,
        validationInputs: coverage === "legacy-receipt" ? DEFAULT_INPUTS : inputs,
      });
      const fixtures = setUpFixtures([{ record, runId: "111" }]);

      const result = runResolver({
        ...fixtures,
        inputs,
        releaseProfile: profile,
        repoDir: clone,
        runReleaseSoak: String(profile === "stable"),
        targetSha: priorSha,
      });
      expect(result.status).toBe(0);
      expect(parseOutput(result.stdout).reuse).toBe(coverage === "matching" ? "true" : "false");
    },
  );

  it.each([
    {
      name: "changelog-only",
      file: "CHANGELOG.md",
      content: "# Changelog\n\n- beta3\n",
      reuse: true,
    },
    { name: "code", file: "index.ts", content: "export const value = 2;\n", reuse: false },
    { name: "source rename", file: "CHANGELOG.md", content: "renamed source\n", reuse: false },
  ])("checks cross-SHA reuse for a $name delta", ({ name, file, content, reuse }) => {
    const { origin, priorSha } = createRepo();
    const targetSha = commitFile(origin, file, content, "fixture delta");
    const result = resolveEvidence(normalizedEvidence({ targetSha: priorSha }), {
      compareBaseSha: priorSha,
      compareFiles: [file],
      compareRenamed: name === "source rename",
      repoDir: cloneHead(origin),
      targetSha,
    });
    expectReuse(result, reuse);
    if (reuse) {
      expect(parseOutput(result.stdout), result.stderr).toMatchObject({
        changed_path_count: "1",
        changed_paths: '["CHANGELOG.md"]',
        evidence_policy: "changelog-only-release-v1",
        evidence_sha: priorSha,
      });
    } else {
      expect(result.stderr).toContain("is not a CHANGELOG.md-only descendant");
    }
  });

  it.each([
    { version: "2026.7.1", delta: "selected" },
    { version: "2026.7.1", delta: "unrelated" },
    { version: "2026.7.1-beta.1", delta: "selected" },
    { version: "2026.7.1-beta.1", delta: "unrelated" },
    { version: "2026.7.1-beta.1", delta: "dedicated-beta" },
  ])("checks $version split release files in the shell resolver ($delta)", ({ version, delta }) => {
    const { origin, priorSha } = createRepo({ version });
    const entryVersion = delta === "dedicated-beta" ? version : "2026.7.1";
    const entryPath = `CHANGELOG/${entryVersion}.md`;
    const recordPath = `CHANGELOG/records/${entryVersion}.md`;
    mkdirSync(join(origin, "CHANGELOG/records"), { recursive: true });
    commitFile(origin, entryPath, `## ${entryVersion}\n\nReleased.\n`, "docs: release entry");
    const targetSha = commitFile(origin, recordPath, "Contributors.\n", "docs: release record");
    const inputs = { ...DEFAULT_INPUTS, targetVersion: version };
    const record = normalizedEvidence({ targetSha: priorSha, validationInputs: inputs });
    const fixtures = setUpFixtures([{ record, runId: "111" }]);
    const changedPaths = [
      entryPath,
      recordPath,
      ...(delta === "unrelated" ? ["CHANGELOG/2026.6.8.md"] : []),
    ];
    const result = runResolver({
      ...fixtures,
      compareBaseSha: priorSha,
      compareFiles: changedPaths,
      inputs,
      repoDir: cloneHead(origin),
      targetSha,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(parseOutput(result.stdout).reuse, result.stderr).toBe(
      delta === "unrelated" ? "false" : "true",
    );
    if (delta !== "unrelated") {
      expect(parseOutput(result.stdout)).toMatchObject({
        changed_paths: JSON.stringify(changedPaths),
        evidence_policy: "split-changelog-release-v1",
      });
    }
  });

  it("rejects target version metadata that is internally inconsistent", () => {
    const { origin, priorSha } = createRepo({ plistBuildVersion: "2026061000" });
    const clone = cloneHead(origin);
    const record = normalizedEvidence({ targetSha: priorSha });

    const result = resolveEvidence(record, {
      repoDir: clone,
      targetSha: priorSha,
    });

    expectReuse(result, false, {
      reuse_reason: "target version metadata is inconsistent",
    });
  });

  it("rewrites inherited v3 producer identity to the current immutable workflow SHA", () => {
    const workflow = readFileSync(".github/workflows/full-release-validation.yml", "utf8");
    expect(workflow).toContain('--arg workflowSha "$GITHUB_SHA"');
    expect(workflow).toContain("workflowSha: $workflowSha");
    expect(workflow).toContain("ref: ${{ github.sha }}");
  });
});
