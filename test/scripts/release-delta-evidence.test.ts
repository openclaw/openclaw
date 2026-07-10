import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  computeTargetClawHubRosterAudit,
  createReleaseDeltaResolver,
  parseEvidenceRuns,
  parseReleaseDeltaPolicy,
  selectSuccessfulJobByName,
  validateArtifactInventory,
  validateClawHubPublishDocument,
  validateCompletedJobSet,
  validateNoChainedReleaseDeltaEvidence,
  validateReleaseDelta,
  validateReleaseDeltaManifest,
  validateSuccessfulJobSet,
} from "../../scripts/lib/release-delta-evidence.mjs";
import { parseReleaseDeltaArgs } from "../../scripts/release-delta-evidence.mjs";

const VERSION = "2026.7.1-beta.3";
const TAG = `v${VERSION}`;
const RELEASE_REF = "release/2026.7.1";
const SHA256 = "a".repeat(64);
const DIGEST = `sha256:${SHA256}`;
const POLICY_PATH = ".github/release-delta-policies/test.json";
const roots: string[] = [];

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function hashJobNames(names: string[]) {
  return createHash("sha256")
    .update(`${names.toSorted().join("\n")}\n`)
    .digest("hex");
}

function hashCompletedJobs(jobs: Array<{ name: string; conclusion: string }>) {
  return createHash("sha256")
    .update(
      `${jobs
        .map((job) => `${job.name}\t${job.conclusion}`)
        .toSorted()
        .join("\n")}\n`,
    )
    .digest("hex");
}

function write(root: string, file: string, contents: string) {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function fixtureRepo() {
  const root = mkdtempSync(path.join(tmpdir(), "release-delta-v3-"));
  roots.push(root);
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Release Test"]);
  git(root, ["config", "user.email", "release@example.com"]);

  write(root, "package.json", `${JSON.stringify({ version: VERSION })}\n`);
  write(root, "CHANGELOG.md", "# Changelog\n\n## 2026.7.1\n\n- Baseline.\n");
  write(root, "src/runtime.ts", "export const value = 1;\n");
  write(root, ".github/workflows/install-smoke.yml", "name: Install Smoke\n");
  write(
    root,
    "extensions/demo/package.json",
    `${JSON.stringify({
      name: "@openclaw/demo",
      version: VERSION,
      openclaw: { release: { publishToClawHub: true } },
    })}\n`,
  );
  for (const file of [
    "docs/ci.md",
    "docs/reference/RELEASING.md",
    "docs/reference/full-release-validation.md",
  ]) {
    write(root, file, `${file}\n`);
  }
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "test: baseline"]);
  const baselineSha = git(root, ["rev-parse", "HEAD"]);

  write(root, "CHANGELOG.md", "# Changelog\n\n## 2026.7.1\n\n- Proven source.\n");
  git(root, ["add", "CHANGELOG.md"]);
  git(root, ["commit", "-m", "docs: source notes"]);
  const sourceSha = git(root, ["rev-parse", "HEAD"]);

  write(root, "src/runtime.ts", "export const value = 2;\n");
  git(root, ["add", "src/runtime.ts"]);
  git(root, ["commit", "-m", "fix: runtime backport"]);
  const runtimeSha = git(root, ["rev-parse", "HEAD"]);

  write(
    root,
    ".github/workflows/install-smoke.yml",
    "name: Install Smoke\n# exact target transport\n",
  );
  git(root, ["add", ".github/workflows/install-smoke.yml"]);
  git(root, ["commit", "-m", "fix(ci): exact install smoke"]);
  const parentSha = git(root, ["rev-parse", "HEAD"]);

  write(root, "CHANGELOG.md", "# Changelog\n\n## 2026.7.1\n\n- Final notes.\n");
  git(root, ["add", "CHANGELOG.md"]);
  git(root, ["commit", "-m", "docs: final notes"]);
  const targetSha = git(root, ["rev-parse", "HEAD"]);
  return { baselineSha, parentSha, root, runtimeSha, sourceSha, targetSha };
}

type Fixture = ReturnType<typeof fixtureRepo>;

function role(
  id: string,
  input: string,
  mode: "fresh" | "reused",
  expected: "source" | "parent" | "target",
  impactPatterns: string[] = [],
) {
  return {
    id,
    gate: id,
    input,
    mode,
    workflow: `.github/workflows/${id}.yml`,
    impactPatterns:
      mode === "reused" ? ["^packages/unaffected/", ...impactPatterns] : impactPatterns,
    run: {
      event: "workflow_dispatch",
      headBranch: mode === "reused" ? RELEASE_REF : "main",
      attempt: 1,
      conclusions: ["success"],
    },
    job: { name: id, conclusion: "success" },
    binding: { type: "run-head", expected },
  };
}

function npmPreflightArtifactFiles() {
  return [
    { path: "ai-runtime-SHA256SUMS" },
    { path: "dependency-evidence/dependency-changes-report.md" },
    { path: "dependency-evidence/dependency-changes-report.json" },
    { path: "dependency-evidence/dependency-evidence-manifest.json" },
    { path: "dependency-evidence/dependency-evidence-summary.md" },
    { path: "dependency-evidence/dependency-ownership-surface-report.json" },
    { path: "dependency-evidence/dependency-ownership-surface-report.md" },
    { path: "dependency-evidence/dependency-vulnerability-gate.json" },
    { path: "dependency-evidence/dependency-vulnerability-gate.md" },
    { path: "dependency-evidence/transitive-manifest-risk-report.json" },
    { path: "dependency-evidence/transitive-manifest-risk-report.md" },
    { path: `openclaw-${VERSION}.tgz` },
    { path: `openclaw-ai-${VERSION}.tgz` },
    { path: "preflight-manifest.json" },
    { path: "release-npm-dist-tag.txt" },
    { path: "release-sha.txt" },
    { path: "release-tag.txt" },
  ];
}

