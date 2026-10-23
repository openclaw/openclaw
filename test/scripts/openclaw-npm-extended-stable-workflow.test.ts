import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const workflowPath = ".github/workflows/openclaw-npm-release.yml";
const publisherRef = "refs/tags/release-publish/bbbbbbbbbbbb-123";
const preflightWorkflowPath = ".github/workflows/openclaw-npm-preflight.yml";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type Step = {
  env?: Record<string, string>;
  name?: string;
  run?: string;
  with?: Record<string, string>;
};
type Job = {
  steps?: Step[];
  uses?: string;
  with?: Record<string, unknown>;
};
type AdmissionOptions = {
  candidate?: string;
  npmDistTag?: string;
  tag?: string;
  remoteSha?: string;
};
type Workflow = {
  on?: {
    workflow_dispatch?: {
      inputs?: Record<
        string,
        { default?: string | boolean; description?: string; required?: boolean; type?: string }
      >;
    };
  };
  jobs?: Record<string, Job>;
};

const workflow = (path = workflowPath) => parse(readFileSync(path, "utf8")) as Workflow;

const release = workflow();
const preflight = workflow(preflightWorkflowPath);
const publishJob = release.jobs?.publish_openclaw_npm;
const sourceStep = (name: string) => step(preflight.jobs?.check_openclaw_npm, name);
const publishingStep = (name: string) => step(publishJob, name);

function step(job: Job | undefined, name: string): Step {
  const found = job?.steps?.find((item) => item.name === name);
  return expectDefined(found, name);
}

function expectText(source: string | undefined, included: string[], excluded: string[] = []) {
  included.forEach((text) => expect(source).toContain(text));
  excluded.forEach((text) => expect(source).not.toContain(text));
}
const inputRef = (name: string) => `\${{ inputs.${name} }}`;

function runPluginCompatibilityGate(options: { hasScript: boolean; relationship: string }) {
  const root = tempDirs.make("openclaw-npm-plugin-compat-");
  const binDir = join(root, "bin");
  const invocationPath = join(root, "pnpm-invocation.txt");
  const apiPath = join(root, "gh-invocation.txt");
  mkdirSync(binDir);
  const scripts = options.hasScript ? { "plugins:boundary-report:ci": "node check.mjs" } : {};
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts }));
  for (const [name, script] of [
    ["git", `printf '%040d\\n' 0\n`],
    ["gh", `printf '%s\\n' "$*" > ${JSON.stringify(apiPath)}\nprintf '%s\\n' "$RELATIONSHIP"\n`],
    ["pnpm", `printf '%s\\n' "$*" > ${JSON.stringify(invocationPath)}\n`],
  ] as const) {
    writeFileSync(join(binDir, name), `#!/usr/bin/env bash\n${script}`, { mode: 0o755 });
  }
  const gate = sourceStep("Enforce plugin compatibility release readiness");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-c", gate.run ?? ""], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_REPOSITORY: "openclaw/openclaw",
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      RELATIONSHIP: options.relationship,
    },
  });
  const invocation = existsSync(invocationPath)
    ? readFileSync(invocationPath, "utf8").trim()
    : null;
  const apiInvocation = existsSync(apiPath) ? readFileSync(apiPath, "utf8").trim() : null;
  return { apiInvocation, invocation, result };
}

it.each([
  { RELEASE_TAG: "v2026.9.1-alpha.1", RELEASE_NPM_DIST_TAG: "alpha" },
  { RELEASE_NPM_DIST_TAG: "alpha" },
  { GITHUB_REF: "refs/heads/tideclaw/alpha/2026-09-25-1200Z" },
])("rejects retired alpha at npm publication and preflight boundaries: %j", (overrides) => {
  for (const [path, job, name] of [
    [workflowPath, "publish_openclaw_npm", "Validate tag input format"],
    [preflightWorkflowPath, "check_openclaw_npm", "Validate release ref input format"],
  ] as const) {
    const env = {
      ...process.env,
      RELEASE_TAG: "v2026.9.1",
      RELEASE_NPM_DIST_TAG: "latest",
      PREFLIGHT_ONLY: "true",
      ...overrides,
    };
    const result = spawnSync("bash", ["-c", step(workflow(path).jobs?.[job], name).run ?? ""], {
      encoding: "utf8",
      env: { ...env, RELEASE_REF: env.RELEASE_TAG },
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("Alpha releases are retired;");
  }
});

it("rejects a SHA-resolved alpha package before npm source preflight", () => {
  const root = tempDirs.make("npm-alpha-source-");
  const scripts = join(root, ".release-harness", "scripts");
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "2026.9.1-alpha.1" }));
  writeFileSync(join(scripts, "package-source-preflight.mjs"), "process.exit(0);\n");
  const run = sourceStep("Validate npm package source metadata").run;
  const result = spawnSync("bash", ["-c", run ?? ""], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GITHUB_WORKSPACE: root, RELEASE_REF: "a".repeat(40) },
  });
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain("Alpha releases are retired;");
});

