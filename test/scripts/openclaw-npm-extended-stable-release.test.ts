import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  parseExtendedStableGuardBypass,
  resolveNpmPreflightSdkSelectors,
  validateFullReleaseValidationManifest,
  validateNpmPreflightDistTag,
  validateNpmPublishBoundary,
  validateExtendedStableNpmReleaseRequest,
  validateExtendedStableRunIdentity,
} from "../../scripts/openclaw-npm-extended-stable-release.mjs";
import { encodePluginSdkApiArtifact } from "../../scripts/plugin-sdk-api-release-evidence.mjs";

const sha = "a".repeat(40);
const branch = "extended-stable/2026.6.33";

describe("npm preflight publication channels", () => {
  it("allows only qualified regular releases with both SDK receipts to cross beta/latest", () => {
    const receipt = { schema: "openclaw.plugin-sdk-api-release-evidence/v1" };
    const sdk = {
      schema: "openclaw.plugin-sdk-api-release-evidence-set/v1",
      selectors: { beta: receipt, latest: receipt },
    };
    const manifest = {
      version: 3,
      packageVersion: "2026.8.1",
      npmDistTag: "beta",
      pluginSdkApi: sdk,
    };
    const preflight = (changes = {}, npmDistTag = "latest") =>
      validateNpmPreflightDistTag({ manifest: { ...manifest, ...changes }, npmDistTag });
    for (const changed of [
      {},
      { pluginSdkApi: { ...sdk, schema: "openclaw.plugin-sdk-api-release-evidence-set/v2" } },
      { pluginSdkApi: encodePluginSdkApiArtifact(sdk) },
    ]) {
      expect(() => preflight(changed)).not.toThrow();
    }
    for (const changed of [
      { version: 2 },
      { version: 1 },
      { pluginSdkApi: receipt },
      { packageVersion: "2026.8.1-beta.1" },
      { packageVersion: "2026.6.33", npmDistTag: "extended-stable" },
      { pluginSdkApi: { ...sdk, selectors: { beta: receipt } } },
    ]) {
      expect(() => preflight(changed)).toThrow("dist-tag mismatch");
    }
    expect(() => preflight({}, "alpha")).toThrow("Alpha releases are retired;");
    expect(() =>
      validateNpmPreflightDistTag({
        manifest: { version: 1, npmDistTag: "beta" },
        npmDistTag: "beta",
      }),
    ).not.toThrow();

    const command = spawnSync(
      process.execPath,
      ["scripts/openclaw-npm-extended-stable-release.mjs", "verify-preflight-channel"],
      {
        encoding: "utf8",
        input: JSON.stringify(manifest),
        env: { ...process.env, RELEASE_NPM_DIST_TAG: "latest" },
      },
    );
    expect(command.status, command.stderr).toBe(0);
  });
});

describe("npm extended-stable publication boundary", () => {
  it("parses only explicit boolean extended-stable guard values", () => {
    expect(
      [undefined, "", "false", "true"].map((value) => parseExtendedStableGuardBypass(value)),
    ).toEqual([false, false, false, true]);
    expect(() => parseExtendedStableGuardBypass("1")).toThrow(/must be "true" or "false"/u);
  });

  it.each<[string, string, boolean]>([
    ["2026.6.11-beta.1", "beta", true],
    ["2026.6.11-1", "latest", true],
    ["2026.6.11-beta.1", "latest", false],
    ["2026.6.33-1", "latest", false],
    ["2026.6.33", "nightly", false],
  ])("validates %s on %s (accepted=%s)", (version, distTag, accepted) => {
    const publish = () =>
      validateNpmPublishBoundary(version, distTag, { bypassExtendedStableGuard: false });
    if (accepted) {
      expect(publish).not.toThrow();
    } else {
      expect(publish).toThrow();
    }
  });

  it("rejects retired alpha versions in publication and SDK selection", () => {
    for (const validate of [validateNpmPublishBoundary, resolveNpmPreflightSdkSelectors]) {
      expect(() => validate("2026.6.11-alpha.1", "beta")).toThrow("Alpha releases are retired;");
    }
  });
});