function npmRole(
  id: string,
  input: string,
  mode: "fresh" | "reused",
  impactPatterns: string[] = [],
) {
  const expected = mode === "reused" ? "source" : "target";
  const expectedSha = mode === "reused" ? "$sourceSha" : "$targetSha";
  const artifactSha = mode === "reused" ? "{sourceSha}" : "{targetSha}";
  const value: any = role(id, input, mode, expected, impactPatterns);
  value.workflow = ".github/workflows/openclaw-npm-release.yml";
  value.run = {
    event: "workflow_dispatch",
    headBranch: RELEASE_REF,
    attempt: 1,
    conclusions: ["success"],
  };
  value.job = { name: "preflight_openclaw_npm", conclusion: "success" };
  value.artifacts = [
    {
      key: "npm-preflight",
      name: `openclaw-npm-preflight-${artifactSha}`,
      files: npmPreflightArtifactFiles(),
    },
  ];
  value.reports = [
    {
      artifactKey: "npm-preflight",
      path: "preflight-manifest.json",
      format: "json",
      assertions: [
        { pointer: "/version", op: "eq", value: 1 },
        { pointer: "/releaseTag", op: "eq", value: TAG },
        { pointer: "/releaseSha", op: "eq", value: expectedSha },
        { pointer: "/npmDistTag", op: "eq", value: "beta" },
        { pointer: "/packageName", op: "eq", value: "openclaw" },
        { pointer: "/packageVersion", op: "eq", value: VERSION },
        { pointer: "/tarballName", op: "eq", value: `openclaw-${VERSION}.tgz` },
        { pointer: "/tarballSha256", op: "matches", value: "^[0-9a-f]{64}$" },
        { pointer: "/dependencyTarballs", op: "length", value: 1 },
        { pointer: "/dependencyTarballs/0/packageName", op: "eq", value: "@openclaw/ai" },
        { pointer: "/dependencyTarballs/0/packageVersion", op: "eq", value: VERSION },
        {
          pointer: "/dependencyTarballs/0/tarballName",
          op: "eq",
          value: `openclaw-ai-${VERSION}.tgz`,
        },
        {
          pointer: "/dependencyTarballs/0/tarballSha256",
          op: "matches",
          value: "^[0-9a-f]{64}$",
        },
        { pointer: "/dependencyEvidenceDir", op: "eq", value: "dependency-evidence" },
        {
          pointer: "/dependencyEvidenceManifest",
          op: "eq",
          value: "dependency-evidence/dependency-evidence-manifest.json",
        },
      ],
    },
  ];
  value.binding = { type: "run-head", expected };
  return value;
}

function telegramRole() {
  const value: any = role("target-telegram", "telegramRuns", "fresh", "target");
  value.workflow = ".github/workflows/npm-telegram-beta-e2e.yml";
  value.run = {
    event: "workflow_dispatch",
    headBranch: "main",
    attempt: 1,
    conclusions: ["success"],
  };
  value.job = { name: "Run package Telegram E2E", conclusion: "success" };
  value.artifacts = [
    {
      key: "package-consumption",
      name: "npm-telegram-package-consumption-{runId}-{runAttempt}",
      files: [{ path: "package-consumption.json" }],
    },
  ];
  value.reports = [
    {
      artifactKey: "package-consumption",
      path: "package-consumption.json",
      format: "json",
      assertions: [
        { pointer: "/schemaVersion", op: "eq", value: 1 },
        { pointer: "/workflow/runAttempt", op: "eq", value: 1 },
        {
          pointer: "/workflow/path",
          op: "eq",
          value: ".github/workflows/npm-telegram-beta-e2e.yml",
        },
        { pointer: "/targetSha", op: "eq", value: "$targetSha" },
        { pointer: "/packageVersion", op: "eq", value: "$version" },
        { pointer: "/packageArtifact/runId", op: "eq", value: "$targetNpmRunId" },
        { pointer: "/packageArtifact/id", op: "eq", value: "$targetNpmArtifactId" },
        {
          pointer: "/packageArtifact/name",
          op: "eq",
          value: "$targetNpmArtifactName",
        },
        {
          pointer: "/packageArtifact/digest",
          op: "eq",
          value: "$targetNpmArtifactDigest",
        },
        { pointer: "/packageArtifact/root/name", op: "eq", value: "$targetRootName" },
        {
          pointer: "/packageArtifact/root/sha256",
          op: "eq",
          value: "$targetRootSha256",
        },
        { pointer: "/packageArtifact/ai/name", op: "eq", value: "$targetAiName" },
        {
          pointer: "/packageArtifact/ai/sha256",
          op: "eq",
          value: "$targetAiSha256",
        },
        { pointer: "/qa/providerMode", op: "eq", value: "mock-openai" },
        { pointer: "/qa/scenario", op: "eq", value: "" },
        { pointer: "/qa/conclusion", op: "eq", value: "success" },
      ],
    },
  ];
  value.binding = {
    type: "artifact-json",
    artifactKey: "package-consumption",
    path: "package-consumption.json",
    pointer: "/targetSha",
    expected: "target",
  };
  return value;
}