it("bounds every git fetch operation", () => {
  const source = [workflowPath, preflightWorkflowPath]
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
  const gitFetchLines = source
    .split("\n")
    .filter((line) => /\bgit(?: -C (?:"[^"]+"|\S+))? fetch\b/u.test(line));
  expect(gitFetchLines.length).toBeGreaterThan(0);
  expect(
    gitFetchLines.every((line) => line.includes("timeout --signal=TERM --kill-after=10s 120s")),
  ).toBe(true);
});

it("routes source history through the trusted ancestry owner", () => {
  const sourceAncestry = sourceStep("Establish source ancestry with main");
  const sourceCheck = sourceStep("Check source, test types, and architecture");
  const pluginCompatibility = sourceStep("Enforce plugin compatibility release readiness");
  const trustedCheckout = sourceStep("Checkout trusted package source preflight");
  const metadata = step(preflight.jobs?.check_dependencies_npm, "Validate release metadata").run;

  expect(trustedCheckout.with?.["sparse-checkout"]).toContain(".github/actions/git-owner");
  expect(sourceAncestry.env).toMatchObject({
    RELEASE_ANCESTRY_MODE: "merge-base",
    RELEASE_ANCESTRY_SOURCE_REF:
      "${{ inputs.release_candidate_branch != '' && format('refs/heads/{0}', inputs.release_candidate_branch) || '' }}",
    RELEASE_ANCESTRY_TARGET_REF: "refs/heads/main",
  });
  expect(sourceAncestry.env).not.toHaveProperty("RELEASE_ANCESTRY_TOTAL_SECONDS");
  expectText(sourceAncestry.run, [
    "python3 -I -S .release-harness/.github/actions/git-owner/owner.py",
    "--policy .release-harness/.github/actions/git-owner/release-ancestry.py",
  ]);
  expectText(sourceCheck.run, [
    'mv .release-harness "$harness_root"',
    "trap restore_harness EXIT",
    "pnpm check --include-test-types --include-architecture",
    'mv "$harness_root" .release-harness',
  ]);
  expectText(pluginCompatibility.run, [
    '.scripts["plugins:boundary-report:ci"]',
    "38ba27834dd3f98c19d5833e0598dfef3abb7587",
    "Target is not proven to predate",
    "Frozen target predates",
    "pnpm plugins:boundary-report:ci",
  ]);
  expectText(metadata, ["--unshallow origin", '"+refs/tags/v*:refs/tags/v*"']);
  const sourceSteps = preflight.jobs?.check_openclaw_npm?.steps ?? [];
  expect(sourceSteps.indexOf(trustedCheckout)).toBeLessThan(sourceSteps.indexOf(sourceAncestry));
  expect(sourceSteps.indexOf(sourceAncestry)).toBeLessThan(sourceSteps.indexOf(sourceCheck));
  expect(sourceSteps.indexOf(sourceCheck)).toBeLessThan(sourceSteps.indexOf(pluginCompatibility));
});

it("checks release-tool locks from the trusted tooling checkout", () => {
  const job = preflight.jobs?.check_dependencies_npm;
  const checkout = step(job, "Checkout trusted Plugin SDK API tooling");
  const evidence = step(job, "Generate dependency release evidence");

  expect(checkout.with?.ref).toBe("${{ github.workflow_sha }}");
  expect(checkout.with?.["sparse-checkout"]?.split(/\s+/u)).toContain(".github/release");
  expectText(evidence.run, [
    '"$tooling_dir/scripts/generate-dependency-release-evidence.mts"',
    '--root "$GITHUB_WORKSPACE"',
  ]);
});

it.each([
  [true, "ahead", 0, "plugins:boundary-report:ci"],
  [false, "behind", 0, null],
  [false, "ahead", 1, null],
  [false, "diverged", 1, null],
] as const)(
  "enforces plugin compatibility: script=%s ancestry=%s",
  (hasScript, relationship, status, invocation) => {
    const run = runPluginCompatibilityGate({ hasScript, relationship });
    expect(run.result.status, run.result.stderr).toBe(status);
    expect(run.invocation).toBe(invocation);
    expect(run.apiInvocation !== null).toBe(!hasScript);
    if (relationship === "behind") {
      expect(run.result.stdout).toContain("Frozen target predates");
    }
    if (status === 1) {
      expect(run.result.stderr).toContain("not proven to predate");
    }
  },
);

it("allows an explicit default-off GitHub-hosted preflight runner", () => {
  expect(release.on?.workflow_dispatch?.inputs?.use_github_hosted_runners).toEqual({
    default: false,
    description: "Use GitHub-hosted Ubuntu for npm preflight",
    required: false,
    type: "boolean",
  });
  expect(release.jobs?.preflight_openclaw_npm).toMatchObject({
    uses: `./${preflightWorkflowPath}`,
    with: { use_github_hosted_runners: inputRef("use_github_hosted_runners") },
  });
});

it("binds intentional Plugin SDK release changes to the reported digest", () => {
  const input = release.on?.workflow_dispatch?.inputs?.plugin_sdk_api_acknowledgement;
  const qualification = preflight.jobs?.check_sdk_npm;
  const preflightDiff = step(qualification, "Verify Plugin SDK API changes");
  const publishProvenance = publishingStep("Verify prepared tarball provenance");
  const downloadPreflight = publishingStep("Download prepared npm tarball");
  const verifyPreflightRun = publishingStep("Verify preflight run metadata");
  const trustedToolingCheckout = step(qualification, "Checkout trusted Plugin SDK API tooling");
  const publishProvenanceRun = expectDefined(publishProvenance.run, "tarball provenance script");
  const mismatch = "Prepared Plugin SDK API evidence does not match its immutable artifact";
  const registryRead = 'npm view "openclaw@${RELEASE_NPM_DIST_TAG}" version';

  expect(input).toEqual({
    default: "",
    description:
      "8-character digest from the Plugin SDK API diff report when the release changes the SDK",
    required: false,
    type: "string",
  });
  expect(preflightDiff.env?.PLUGIN_SDK_API_ACKNOWLEDGEMENT).toBeUndefined();
  expect(publishProvenance.env?.PLUGIN_SDK_API_ACKNOWLEDGEMENT).toBe(
    inputRef("plugin_sdk_api_acknowledgement"),
  );
  expect(trustedToolingCheckout.with?.ref).toBe("${{ github.workflow_sha }}");
  // Corepack resolves packageManager from its working directory before pnpm
  // receives command flags. The trusted tooling checkout must own both calls.
  expectText(
    preflightDiff.run,
    [
      "['view', 'openclaw', 'dist-tags', '--json']",
      "resolveNpmPreflightSdkSelectors",
      '--bases-json "$bases_json"',
      '--evidence "${GITHUB_WORKSPACE}/.artifacts/npm-sdk-proof/plugin-sdk-api-release-evidence.json"',
      'git -C "$tooling_dir" status --porcelain',
      'cd "$tooling_dir"',
      "pnpm install --frozen-lockfile --ignore-scripts --filter openclaw",
      'pnpm run plugin-sdk:api:diff -- "${diff_args[@]}"',
    ],
    [
      "--require-acknowledgement",
      "--acknowledge",
      'pkg.scripts?.["plugin-sdk:api:diff"]',
      'pnpm --dir "$tooling_dir"',
    ],
  );
  expectText(
    publishProvenanceRun,
    [
      "plugin-sdk-api-release-evidence.mjs",
      '--acknowledge "$PLUGIN_SDK_API_ACKNOWLEDGEMENT"',
      '--npm-dist-tag "$RELEASE_NPM_DIST_TAG"',
      registryRead,
      mismatch,
      'git -C trusted-workflow rev-parse --verify "refs/tags/${current_selector_ref}^{commit}"',
      '--current-selector-ref "$current_selector_ref"',
      '--current-selector-sha "$current_selector_sha"',
      '--workflow-sha "$PREFLIGHT_WORKFLOW_SHA"',
    ],
    ["git fetch"],
  );
  expect(downloadPreflight.run).toContain(
    '"plugin-sdk-api-release-diff-${PREFLIGHT_RUN_ID}-${PREFLIGHT_RUN_ATTEMPT}"',
  );
  expect(publishProvenanceRun.indexOf(mismatch)).toBeLessThan(
    publishProvenanceRun.indexOf(registryRead),
  );
  expect(verifyPreflightRun.run).toContain(
    '"$preflight_head_branch" == "$EXPECTED_EXTENDED_STABLE_BRANCH"',
  );
  expect(verifyPreflightRun.run).toContain('"$extended_stable_preflight" != "true"');
  expect(readFileSync("scripts/npm-prepared-bundle.mjs", "utf8")).toContain("pluginSdkApi,");
});

it("threads an explicit, default-off extended-stable bypass through every policy gate", () => {
  const input = release.on?.workflow_dispatch?.inputs?.bypass_extended_stable_guard;
  expect(input).toMatchObject({ default: false, type: "boolean" });

  const policySteps = [
    sourceStep("Validate npm release request"),
    step(preflight.jobs?.prepare_openclaw_npm, "Validate npm release request"),
    step(release.jobs?.validate_publish_request, "Validate npm release request"),
    publishingStep("Recheck npm release request"),
    publishingStep("Publish"),
  ];
  for (const policyStep of policySteps) {
    expect(policyStep.env?.BYPASS_EXTENDED_STABLE_GUARD).toBe(
      inputRef("bypass_extended_stable_guard"),
    );
  }
  const trustedRef = step(
    release.jobs?.validate_publish_request,
    "Require trusted workflow ref for publish",
  );
  expect(trustedRef.env?.BYPASS_EXTENDED_STABLE_GUARD).toBeUndefined();
  expect(trustedRef.run).not.toContain("BYPASS_EXTENDED_STABLE_GUARD");
});

it.each<[string, string, AdmissionOptions, number]>([
  ["main recovery", "refs/heads/main", {}, 1],
  ["protected publisher", publisherRef, {}, 0],
  ["feature branch", "refs/heads/feature/recovery", {}, 1],
  ["release branch with candidate override", "refs/heads/release/2026.8.1", {}, 1],
  ["Tideclaw branch", "refs/heads/tideclaw/alpha/2026-09-25-1200Z", {}, 1],
  ["extended-stable branch", "refs/heads/extended-stable/2026.8.33", {}, 1],
  ["ordinary tag", "refs/tags/v2026.8.34", {}, 1],
  ["wrong candidate month", publisherRef, { candidate: "extended-stable/2026.7.33" }, 1],
  ["noncanonical candidate branch", publisherRef, { candidate: "extended-stable/2026.8.34" }, 1],
  ["latest selector", publisherRef, { npmDistTag: "latest" }, 1],
  ["beta selector", publisherRef, { npmDistTag: "beta" }, 1],
  ["correction suffix", publisherRef, { tag: "v2026.8.34-1" }, 1],
  ["non-tag candidate", publisherRef, { tag: "a".repeat(40) }, 1],
  ["wrong protected SHA prefix", "refs/tags/release-publish/aaaaaaaaaaaa-123", {}, 1],
  ["moved protected tag", publisherRef, { remoteSha: "c".repeat(40) }, 1],
])(
  "checks the actual publication admission shell for %s",
  (_label, workflowRef, { candidate, npmDistTag, tag, remoteSha }, status) => {
    const guard = step(
      release.jobs?.validate_publish_request,
      "Require trusted workflow ref for publish",
    );
    const result = spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        `gh() { printf '%s\\n' "$REMOTE_WORKFLOW_SHA"; }\n${guard.run}`,
      ],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          GITHUB_REPOSITORY: "openclaw/openclaw",
          RELEASE_TAG: tag ?? "v2026.8.34",
          RELEASE_NPM_DIST_TAG: npmDistTag ?? "extended-stable",
          RELEASE_CANDIDATE_BRANCH: candidate ?? "extended-stable/2026.8.33",
          WORKFLOW_REF: workflowRef,
          WORKFLOW_SHA: "b".repeat(40),
          REMOTE_WORKFLOW_SHA: remoteSha ?? "b".repeat(40),
        },
      },
    );
    expect(result.status, result.stderr).toBe(status);
  },
);