describe("extended-stable npm release request", () => {
  const valid = {
    npmDistTag: "extended-stable",
    releaseTag: "v2026.6.33",
    npmWorkflowRef: `refs/heads/${branch}`,
    checkoutSha: sha,
    tagSha: sha,
    extendedStableBranchSha: sha,
    packageVersion: "2026.6.33",
    mainPackageVersion: "2026.7.2",
  };
  const expected = {
    extendedStable: true,
    releaseVersion: "2026.6.33",
    extendedStableBranch: branch,
  };
  const preflight = {
    preflightOnly: true,
    releaseTag: sha,
    npmWorkflowRef: "refs/heads/main",
    extendedStableBranchSha: "",
  };
  type RequestChanges = Partial<typeof valid> & {
    preflightOnly?: boolean;
    bypassExtendedStableGuard?: boolean;
  };
  type Result = Partial<typeof expected> & { bypassExtendedStableGuard?: boolean };
  const retiredLineError = (main: string, allowed: string) =>
    `Extended-stable publishes only the trailing completed month: protected main ${main} allows ${allowed}.PATCH, not 2026.6.33. Retire the older line; publishing a retired line requires an explicit maintainer decision.`;

  it.each<[string, RequestChanges, (Result | string | RegExp)?]>([
    [
      "explicit stale-line bypass",
      { mainPackageVersion: "2027.1.1", bypassExtendedStableGuard: true },
      { ...expected, bypassExtendedStableGuard: true },
    ],
    ["regular SHA preflight", { npmDistTag: "beta", releaseTag: sha }, { extendedStable: false }],
    ["extended-stable SHA preflight", preflight, expected],
    ["patch below 33", { releaseTag: "v2026.6.32", packageVersion: "2026.6.32" }],
    ["beta prerelease", { releaseTag: "v2026.6.33-beta.1", packageVersion: "2026.6.33-beta.1" }],
    ["correction suffix", { releaseTag: "v2026.6.33-1", packageVersion: "2026.6.33-1" }],
    ["wrong branch", { npmWorkflowRef: "refs/heads/extended-stable/2026.6.34" }],
    ["tag mismatch", { tagSha: "b".repeat(40) }],
    ["package mismatch", { packageVersion: "2026.6.34" }],
    ["main patch at monthly boundary", { mainPackageVersion: "2026.7.33" }],
    [
      "main two months ahead",
      { mainPackageVersion: "2026.8.1" },
      retiredLineError("2026.8.1", "2026.7"),
    ],
    [
      "main crosses year boundary",
      { mainPackageVersion: "2027.1.1" },
      retiredLineError("2027.1.1", "2026.12"),
    ],
    [
      "SHA preflight mismatch",
      {
        ...preflight,
        releaseTag: "b".repeat(40),
        npmWorkflowRef: "refs/heads/dev/preflight-candidate",
      },
      /must match the checked-out commit/u,
    ],
    [
      "SHA preflight without checkout",
      { preflightOnly: true, releaseTag: sha, checkoutSha: "" },
      /requires the full checked-out commit SHA/u,
    ],
    [
      "regular release bypass",
      { bypassExtendedStableGuard: true, npmDistTag: "beta", releaseTag: sha },
      /only be used with the extended-stable npm dist-tag/u,
    ],
  ])("validates %s", (_label, changes, outcome) => {
    const request = { ...valid, ...changes };
    if (typeof outcome === "object" && !(outcome instanceof RegExp)) {
      expect(validateExtendedStableNpmReleaseRequest(request)).toEqual(outcome);
    } else {
      expect(() => validateExtendedStableNpmReleaseRequest(request)).toThrow(outcome);
    }
  });
});