function clawHubRole({
  id = "target-clawhub",
  mode = "fresh",
}: {
  id?: string;
  mode?: "fresh" | "reused";
} = {}) {
  const expected = mode === "fresh" ? "target" : "source";
  const value: any = role(id, "clawhubRuns", mode, expected);
  const base = `clawhub-package-openclaw-demo-${VERSION}`;
  value.artifacts = [
    {
      key: "package",
      name: base,
      files: [{ path: `openclaw-demo-${VERSION}.tgz` }],
    },
    {
      key: "inspector",
      name: `${base}-inspector`,
      files: [
        { path: "plugin-inspector-issues.md" },
        { path: "plugin-inspector-report.json" },
        { path: "plugin-inspector-report.md" },
      ],
    },
    {
      key: "publish-json",
      name: `${base}-publish-json`,
      files: [{ path: "package-publish.json" }],
    },
  ];
  value.reports = [
    {
      artifactKey: "inspector",
      path: "plugin-inspector-report.json",
      format: "json",
      assertions: [
        { pointer: "/status", op: "eq", value: "pass" },
        { pointer: "/summary/breakageCount", op: "eq", value: 0 },
        { pointer: "/fixtures", op: "length", value: 1 },
        { pointer: "/fixtures/0/status", op: "eq", value: "ok" },
        { pointer: "/fixtures/0/package/name", op: "eq", value: "@openclaw/demo" },
        { pointer: "/fixtures/0/package/version", op: "eq", value: VERSION },
      ],
    },
    {
      artifactKey: "publish-json",
      path: "package-publish.json",
      format: "json",
      assertions: [
        { pointer: "/name", op: "eq", value: "@openclaw/demo" },
        { pointer: "/version", op: "eq", value: VERSION },
        { pointer: "/commit", op: "eq", value: mode === "fresh" ? "$targetSha" : "$sourceSha" },
      ],
    },
  ];
  value.binding = {
    type: "artifact-json",
    artifactKey: "publish-json",
    path: "package-publish.json",
    pointer: "/commit",
    expected,
  };
  return value;
}

function producerToolingRole(id = "producer-tooling") {
  return {
    id,
    gate: id,
    input: "producer",
    mode: "fresh",
    producerJob: "target-tooling",
    workflow: ".github/workflows/release-delta-evidence.yml",
    impactPatterns: [],
    run: {
      event: "workflow_dispatch",
      headBranch: "main",
      attempt: 1,
      conclusions: ["success"],
    },
    job: { name: "Target release tooling", conclusion: "success" },
    artifacts: [
      {
        key: "tooling",
        name: "release-delta-tooling-{runId}-{runAttempt}",
        files: [{ path: "tooling-check-evidence.json" }],
      },
    ],
    reports: [
      {
        artifactKey: "tooling",
        path: "tooling-check-evidence.json",
        format: "json",
        assertions: [
          { pointer: "/schemaVersion", op: "eq", value: 1 },
          { pointer: "/sourceSha", op: "eq", value: "$sourceSha" },
          { pointer: "/parentSha", op: "eq", value: "$parentSha" },
          { pointer: "/targetSha", op: "eq", value: "$targetSha" },
          { pointer: "/conclusion", op: "eq", value: "success" },
        ],
      },
    ],
    binding: {
      type: "artifact-json",
      artifactKey: "tooling",
      path: "tooling-check-evidence.json",
      pointer: "/targetSha",
      expected: "target",
    },
  };
}

function policyFixture(repo: Fixture): any {
  const roles = [
    npmRole("source-npm", "sourceRuns", "reused"),
    npmRole("target-npm", "targetRuns", "fresh", [
      "^\\.github/workflows/install-smoke\\.yml$",
      "^src/runtime\\.ts$",
    ]),
    telegramRole(),
    clawHubRole(),
    role("aggregate-closure", "closureRuns", "reused", "source"),
  ];
  const completedJobs = [
    { name: "source-binding", conclusion: "success" },
    { name: "successful-gate", conclusion: "success" },
    ...Array.from({ length: 4 }, (_, index) => ({
      name: `cancelled-${index}`,
      conclusion: index % 2 === 0 ? "cancelled" : "failure",
    })),
  ];
  return {
    schemaVersion: 3,
    release: {
      version: VERSION,
      tag: TAG,
      targetRef: RELEASE_REF,
      changelogBaseRef: "v2026.6.11",
    },
    git: {
      baselineSha: repo.baselineSha,
      sourceSha: repo.sourceSha,
      allowedPathPatterns: [
        "^\\.github/workflows/install-smoke\\.yml$",
        "^CHANGELOG\\.md$",
        "^src/runtime\\.ts$",
      ],
      metadataPaths: ["CHANGELOG.md"],
      trustedDocs: [
        "docs/ci.md",
        "docs/reference/RELEASING.md",
        "docs/reference/full-release-validation.md",
      ],
      trustBundlePaths: [
        ".github/workflows/release-delta-evidence.yml",
        "scripts/lib/release-delta-evidence.mjs",
        "scripts/release-delta-evidence.mjs",
      ],
      terminalCommit: "changelog-only",
    },
    inputs: {
      sourceRuns: { cardinality: "one" },
      targetRuns: { cardinality: "one" },
      telegramRuns: { cardinality: "one" },
      clawhubRuns: { cardinality: "one" },
      closureRuns: { cardinality: "one" },
      aggregateRuns: { cardinality: "one" },
    },
    roles,
    cancelledAggregate: {
      input: "aggregateRuns",
      workflow: ".github/workflows/openclaw-release-checks.yml",
      run: {
        event: "workflow_dispatch",
        headBranch: RELEASE_REF,
        attempt: 1,
        conclusion: "cancelled",
      },
      sourceBinding: {
        jobName: "source-binding",
        marker: "Release source SHA",
      },
      completedJobs: {
        count: completedJobs.length,
        namesAndConclusionsSha256: hashCompletedJobs(completedJobs),
      },
      successfulJobs: {
        count: 2,
        namesSha256: hashJobNames(["source-binding", "successful-gate"]),
      },
      skippedJobs: {
        count: 0,
        namesSha256: hashJobNames([]),
      },
      dispositions: Array.from({ length: 4 }, (_, index) => ({
        name: `cancelled-${index}`,
        conclusion: index % 2 === 0 ? "cancelled" : "failure",
        resolution: { kind: "replacement", roles: ["aggregate-closure"] },
      })),
    },
    packageEquivalence: {
      sourceRole: "source-npm",
      targetRole: "target-npm",
      telegramRole: "target-telegram",
      rules: {
        rootPackageComparison: "fresh-target",
        aiPackageComparison: "fresh-target",
      },
    },
    clawHub: {
      reused: [],
      fresh: [{ name: "@openclaw/demo", role: "target-clawhub" }],
    },
    ledger: {
      adapterSchemaVersion: 2,
      assertions: [{ pointer: "/conclusion", op: "eq", value: "pass" }],
    },
  };
}