it("uses the trusted Full Validation evidence verifier", () => {
  const raw = readFileSync(workflowPath, "utf8");
  expect(raw).toContain(
    "--json databaseId,attempt,workflowName,headBranch,headSha,event,status,conclusion,url",
  );
  const verifier = publishingStep("Checkout trusted validation verifier");
  expect(verifier.with).toMatchObject({
    ref: "${{ github.workflow_sha }}",
    path: "trusted-workflow",
  });

  const fullValidation = publishingStep("Verify full release validation evidence");
  expect(fullValidation.env).toMatchObject({
    EXPECTED_WORKFLOW_BRANCH: "${{ inputs.release_candidate_branch || github.ref_name }}",
    FULL_RELEASE_VALIDATION_RUN_ATTEMPT: inputRef("full_release_validation_run_attempt"),
  });
  expectText(fullValidation.run, [
    "actions/runs/${FULL_RELEASE_VALIDATION_RUN_ID}/attempts/${FULL_RELEASE_VALIDATION_RUN_ATTEMPT}",
    "--filter=blob:none",
    "trusted-workflow/scripts/validate-full-release-validation-evidence.mjs",
  ]);
  expect(raw.match(/openclaw-npm-extended-stable-release\.mjs verify-run/g)).toHaveLength(2);
  expect(raw).not.toContain("openclaw-npm-extended-stable-release.mjs verify-manifest");
});