describe("extended-stable npm run identity", () => {
  const toolingSha = "b".repeat(40);
  const orchestratorSha = "c".repeat(40);
  const toolingRef = `release-publish/${orchestratorSha.slice(0, 12)}-123`;
  const valid = {
    run: {
      workflowName: "OpenClaw NPM Release",
      event: "workflow_dispatch",
      conclusion: "success",
      headBranch: branch,
      headSha: sha,
    },
    kind: "preflight",
    npmDistTag: "extended-stable",
    expectedBranch: branch,
    expectedSha: sha,
  };
  const pluginRun = {
    workflowName: "Plugin NPM Release",
    displayTitle: `Plugin NPM Release [extended-stable] ${sha}`,
    status: "completed",
  };
  type Run = Partial<typeof valid.run> & {
    status?: string;
    displayTitle?: string;
    databaseId?: number;
    attempt?: number;
  };
  type Change = Partial<Omit<typeof valid, "run">> &
    Partial<Omit<Parameters<typeof validateExtendedStableRunIdentity>[0], keyof typeof valid>> & {
      run?: Partial<Run>;
    };
  type Scenario = [name: string, changes: Change, rejects: Change[], error?: RegExp];

  it.each<Scenario>([
    [
      "exact FRV tooling identity separated from source identity",
      {
        run: {
          workflowName: "Full Release Validation",
          databaseId: 123,
          attempt: 2,
          status: "completed",
          headBranch: `release-ci/${toolingSha.slice(0, 12)}-123`,
          headSha: toolingSha,
        },
        preflightRunId: "123",
        preflightRunAttempt: "2",
        fullReleaseRunId: "123",
        fullReleaseRunAttempt: "2",
        workflowPath: ".github/workflows/full-release-validation.yml",
      },
      [
        { fullReleaseRunId: "124" },
        { fullReleaseRunAttempt: "1" },
        { workflowPath: ".github/workflows/ci.yml" },
        { run: { attempt: 1 } },
        { run: { status: "in_progress" } },
        { run: { conclusion: "failure" } },
        { kind: "validation" },
        { kind: "plugin" },
      ],
    ],
    [
      "direct preflight identity",
      {},
      [
        { run: { headBranch: "main" } },
        { run: { headBranch: undefined } },
        { run: { headSha: toolingSha } },
        { run: { headSha: undefined } },
      ],
      /headBranch=.*headSha=/u,
    ],
    [
      "completed successful plugin run at the exact branch and SHA",
      { kind: "plugin", run: pluginRun },
      [
        { run: { workflowName: "OpenClaw NPM Release" } },
        { run: { displayTitle: `Plugin NPM Release [default] ${sha}` } },
        { run: { displayTitle: `Plugin NPM Release [extended-stable] ${toolingSha}` } },
        { run: { status: "in_progress" } },
        { run: { conclusion: "failure" } },
        { run: { headBranch: "main" } },
        { run: { headSha: toolingSha } },
      ],
    ],
    [
      "trusted protected-tag orchestrator for the exact target",
      {
        kind: "plugin",
        run: { ...pluginRun, headBranch: toolingRef, headSha: orchestratorSha },
        expectedOrchestratorBranch: toolingRef,
        expectedOrchestratorSha: orchestratorSha,
      },
      [
        { run: { headBranch: "release/2026.6.35" } },
        { run: { headSha: "not-a-sha" } },
        { run: { displayTitle: `Plugin NPM Release [extended-stable] ${toolingSha}` } },
      ],
    ],
    [
      "authenticated main recovery tooling with exact source identity",
      {
        kind: "plugin",
        run: { ...pluginRun, headBranch: "main", headSha: toolingSha },
        workflowPath: ".github/workflows/plugin-npm-release.yml",
        trustedPluginWorkflowSha: toolingSha,
      },
      [
        { trustedPluginWorkflowSha: "" },
        { trustedPluginWorkflowSha: orchestratorSha },
        { workflowPath: ".github/workflows/ci.yml" },
        { expectedBranch: "extended-stable/2026.6.34" },
        { expectedSha: orchestratorSha },
        { kind: "preflight" },
        { kind: "validation" },
        { run: { headBranch: "feature/recovery" } },
        { run: { event: "push" } },
        { run: { status: "in_progress" } },
        { run: { conclusion: "failure" } },
        { run: { displayTitle: `Plugin NPM Release [default] ${sha}` } },
      ],
    ],
  ])("accepts only %s", (_name, changes, rejects, error) => {
    const request = { ...valid, ...changes, run: { ...valid.run, ...changes.run } };
    expect(validateExtendedStableRunIdentity(request)).toBe(request.run);
    for (const change of rejects) {
      expect(() =>
        validateExtendedStableRunIdentity({
          ...request,
          ...change,
          run: { ...request.run, ...change.run },
        }),
      ).toThrow(error);
    }
  });
});

describe("Full Validation manifest identity", () => {
  const valid = {
    workflowName: "Full Release Validation",
    workflowRef: branch,
    targetSha: sha,
    runId: "123",
    runAttempt: "2",
  };

  it.each<[string, Partial<typeof valid>, boolean?]>([
    ["exact branch and target SHA", {}, true],
    ["missing workflow ref", { workflowRef: undefined }],
    ["missing target SHA", { targetSha: undefined }],
    ["wrong run ID", { runId: "124" }],
    ["wrong run attempt", { runAttempt: "1" }],
  ])("validates %s", (_label, changes, accepted) => {
    const manifest = { ...valid, ...changes };
    const request = {
      manifest,
      npmDistTag: "extended-stable",
      expectedWorkflowRef: branch,
      expectedSha: sha,
      expectedRunId: "123",
      expectedRunAttempt: "2",
    };
    if (accepted) {
      expect(validateFullReleaseValidationManifest(request)).toBe(manifest);
    } else {
      expect(() => validateFullReleaseValidationManifest(request)).toThrow();
    }
  });
});
