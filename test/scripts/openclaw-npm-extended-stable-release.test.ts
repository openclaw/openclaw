import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  capturePriorExtendedStableSelector,
  extendedStableSelectorRepairCommand,
  parseExtendedStableGuardBypass,
  parsePriorExtendedStableSelector,
  resolveNpmPreflightSdkSelectors,
  validateFullReleaseValidationManifest,
  validateNpmPreflightDistTag,
  validateNpmPublishBoundary,
  validateExtendedStableNpmReleaseRequest,
  validateExtendedStableRunIdentity,
  verifyExtendedStableRegistryReadback,
} from "../../scripts/openclaw-npm-extended-stable-release.mjs";

const sha = "a".repeat(40);
const branch = "extended-stable/2026.6.33";

describe("npm preflight publication channels", () => {
  it.each([
    ["2026.8.1", "beta", ["beta", "latest"]],
    ["2026.8.1-1", "latest", ["beta", "latest"]],
    ["2026.8.1-beta.1", "beta", ["beta"]],
    ["2026.6.33", "extended-stable", ["extended-stable"]],
  ])("qualifies %s on %s against its supported selectors", (version, tag, selectors) => {
    expect(resolveNpmPreflightSdkSelectors(version, tag)).toEqual(selectors);
  });

  it("allows only qualified regular releases with both SDK receipts to cross beta/latest", () => {
    const receipt = { schema: "openclaw.plugin-sdk-api-release-evidence/v1" };
    const manifest = {
      version: 3,
      packageVersion: "2026.8.1",
      npmDistTag: "beta",
      pluginSdkApi: {
        schema: "openclaw.plugin-sdk-api-release-evidence-set/v1",
        selectors: { beta: receipt, latest: receipt },
      },
    };
    expect(() => validateNpmPreflightDistTag({ manifest, npmDistTag: "latest" })).not.toThrow();
    expect(() =>
      validateNpmPreflightDistTag({
        manifest: {
          ...manifest,
          pluginSdkApi: {
            ...manifest.pluginSdkApi,
            schema: "openclaw.plugin-sdk-api-release-evidence-set/v2",
          },
        },
        npmDistTag: "latest",
      }),
    ).not.toThrow();
    for (const changed of [
      { ...manifest, version: 2 },
      { ...manifest, version: 1 },
      { ...manifest, pluginSdkApi: receipt },
      { ...manifest, packageVersion: "2026.8.1-beta.1" },
      { ...manifest, packageVersion: "2026.6.33", npmDistTag: "extended-stable" },
      { ...manifest, pluginSdkApi: { ...manifest.pluginSdkApi, selectors: { beta: receipt } } },
    ]) {
      expect(() =>
        validateNpmPreflightDistTag({ manifest: changed, npmDistTag: "latest" }),
      ).toThrow("dist-tag mismatch");
    }
    expect(() => validateNpmPreflightDistTag({ manifest, npmDistTag: "alpha" })).toThrow(
      "Alpha releases are retired;",
    );
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
    expect(parseExtendedStableGuardBypass()).toBe(false);
    expect(parseExtendedStableGuardBypass("")).toBe(false);
    expect(parseExtendedStableGuardBypass("false")).toBe(false);
    expect(parseExtendedStableGuardBypass("true")).toBe(true);
    expect(() => parseExtendedStableGuardBypass("1")).toThrow(/must be "true" or "false"/u);
  });

  it.each<[string, string, boolean]>([
    ["2026.6.11-beta.1", "beta", false],
    ["2026.6.11", "beta", false],
    ["2026.6.11", "latest", false],
    ["2026.6.11-1", "latest", false],
    ["2026.6.33", "extended-stable", false],
    ["2026.6.11", "extended-stable", true],
  ])("accepts %s on %s (bypass=%s)", (version, distTag, bypassExtendedStableGuard) => {
    expect(() =>
      validateNpmPublishBoundary(version, distTag, { bypassExtendedStableGuard }),
    ).not.toThrow();
  });

  it.each<[string, string, boolean, (string | RegExp)?]>([
    ["2026.6.11", "extended-stable", false, /patch 33 or above/u],
    ["2026.6.11-beta.1", "latest", false],
    ["2026.6.33", "beta", false],
    ["2026.6.33-1", "latest", false],
    ["2026.6.33-1", "extended-stable", false],
    ["2026.6.33", "nightly", false],
    ["2026.6.11-1", "extended-stable", true, /does not allow correction suffixes/u],
    ["2026.6.11", "beta", true, /only be used with the extended-stable npm dist-tag/u],
    ["2026.6.11", "nightly", true, 'Unsupported npm dist-tag "nightly"'],
  ])("rejects %s on %s (bypass=%s)", (version, distTag, bypassExtendedStableGuard, error) => {
    expect(() =>
      validateNpmPublishBoundary(version, distTag, { bypassExtendedStableGuard }),
    ).toThrow(error);
  });

  it.each([
    ["2026.6.11-alpha.1", "beta"],
    ["2026.6.11", "alpha"],
  ])("rejects retired alpha version or selector %s/%s", (version, tag) => {
    expect(() => validateNpmPublishBoundary(version, tag)).toThrow("Alpha releases are retired;");
    expect(() => resolveNpmPreflightSdkSelectors(version, tag)).toThrow(
      "Alpha releases are retired;",
    );
  });

  it.each<[string, string, string, RegExp?]>([
    ["2026.6.33", "extended-stable", "false"],
    ["2026.6.11", "extended-stable", "sometimes", /must be "true" or "false"/u],
    ["2026.6.11", "beta", "true", /only be used with the extended-stable npm dist-tag/u],
  ])(
    "validates %s on %s in the dependency-free CLI (bypass=%s)",
    (version, distTag, bypass, error) => {
      const result = spawnSync(
        process.execPath,
        ["scripts/openclaw-npm-extended-stable-release.mjs", "publish-plan"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            BYPASS_EXTENDED_STABLE_GUARD: bypass,
            PACKAGE_VERSION: version,
            REQUESTED_PUBLISH_TAG: distTag,
          },
        },
      );
      if (error) {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(error);
      } else {
        expect(result.status).toBe(0);
        expect(result.stdout).toBe("stable\nextended-stable\n");
        expect(result.stderr).toBe("");
      }
    },
  );
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
  const bypassed = {
    bypassExtendedStableGuard: true,
    releaseTag: "v2026.6.11",
    packageVersion: "2026.6.11",
    mainPackageVersion: "",
  };
  type RequestChanges = Partial<typeof valid> & {
    preflightOnly?: boolean;
    bypassExtendedStableGuard?: boolean;
  };
  type Result = Partial<typeof expected> & { bypassExtendedStableGuard?: boolean };

  it.each<[string, RequestChanges, Result?, (string | RegExp)?]>([
    ["initial monthly patch", {}, expected],
    [
      "later monthly patch",
      { releaseTag: "v2026.6.34", packageVersion: "2026.6.34" },
      { ...expected, releaseVersion: "2026.6.34" },
    ],
    [
      "year rollover",
      {
        releaseTag: "v2026.12.33",
        packageVersion: "2026.12.33",
        npmWorkflowRef: "refs/heads/extended-stable/2026.12.33",
        mainPackageVersion: "2027.1.1",
      },
      {
        ...expected,
        releaseVersion: "2026.12.33",
        extendedStableBranch: "extended-stable/2026.12.33",
      },
    ],
    [
      "explicit stale-line bypass",
      { mainPackageVersion: "2027.1.1", bypassExtendedStableGuard: true },
      { ...expected, bypassExtendedStableGuard: true },
    ],
    ["regular SHA preflight", { npmDistTag: "beta", releaseTag: sha }, { extendedStable: false }],
    ["extended-stable SHA preflight", preflight, expected],
    [
      "canonical branch with policy bypass",
      bypassed,
      { ...expected, releaseVersion: "2026.6.11", bypassExtendedStableGuard: true },
    ],
    ["patch below 33", { releaseTag: "v2026.6.32", packageVersion: "2026.6.32" }],
    ["beta prerelease", { releaseTag: "v2026.6.33-beta.1", packageVersion: "2026.6.33-beta.1" }],
    ["correction suffix", { releaseTag: "v2026.6.33-1", packageVersion: "2026.6.33-1" }],
    ["wrong branch", { npmWorkflowRef: "refs/heads/extended-stable/2026.6.34" }],
    ["checkout mismatch", { checkoutSha: "b".repeat(40) }],
    ["tag mismatch", { tagSha: "b".repeat(40) }],
    ["branch tip mismatch", { extendedStableBranchSha: "b".repeat(40) }],
    ["package mismatch", { packageVersion: "2026.6.34" }],
    ["main same month", { mainPackageVersion: "2026.6.1" }],
    ["main earlier year", { mainPackageVersion: "2025.12.32" }],
    ["main patch at monthly boundary", { mainPackageVersion: "2026.7.33" }],
    [
      "main two months ahead",
      { mainPackageVersion: "2026.8.1" },
      undefined,
      "Extended-stable publishes only the trailing completed month: protected main 2026.8.1 allows 2026.7.PATCH, not 2026.6.33. Retire the older line; publishing a retired line requires an explicit maintainer decision.",
    ],
    [
      "main crosses year boundary",
      { mainPackageVersion: "2027.1.1" },
      undefined,
      "Extended-stable publishes only the trailing completed month: protected main 2027.1.1 allows 2026.12.PATCH, not 2026.6.33. Retire the older line; publishing a retired line requires an explicit maintainer decision.",
    ],
    [
      "SHA preflight mismatch",
      {
        ...preflight,
        releaseTag: "b".repeat(40),
        npmWorkflowRef: "refs/heads/dev/preflight-candidate",
      },
      undefined,
      /must match the checked-out commit/u,
    ],
    [
      "SHA preflight without checkout",
      { preflightOnly: true, releaseTag: sha, checkoutSha: "" },
      undefined,
      /requires the full checked-out commit SHA/u,
    ],
    ["SHA publication", { releaseTag: sha }, undefined, /exact final vYYYY\.M\.P release tag/u],
    [
      "bypassed package mismatch",
      { ...bypassed, packageVersion: "2026.6.12" },
      undefined,
      /package version mismatch/u,
    ],
    [
      "bypassed workflow mismatch",
      { ...bypassed, npmWorkflowRef: "refs/heads/dev/extended-stable-publish-test" },
      undefined,
      /workflow ref mismatch/u,
    ],
    [
      "bypassed branch mismatch",
      { ...bypassed, extendedStableBranchSha: "b".repeat(40) },
      undefined,
      /branch tip SHAs must match/u,
    ],
    [
      "regular release bypass",
      { bypassExtendedStableGuard: true, npmDistTag: "beta", releaseTag: sha },
      undefined,
      /only be used with the extended-stable npm dist-tag/u,
    ],
  ])("validates %s", (_label, changes, result, error) => {
    const request = { ...valid, ...changes };
    if (result) {
      expect(validateExtendedStableNpmReleaseRequest(request)).toEqual(result);
    } else {
      expect(() => validateExtendedStableNpmReleaseRequest(request)).toThrow(error);
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
  type Run = Omit<typeof valid.run, "headBranch" | "headSha"> & {
    headBranch: string | undefined;
    headSha: string | undefined;
    status?: string;
    displayTitle?: string;
    databaseId?: number;
    attempt?: number;
  };
  type Change = Partial<Omit<typeof valid, "run">> & {
    run?: Partial<Run>;
    preflightRunId?: string;
    preflightRunAttempt?: string;
    fullReleaseRunId?: string;
    fullReleaseRunAttempt?: string;
    workflowPath?: string;
    expectedOrchestratorBranch?: string;
    expectedOrchestratorSha?: string;
    trustedPluginWorkflowSha?: string;
  };
  type Scenario = { name: string; changes: Change; rejects?: Change[]; error?: RegExp };

  it.each<Scenario>([
    {
      name: "exact FRV tooling identity separated from source identity",
      changes: {
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
      rejects: [
        { fullReleaseRunId: "124" },
        { fullReleaseRunAttempt: "1" },
        { workflowPath: ".github/workflows/ci.yml" },
        { run: { attempt: 1 } },
        { run: { status: "in_progress" } },
        { run: { conclusion: "failure" } },
        { kind: "validation" },
        { kind: "plugin" },
      ],
    },
    {
      name: "direct preflight identity",
      changes: {},
      rejects: [
        { run: { headBranch: "main" } },
        { run: { headBranch: undefined } },
        { run: { headSha: toolingSha } },
        { run: { headSha: undefined } },
      ],
      error: /headBranch=.*headSha=/u,
    },
    {
      name: "direct validation identity",
      changes: {
        kind: "validation",
        run: { workflowName: "Full Release Validation", status: "completed" },
      },
    },
    {
      name: "completed successful plugin run at the exact branch and SHA",
      changes: { kind: "plugin", run: pluginRun },
      rejects: [
        { run: { workflowName: "OpenClaw NPM Release" } },
        { run: { displayTitle: `Plugin NPM Release [default] ${sha}` } },
        { run: { displayTitle: `Plugin NPM Release [extended-stable] ${toolingSha}` } },
        { run: { status: "in_progress" } },
        { run: { conclusion: "failure" } },
        { run: { headBranch: "main" } },
        { run: { headSha: toolingSha } },
      ],
    },
    {
      name: "trusted protected-tag orchestrator for the exact target",
      changes: {
        kind: "plugin",
        run: { ...pluginRun, headBranch: toolingRef, headSha: orchestratorSha },
        expectedOrchestratorBranch: toolingRef,
        expectedOrchestratorSha: orchestratorSha,
      },
      rejects: [
        { run: { headBranch: "release/2026.6.35" } },
        { run: { headSha: "not-a-sha" } },
        { run: { displayTitle: `Plugin NPM Release [extended-stable] ${toolingSha}` } },
      ],
    },
    {
      name: "authenticated main recovery tooling with exact source identity",
      changes: {
        kind: "plugin",
        run: { ...pluginRun, headBranch: "main", headSha: toolingSha },
        workflowPath: ".github/workflows/plugin-npm-release.yml",
        trustedPluginWorkflowSha: toolingSha,
      },
      rejects: [
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
    },
  ])("accepts only $name", ({ changes, rejects = [], error }) => {
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
    ["wrong workflow ref", { workflowRef: "main" }],
    ["missing workflow ref", { workflowRef: undefined }],
    ["wrong target SHA", { targetSha: "b".repeat(40) }],
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

describe("extended-stable selector capture", () => {
  it.each<[string, string?]>([
    ['{"latest":"2026.7.1"}', "absent"],
    ['{"extended-stable":"2026.6.33"}', "2026.6.33"],
    ["not json"],
    ["null"],
    ["[]"],
    ['"2026.6.33"'],
  ])("validates selector result %s", (value, expected) => {
    if (expected) {
      expect(parsePriorExtendedStableSelector(value)).toBe(expected);
    } else {
      expect(() => parsePriorExtendedStableSelector(value)).toThrow();
    }
  });

  it("rejects command failure rather than treating it as bootstrap", () => {
    expect(() =>
      capturePriorExtendedStableSelector({ query: () => ({ status: 1, stdout: "" }) }),
    ).toThrow(/query failed/u);
  });
});

describe("extended-stable registry readback", () => {
  it.each([120])(
    "accepts convergence on attempt %s within the propagation window",
    async (visibleAt) => {
      let attempt = 0;
      const sleep = vi.fn(async (_delay: number) => {});
      const result = await verifyExtendedStableRegistryReadback({
        expectedVersion: "2026.6.33",
        query: async (target: string) => {
          if (target === "openclaw@2026.6.33") {
            attempt += 1;
          }
          return { status: 0, stdout: attempt >= visibleAt ? "2026.6.33\n" : "2026.6.32\n" };
        },
        sleep,
      });
      expect(result).toEqual({
        exactVersion: "2026.6.33",
        extendedStableSelector: "2026.6.33",
        attemptsUsed: visibleAt,
      });
      expect(sleep).toHaveBeenCalledTimes(visibleAt - 1);
      expect(sleep).toHaveBeenCalledWith(10_000);
    },
  );

  it("fails closed after the thirty-minute propagation window", async () => {
    const query = vi.fn(async () => ({ status: 1, stdout: "" }));
    const sleep = vi.fn(async (_delay: number) => {});
    await expect(
      verifyExtendedStableRegistryReadback({ expectedVersion: "2026.6.33", query, sleep }),
    ).rejects.toThrow(/after 181 attempts/u);
    expect(query).toHaveBeenCalledTimes(362);
    expect(sleep).toHaveBeenCalledTimes(180);
    expect(sleep.mock.calls.every(([delay]) => delay === 10_000)).toBe(true);
  });
});

describe("extended-stable selector repair", () => {
  it.each<[string | undefined, string?]>([
    ["v2026.6.33", "npm dist-tag add openclaw@2026.6.33 extended-stable"],
    [undefined],
    ["absent"],
    ["2026.6.33-beta.1"],
    ["2026.6.33-1"],
  ])("validates repair version %s", (expectedVersion, command) => {
    if (command) {
      expect(extendedStableSelectorRepairCommand(expectedVersion)).toBe(command);
    } else {
      expect(() => extendedStableSelectorRepairCommand(expectedVersion)).toThrow(
        "Extended-stable selector repair requires an exact final YYYY.M.P version.",
      );
    }
  });
});