function manifestFixture(repo: Fixture, policy: ReturnType<typeof policyFixture>) {
  const delta = validateReleaseDelta(repo.root, policy, repo.targetSha);
  const clawHub = computeTargetClawHubRosterAudit(repo.root, repo.targetSha, VERSION);
  return {
    schemaVersion: 3,
    kind: "openclaw.release-delta-evidence",
    mode: "release-delta-reuse-v3",
    version: VERSION,
    releaseTag: TAG,
    targetRef: RELEASE_REF,
    policy: { path: POLICY_PATH, blobSha: repo.targetSha, sha256: SHA256 },
    sourceSha: repo.sourceSha,
    parentSha: repo.parentSha,
    targetSha: repo.targetSha,
    changedPaths: delta.changedPaths,
    touchedPaths: delta.touchedPaths,
    commitPathAudit: delta.commitPathAudit,
    runtimeTree: delta.runtimeTree,
    trustBundle: {},
    tagState: { state: "exact" },
    packageEvidence: {
      target: { artifact: { id: 3, digest: DIGEST } },
    },
    gateInventory: policy.roles.map(({ id }: { id: string }) => ({
      id,
      conclusion: "success",
    })),
    clawHubAudit: {
      ...clawHub,
      impactedPackageNames: [],
      evidence: [],
    },
    cancelledAggregate: {},
    freshChecks: [],
    releaseNotesLedger: {},
    producer: {},
    conclusion: "success",
  };
}

type WorkflowStep = {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  if?: string;
  name?: string;
  needs?: string[];
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
  uses?: string;
};

type Workflow = {
  jobs: Record<string, WorkflowJob>;
  permissions?: Record<string, string>;
};