it("requires and authenticates the plugin npm run before an extended-stable core publish", () => {
  expect(release.on?.workflow_dispatch?.inputs?.plugin_npm_run_id).toMatchObject({
    required: false,
    type: "string",
  });
  const required = step(
    release.jobs?.validate_publish_request,
    "Require preflight artifact promotion on real publish",
  );
  expect(required.env?.PLUGIN_NPM_RUN_ID).toBe(inputRef("plugin_npm_run_id"));
  expect(required.run).toContain("Extended-stable publish requires plugin_npm_run_id");

  const verify = publishingStep("Verify plugin npm release run metadata");
  expect(verify.env).toMatchObject({
    RUN_KIND: "plugin",
    EXPECTED_ORCHESTRATOR_BRANCH:
      "${{ inputs.release_candidate_branch != '' && startsWith(github.ref, 'refs/tags/release-publish/') && github.ref_name || '' }}",
    EXPECTED_ORCHESTRATOR_SHA:
      "${{ inputs.release_candidate_branch != '' && startsWith(github.ref, 'refs/tags/release-publish/') && github.workflow_sha || '' }}",
  });
  expect(verify.run).toContain(
    "node trusted-workflow/scripts/openclaw-npm-extended-stable-release.mjs verify-run",
  );
});

it("publishes only the tarball path verified from the preflight manifest", () => {
  const provenance = publishingStep("Verify prepared tarball provenance");
  const publishStep = publishingStep("Publish");
  expectText(provenance.run, [
    'ARTIFACT_TARBALL_PATH="preflight-tarball/$ARTIFACT_TARBALL_NAME"',
    'has("corePackageTarballs")',
    "CORE_PACKAGE_TARBALL_COUNT=0",
    'echo "tarball_path=$ARTIFACT_TARBALL_PATH"',
  ]);
  expect(publishStep.env).toMatchObject({
    PUBLISH_TARBALL_PATH: "${{ steps.preflight_provenance.outputs.tarball_path }}",
    PREFLIGHT_WORKFLOW_SHA: "${{ steps.preflight_run.outputs.head_sha }}",
    PREFLIGHT_RUN_ID: "${{ steps.preflight_run.outputs.run_id }}",
    PREFLIGHT_RUN_ATTEMPT: "${{ steps.preflight_run.outputs.run_attempt }}",
    FULL_RELEASE_VALIDATION_RUN_ID: inputRef("full_release_validation_run_id"),
    FULL_RELEASE_VALIDATION_RUN_ATTEMPT: inputRef("full_release_validation_run_attempt"),
  });
  expect(publishJob?.steps?.map((candidate) => candidate.name)).not.toContain(
    "Resolve publish tarball",
  );
  expect(readFileSync(workflowPath, "utf8")).not.toContain(
    "find preflight-tarball -type f -name '*.tgz'",
  );
});