function workflowStep(job: WorkflowJob, name: string) {
  const step = job.steps?.find((entry) => entry.name === name);
  if (!step) throw new Error(`missing workflow step ${name}`);
  return step;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("release delta evidence v3", () => {
  it("resolves the source npm artifact SHA alias against the exact source run", async () => {
    const repo = fixtureRepo();
    const policy = parseReleaseDeltaPolicy(policyFixture(repo));
    const sourceRole = policy.roles.find((entry: any) => entry.id === "source-npm");
    const runId = 101;
    const artifactId = 201;
    const artifactName = `openclaw-npm-preflight-${repo.sourceSha}`;
    const manifest = {
      version: 1,
      releaseTag: TAG,
      releaseSha: repo.sourceSha,
      npmDistTag: "beta",
      packageName: "openclaw",
      packageVersion: VERSION,
      tarballName: `openclaw-${VERSION}.tgz`,
      tarballSha256: SHA256,
      dependencyTarballs: [
        {
          packageName: "@openclaw/ai",
          packageVersion: VERSION,
          tarballName: `openclaw-ai-${VERSION}.tgz`,
          tarballSha256: SHA256,
        },
      ],
      dependencyEvidenceDir: "dependency-evidence",
      dependencyEvidenceManifest: "dependency-evidence/dependency-evidence-manifest.json",
    };
    const artifact = {
      id: artifactId,
      name: artifactName,
      digest: DIGEST,
      size_in_bytes: 1024,
      expired: false,
      workflow_run: { id: runId },
    };
    const resolverOptions = {
      policy,
      delta: { changedPaths: [] },
    };
    const deps = {
      repo: "openclaw/openclaw",
      api: async (apiPath: string) => {
        if (apiPath === `repos/openclaw/openclaw/actions/runs/${runId}`) {
          return {
            id: runId,
            status: "completed",
            conclusion: "success",
            run_attempt: 1,
            name: "OpenClaw NPM Release",
            path: ".github/workflows/openclaw-npm-release.yml",
            event: "workflow_dispatch",
            head_branch: RELEASE_REF,
            head_sha: repo.sourceSha,
            html_url: `https://github.com/openclaw/openclaw/actions/runs/${runId}`,
          };
        }
        if (apiPath.startsWith(`repos/openclaw/openclaw/actions/runs/${runId}/jobs?`)) {
          return {
            jobs: [
              {
                id: 301,
                name: "preflight_openclaw_npm",
                status: "completed",
                conclusion: "success",
                html_url: `https://github.com/openclaw/openclaw/actions/jobs/301`,
              },
            ],
          };
        }
        if (apiPath.startsWith(`repos/openclaw/openclaw/actions/runs/${runId}/artifacts?`)) {
          return { artifacts: [artifact] };
        }
        throw new Error(`unexpected API path ${apiPath}`);
      },
      artifactBytes: async (_artifact: unknown, filePath: string) =>
        Buffer.from(
          filePath === "preflight-manifest.json"
            ? `${JSON.stringify(manifest)}\n`
            : `fixture:${filePath}\n`,
        ),
      artifactEntries: async () =>
        sourceRole.artifacts[0].files.map((file: { path: string }) => file.path),
      jobLog: async () => "",
      verifyArtifact: async () => undefined,
    };
    const runs = { sourceRuns: [runId] };
    const context = {
      baselineSha: repo.baselineSha,
      sourceSha: repo.sourceSha,
      parentSha: repo.parentSha,
      targetSha: repo.targetSha,
      version: VERSION,
      tag: TAG,
    };
    const resolver = createReleaseDeltaResolver(resolverOptions, deps, runs);
    const evidence = await resolver.resolveRole(sourceRole, context);

    expect(evidence.artifacts).toHaveLength(1);
    expect(evidence.artifacts[0].name).toBe(artifactName);
    expect(evidence.binding).toEqual({ type: "run-head", expectedSha: repo.sourceSha });

    artifact.name = `openclaw-npm-preflight-${repo.targetSha}`;
    const targetSubstituted = createReleaseDeltaResolver(resolverOptions, deps, runs);
    await expect(targetSubstituted.resolveRole(sourceRole, context)).rejects.toThrow(
      "artifact npm-preflight is not unique",
    );
  });

  it("derives a linear target chain and records the terminal parent at runtime", () => {
    const repo = fixtureRepo();
    const policy = parseReleaseDeltaPolicy(policyFixture(repo));
    const delta = validateReleaseDelta(repo.root, policy, repo.targetSha);

    expect(delta).toMatchObject({
      sourceSha: repo.sourceSha,
      parentSha: repo.parentSha,
      targetSha: repo.targetSha,
      changedPaths: [".github/workflows/install-smoke.yml", "CHANGELOG.md", "src/runtime.ts"],
      runtimeTree: { equivalent: false },
    });
    expect(delta.commitPathAudit.map((entry: { sha: string }) => entry.sha)).toEqual([
      repo.runtimeSha,
      repo.parentSha,
      repo.targetSha,
    ]);
    expect(delta.commitPathAudit.at(-1)?.changedPaths).toEqual(["CHANGELOG.md"]);
    expect(policy.git).not.toHaveProperty("finalTargetParentSha");
    expect(policy.git).not.toHaveProperty("requiredCommits");
    expect(policy.git).not.toHaveProperty("changedPaths");
  });

  it("rejects unallowed, unproven, reused-impact, and impure terminal paths", () => {
    const repo = fixtureRepo();
    const policy = parseReleaseDeltaPolicy(policyFixture(repo));

    const unallowed = structuredClone(policy);
    unallowed.git.allowedPathPatterns = [
      "^\\.github/workflows/install-smoke\\.yml$",
      "^CHANGELOG\\.md$",
    ];
    expect(() => validateReleaseDelta(repo.root, unallowed, repo.targetSha)).toThrow(
      "changed path is not allowed by policy: src/runtime.ts",
    );

    const noFresh = structuredClone(policy);
    noFresh.roles.find((entry: any) => entry.id === "target-npm").impactPatterns = [
      "^\\.github/workflows/install-smoke\\.yml$",
    ];
    expect(() => validateReleaseDelta(repo.root, noFresh, repo.targetSha)).toThrow(
      "changed path has no fresh evidence role: src/runtime.ts",
    );

    const reusedImpact = structuredClone(policy);
    reusedImpact.roles
      .find((entry: any) => entry.id === "source-npm")
      .impactPatterns.push("^src/runtime\\.ts$");
    expect(() => validateReleaseDelta(repo.root, reusedImpact, repo.targetSha)).toThrow(
      "changed path matches a reused evidence role: src/runtime.ts",
    );

    write(repo.root, "src/runtime.ts", "export const value = 3;\n");
    write(repo.root, "CHANGELOG.md", "# Changelog\n\n## 2026.7.1\n\n- Tampered.\n");
    git(repo.root, ["add", "src/runtime.ts", "CHANGELOG.md"]);
    git(repo.root, ["commit", "-m", "docs: impure terminal"]);
    const impureTarget = git(repo.root, ["rev-parse", "HEAD"]);
    expect(() => validateReleaseDelta(repo.root, policy, impureTarget)).toThrow(
      "final target commit is not CHANGELOG-only",
    );
  });

  it("parses ID-free policy inputs and enforces mode and no-chaining contracts", () => {
    const repo = fixtureRepo();
    const policy = policyFixture(repo);
    expect(parseReleaseDeltaPolicy(policy)).toEqual(policy);
    expect(
      parseEvidenceRuns(
        {
          sourceRuns: 1,
          targetRuns: [2],
          telegramRuns: 3,
          clawhubRuns: 4,
          closureRuns: 5,
          aggregateRuns: 6,
        },
        policy,
      ),
    ).toEqual({
      sourceRuns: [1],
      targetRuns: [2],
      telegramRuns: [3],
      clawhubRuns: [4],
      closureRuns: [5],
      aggregateRuns: [6],
    });

    const unguarded = structuredClone(policy);
    unguarded.roles[0].impactPatterns = [];
    expect(() => parseReleaseDeltaPolicy(unguarded)).toThrow(
      "impactPatterns must guard reused evidence",
    );

    const wrongFreshBinding = structuredClone(policy);
    wrongFreshBinding.roles[1].binding.expected = "source";
    expect(() => parseReleaseDeltaPolicy(wrongFreshBinding)).toThrow(
      "binding.expected is incompatible with fresh evidence",
    );

    const wrongReusedBinding = structuredClone(policy);
    wrongReusedBinding.roles[0].binding.expected = "target";
    expect(() => parseReleaseDeltaPolicy(wrongReusedBinding)).toThrow(
      "binding.expected is incompatible with reused evidence",
    );

    const chained = structuredClone(policy);
    chained.roles[1].workflow = ".github/workflows/release-delta-evidence.yml";
    expect(() => parseReleaseDeltaPolicy(chained)).toThrow("must not chain release delta evidence");

    const missingProducerJob = structuredClone(policy);
    missingProducerJob.roles[1].input = "producer";
    expect(() => parseReleaseDeltaPolicy(missingProducerJob)).toThrow("producerJob is invalid");

    const producerRole = structuredClone(policy);
    producerRole.roles.push(producerToolingRole());
    expect(parseReleaseDeltaPolicy(producerRole).roles.at(-1).producerJob).toBe("target-tooling");

    const duplicateProducerJob = structuredClone(producerRole);
    duplicateProducerJob.roles.push(producerToolingRole("producer-tooling-copy"));
    expect(() => parseReleaseDeltaPolicy(duplicateProducerJob)).toThrow("duplicate producer jobs");

    const crossWiredProducer = structuredClone(producerRole);
    crossWiredProducer.roles.at(-1).job.name = "Target release container";
    expect(() => parseReleaseDeltaPolicy(crossWiredProducer)).toThrow(
      "producer provenance differs from target-tooling",
    );

    const strayProducerJob = structuredClone(policy);
    strayProducerJob.roles[0].producerJob = "target-container";
    expect(() => parseReleaseDeltaPolicy(strayProducerJob)).toThrow("producerJob is invalid");

    const numericIdentity = structuredClone(policy);
    numericIdentity.roles[0].run.runId = 123;
    expect(() => parseReleaseDeltaPolicy(numericIdentity)).toThrow("contains unsupported fields");

    const duplicatePackageRoles = structuredClone(policy);
    duplicatePackageRoles.packageEquivalence.targetRole =
      duplicatePackageRoles.packageEquivalence.sourceRole;
    expect(() => parseReleaseDeltaPolicy(duplicatePackageRoles)).toThrow("three distinct roles");

    const sharedPackageInput = structuredClone(policy);
    sharedPackageInput.roles.find((entry: any) => entry.id === "target-npm").input = "sourceRuns";
    sharedPackageInput.roles.find((entry: any) => entry.id === "aggregate-closure").input =
      "targetRuns";
    delete sharedPackageInput.inputs.closureRuns;
    expect(() => parseReleaseDeltaPolicy(sharedPackageInput)).toThrow(
      "distinct single-run input pools",
    );

    const sourceArtifactBinding = structuredClone(policy);
    sourceArtifactBinding.roles.find((entry: any) => entry.id === "source-npm").binding = {
      type: "artifact-json",
      artifactKey: "npm-preflight",
      path: "preflight-manifest.json",
      pointer: "/releaseSha",
      expected: "source",
    };
    expect(() => parseReleaseDeltaPolicy(sourceArtifactBinding)).toThrow(
      "source npm role contract differs",
    );

    const crossWiredPackageRole = structuredClone(policy);
    const crossWiredTarget = crossWiredPackageRole.roles.find(
      (entry: any) => entry.id === "target-npm",
    );
    const crossWiredTelegram = crossWiredPackageRole.roles.find(
      (entry: any) => entry.id === "target-telegram",
    );
    for (const key of ["workflow", "run", "job", "artifacts", "reports", "binding"]) {
      crossWiredTarget[key] = structuredClone(crossWiredTelegram[key]);
    }
    expect(() => parseReleaseDeltaPolicy(crossWiredPackageRole)).toThrow(
      "target npm role contract differs",
    );

    const overlap = structuredClone(policy);
    overlap.roles.push(clawHubRole({ id: "source-clawhub", mode: "reused" }));
    overlap.clawHub.reused.push({ name: "@openclaw/demo", role: "source-clawhub" });
    expect(() => parseReleaseDeltaPolicy(overlap)).toThrow("package roster overlaps");

    const productMetadata = structuredClone(policy);
    productMetadata.git.metadataPaths.push(".github/workflows/install-smoke.yml");
    expect(() => parseReleaseDeltaPolicy(productMetadata)).toThrow(
      "metadataPaths contains a product, workflow, or tooling path",
    );

    const crossPackageClawHub = structuredClone(policy);
    crossPackageClawHub.clawHub.fresh.push({
      name: "@openclaw/other",
      role: "target-clawhub",
    });
    expect(() => parseReleaseDeltaPolicy(crossPackageClawHub)).toThrow(
      "role artifact contract is invalid",
    );

    const publishDocument = {
      source: "openclaw/openclaw",
      name: "@openclaw/demo",
      displayName: "Demo",
      family: "code-plugin",
      version: VERSION,
      commit: repo.targetSha,
      files: 4,
      totalBytes: 1024,
    };
    expect(
      validateClawHubPublishDocument(publishDocument, {
        packageName: "@openclaw/demo",
        version: VERSION,
        commit: repo.targetSha,
      }),
    ).toBe(publishDocument);
    expect(() =>
      validateClawHubPublishDocument(
        { ...publishDocument, releaseId: "must-not-exist" },
        {
          packageName: "@openclaw/demo",
          version: VERSION,
          commit: repo.targetSha,
        },
      ),
    ).toThrow("contains unsupported fields");
    expect(() =>
      validateClawHubPublishDocument(publishDocument, {
        packageName: "@openclaw/other",
        version: VERSION,
        commit: repo.targetSha,
      }),
    ).toThrow("identity differs");
  });

  it("validates the exact cancelled aggregate job-name set and rejects delta chaining", () => {
    const names = ["source-binding", "successful-gate"];
    const expected = { count: names.length, namesSha256: hashJobNames(names) };
    expect(
      validateSuccessfulJobSet(
        names.map((name) => ({ name })),
        expected,
      ),
    ).toEqual(expected);
    expect(() =>
      validateSuccessfulJobSet(
        names.map((name) => ({ name })),
        {
          ...expected,
          count: expected.count + 1,
        },
      ),
    ).toThrow("successful job set differs");
    expect(() =>
      validateSuccessfulJobSet(
        names.map((name) => ({ name })),
        {
          ...expected,
          namesSha256: SHA256,
        },
      ),
    ).toThrow("successful job set differs");

    const duplicateNames = ["source-binding", "duplicate-gate", "duplicate-gate"];
    const duplicateExpected = {
      count: duplicateNames.length,
      namesSha256: hashJobNames(duplicateNames),
    };
    expect(
      validateSuccessfulJobSet(
        duplicateNames.map((name) => ({ name })),
        duplicateExpected,
      ),
    ).toEqual(duplicateExpected);
    expect(() =>
      validateSuccessfulJobSet(
        duplicateNames.slice(0, -1).map((name) => ({ name })),
        duplicateExpected,
      ),
    ).toThrow("successful job set differs");
    expect(() =>
      validateSuccessfulJobSet(
        [...duplicateNames, "duplicate-gate"].map((name) => ({ name })),
        duplicateExpected,
      ),
    ).toThrow("successful job set differs");

    const completed = [
      { name: "source-binding", conclusion: "success" },
      { name: "skipped-gate", conclusion: "skipped" },
      { name: "failed-gate", conclusion: "failure" },
    ];
    const completedExpected = {
      count: completed.length,
      namesAndConclusionsSha256: hashCompletedJobs(completed),
    };
    expect(validateCompletedJobSet(completed, completedExpected)).toEqual(completedExpected);
    expect(() =>
      validateCompletedJobSet(
        completed.map((job, index) => (index === 1 ? { ...job, conclusion: "neutral" } : job)),
        completedExpected,
      ),
    ).toThrow("completed job set contains an invalid identity");

    expect(
      selectSuccessfulJobByName(
        [{ id: 1, name: "proof", status: "completed", conclusion: "success" }],
        "proof",
      ).id,
    ).toBe(1);
    for (const conclusion of ["failure", "skipped"]) {
      expect(() =>
        selectSuccessfulJobByName(
          [{ id: 1, name: "proof", status: "completed", conclusion }],
          "proof",
          "log assertion",
        ),
      ).toThrow("successful job is not unique");
    }

    expect(() =>
      validateNoChainedReleaseDeltaEvidence({
        kind: "openclaw.release-delta-evidence",
      }),
    ).toThrow("must not consume release delta evidence");
  });

  it("validates manifest roots, target-derived roster hash, and promotable artifact identity", () => {
    const repo = fixtureRepo();
    const policy = parseReleaseDeltaPolicy(policyFixture(repo));
    const manifest = manifestFixture(repo, policy);
    expect(
      validateReleaseDeltaManifest(manifest, policy, {
        releaseTag: TAG,
        targetSha: repo.targetSha,
      }),
    ).toBe(manifest);
    expect(() => validateReleaseDeltaManifest({ ...manifest, unexpected: true }, policy)).toThrow(
      "manifest contains unsupported fields",
    );
    expect(() =>
      validateReleaseDeltaManifest(
        {
          ...manifest,
          clawHubAudit: { ...manifest.clawHubAudit, manifestSha256: SHA256 },
        },
        policy,
      ),
    ).toThrow("manifest ClawHub audit differs");
    expect(() =>
      validateReleaseDeltaManifest(
        {
          ...manifest,
          packageEvidence: { target: { artifact: { id: 0, digest: DIGEST } } },
        },
        policy,
      ),
    ).toThrow("manifest lacks promotable npm artifact");
  });

  it("requires policy only for create and auto-resolves it for verify", () => {
    const common = ["--repo", "openclaw/openclaw", "--target-sha", "f".repeat(40)];
    expect(
      parseReleaseDeltaArgs([
        "verify",
        ...common,
        "--tag",
        TAG,
        "--npm-preflight-run",
        "1",
        "--run-id",
        "2",
      ]),
    ).toMatchObject({ command: "verify", npmPreflightRun: "1", runId: "2" });
    expect(() =>
      parseReleaseDeltaArgs([
        "verify",
        ...common,
        "--policy",
        POLICY_PATH,
        "--tag",
        TAG,
        "--npm-preflight-run",
        "1",
        "--run-id",
        "2",
      ]),
    ).toThrow("Unknown option '--policy'");
    expect(() =>
      parseReleaseDeltaArgs([
        "create",
        ...common,
        "--target-ref",
        RELEASE_REF,
        "--evidence-runs",
        "runs.json",
        "--release-notes-verification",
        "ledger.json",
        "--workflow-sha",
        "e".repeat(40),
        "--output",
        "manifest.json",
      ]),
    ).toThrow("--policy is required");
  });

  it("rejects undeclared, duplicate, and unsafe artifact members", () => {
    expect(
      validateArtifactInventory(
        ["reports/", "reports/result.json"],
        ["reports/result.json"],
        "proof",
      ),
    ).toEqual(["reports/result.json"]);
    expect(() =>
      validateArtifactInventory(
        ["reports/result.json", "reports/extra.json"],
        ["reports/result.json"],
        "proof",
      ),
    ).toThrow("inventory differs from its file contract");
    expect(() =>
      validateArtifactInventory(
        ["reports/result.json", "reports/result.json"],
        ["reports/result.json"],
        "proof",
      ),
    ).toThrow("duplicate entries");
    expect(() =>
      validateArtifactInventory(["../result.json"], ["reports/result.json"], "proof"),
    ).toThrow("unsafe entry");
  });

  it("keeps the trusted-main producer generic, no-push, and terminal", () => {
    const source = readFileSync(".github/workflows/release-delta-evidence.yml", "utf8");
    const workflow = parse(source) as Workflow;
    expect(workflow.permissions).toEqual({ actions: "read", contents: "read" });
    expect(JSON.stringify(workflow)).not.toContain('"id-token":"write"');
    expect(JSON.stringify(workflow)).not.toContain('"packages":"write"');
    expect(source).toContain("policy_path:");
    expect(source).toContain('--policy "$POLICY_PATH"');
    expect(source).not.toContain("2026.7.1");
    expect(source).not.toContain("v2026.6.11");

    expect(workflow.jobs.target_tooling.name).toBe("Target release tooling");
    expect(workflow.jobs.target_container.name).toBe("Target release container");
    expect(workflow.jobs.target_provider_preflight.name).toBe("Target provider secret preflight");
    expect(workflow.jobs.target_tooling.if).toBe(
      "needs.validate.outputs.run_target_tooling == 'true'",
    );
    expect(workflow.jobs.target_container.if).toBe(
      "needs.validate.outputs.run_target_container == 'true'",
    );
    expect(workflow.jobs.target_provider_preflight.if).toBe(
      "needs.validate.outputs.run_target_provider_preflight == 'true'",
    );
    expect(workflow.jobs.focused_openwebui.if).toBe(
      "needs.validate.outputs.run_focused_openwebui == 'true'",
    );
    expect(workflow.jobs.focused_openwebui.permissions).toEqual({
      actions: "read",
      contents: "read",
      "pull-requests": "read",
    });
    expect(workflow.jobs.focused_openwebui.permissions).not.toHaveProperty("packages");
    expect(workflow.jobs.focused_openwebui.uses).toBe("./.github/workflows/package-acceptance.yml");
    expect(workflow.jobs.create.needs).toEqual([
      "validate",
      "target_tooling",
      "target_container",
      "target_provider_preflight",
      "focused_openwebui",
    ]);
    expect(workflow.jobs.create.if).toContain("always()");
    for (const job of [
      "target_tooling",
      "target_container",
      "target_provider_preflight",
      "focused_openwebui",
    ]) {
      expect(workflow.jobs.create.if).toContain(`needs.${job}.result == 'success'`);
      expect(workflow.jobs.create.if).toContain(`needs.${job}.result == 'skipped'`);
    }

    const container = workflowStep(
      workflow.jobs.target_container,
      "Build and hash release container without pushing",
    ).run;
    expect(container).toContain("type=oci");
    expect(container).toContain("sha256sum");
    expect(container).not.toContain("--push");

    const upload = workflowStep(workflow.jobs.create, "Upload immutable delta evidence");
    expect(upload.with).toMatchObject({
      name: "release-delta-evidence-${{ github.run_id }}-${{ github.run_attempt }}",
      path: "${{ runner.temp }}/release-delta-evidence.json",
      "if-no-files-found": "error",
    });
  });

  it("auto-resolves policy in the publish consumer and rejects extra ZIP entries", () => {
    const workflow = readFileSync(".github/workflows/openclaw-release-publish.yml", "utf8");
    expect(workflow).toContain("release-delta-evidence.mjs verify");
    expect(workflow).not.toContain("--policy .release-delta-tooling/");
    expect(workflow).toContain("${{ fromJSON(toJSON(job)).workflow_sha }}");
    expect(workflow).toContain('mapfile -t archive_entries < <(unzip -Z1 "$archive")');
    expect(workflow).not.toContain('unzip -Z1 "$archive" | sed');
  });
});
