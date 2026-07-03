import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  capturePriorStableSelector,
  parsePriorStableSelector,
  stableSelectorRepairCommand,
  validateFullReleaseValidationManifest,
  validateNpmPublishBoundary,
  validateStableNpmReleaseRequest,
  validateStableRunIdentity,
  verifyStableRegistryReadback,
} from "../../scripts/openclaw-npm-stable-release.mjs";

const sha = "a".repeat(40);
const branch = "stable/2026.6.33";

describe("npm stable publication boundary", () => {
  it.each([
    ["2026.6.11-alpha.1", "alpha"],
    ["2026.6.11-beta.1", "beta"],
    ["2026.6.11", "alpha"],
    ["2026.6.11", "beta"],
    ["2026.6.11", "latest"],
    ["2026.6.11-1", "alpha"],
    ["2026.6.11-1", "beta"],
    ["2026.6.11-1", "latest"],
    ["2026.6.33", "stable"],
    ["2026.6.34", "stable"],
  ])("accepts %s on %s", (version, distTag) => {
    expect(() => validateNpmPublishBoundary(version, distTag)).not.toThrow();
  });

  it.each([
    ["2026.6.11", "stable"],
    ["2026.6.11-alpha.1", "beta"],
    ["2026.6.11-alpha.1", "stable"],
    ["2026.6.11-beta.1", "latest"],
    ["2026.6.11-beta.1", "stable"],
    ["2026.6.33", "alpha"],
    ["2026.6.33", "beta"],
    ["2026.6.33", "latest"],
    ["2026.6.33-1", "alpha"],
    ["2026.6.33-1", "beta"],
    ["2026.6.33-1", "latest"],
    ["2026.6.33-1", "stable"],
    ["2026.6.33", "nightly"],
  ])("rejects %s on %s", (version, distTag) => {
    expect(() => validateNpmPublishBoundary(version, distTag)).toThrow();
  });

  it("prints exactly channel then publish tag from the dependency-free CLI", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/openclaw-npm-stable-release.mjs", "publish-plan"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PACKAGE_VERSION: "2026.6.33",
          REQUESTED_PUBLISH_TAG: "stable",
        },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("stable\nstable\n");
    expect(result.stderr).toBe("");
  });
});

describe("stable npm release request", () => {
  const valid = {
    npmDistTag: "stable",
    releaseTag: "v2026.6.33",
    npmWorkflowRef: "refs/heads/stable/2026.6.33",
    checkoutSha: sha,
    tagSha: sha,
    stableBranchSha: sha,
    packageVersion: "2026.6.33",
    mainPackageVersion: "2026.7.2",
  };

  it("accepts .33, later patches, and December rollover", () => {
    expect(validateStableNpmReleaseRequest(valid)).toEqual({
      stable: true,
      releaseVersion: "2026.6.33",
      stableBranch: "stable/2026.6.33",
    });
    expect(
      validateStableNpmReleaseRequest({
        ...valid,
        releaseTag: "v2026.6.34",
        packageVersion: "2026.6.34",
      }),
    ).toMatchObject({ stable: true, releaseVersion: "2026.6.34" });
    expect(
      validateStableNpmReleaseRequest({
        ...valid,
        releaseTag: "v2026.12.33",
        npmWorkflowRef: "refs/heads/stable/2026.12.33",
        packageVersion: "2026.12.33",
        mainPackageVersion: "2027.1.1",
      }),
    ).toMatchObject({ stable: true, stableBranch: "stable/2026.12.33" });
  });

  it.each([
    ["patch below 33", { releaseTag: "v2026.6.32", packageVersion: "2026.6.32" }],
    ["beta prerelease", { releaseTag: "v2026.6.33-beta.1", packageVersion: "2026.6.33-beta.1" }],
    ["alpha prerelease", { releaseTag: "v2026.6.33-alpha.1", packageVersion: "2026.6.33-alpha.1" }],
    ["correction suffix", { releaseTag: "v2026.6.33-1", packageVersion: "2026.6.33-1" }],
    ["wrong branch", { npmWorkflowRef: "refs/heads/stable/2026.6.34" }],
    ["checkout mismatch", { checkoutSha: "b".repeat(40) }],
    ["tag mismatch", { tagSha: "b".repeat(40) }],
    ["branch tip mismatch", { stableBranchSha: "b".repeat(40) }],
    ["package mismatch", { packageVersion: "2026.6.34" }],
    ["main month mismatch", { mainPackageVersion: "2026.8.1" }],
    ["main stable patch", { mainPackageVersion: "2026.7.33" }],
  ])("rejects %s", (_label, changes) => {
    expect(() => validateStableNpmReleaseRequest({ ...valid, ...changes })).toThrow();
  });

  it("preserves SHA-only regular preflight requests", () => {
    expect(
      validateStableNpmReleaseRequest({
        ...valid,
        npmDistTag: "beta",
        releaseTag: sha,
      }),
    ).toEqual({ stable: false });
  });
});

describe("stable npm run identity", () => {
  const validPreflight = {
    workflowName: "OpenClaw NPM Release",
    event: "workflow_dispatch",
    conclusion: "success",
    headBranch: branch,
    headSha: sha,
  };

  it("accepts exact stable preflight and validation runs", () => {
    expect(
      validateStableRunIdentity({
        run: validPreflight,
        kind: "preflight",
        npmDistTag: "stable",
        expectedBranch: branch,
        expectedSha: sha,
      }),
    ).toBe(validPreflight);
    expect(() =>
      validateStableRunIdentity({
        run: {
          ...validPreflight,
          workflowName: "Full Release Validation",
          status: "completed",
        },
        kind: "validation",
        npmDistTag: "stable",
        expectedBranch: branch,
        expectedSha: sha,
      }),
    ).not.toThrow();
  });

  it.each([
    ["wrong branch", { headBranch: "main" }],
    ["missing branch", { headBranch: undefined }],
    ["wrong SHA", { headSha: "b".repeat(40) }],
    ["missing SHA", { headSha: undefined }],
  ])("rejects %s", (_label, changes) => {
    expect(() =>
      validateStableRunIdentity({
        run: { ...validPreflight, ...changes },
        kind: "preflight",
        npmDistTag: "stable",
        expectedBranch: branch,
        expectedSha: sha,
      }),
    ).toThrow(/headBranch=.*headSha=/u);
  });
});

describe("Full Validation manifest identity", () => {
  const valid = { workflowName: "Full Release Validation", workflowRef: branch, targetSha: sha };

  it("accepts the exact branch and target SHA", () => {
    expect(
      validateFullReleaseValidationManifest({
        manifest: valid,
        npmDistTag: "stable",
        expectedWorkflowRef: branch,
        expectedSha: sha,
      }),
    ).toBe(valid);
  });

  it.each([
    ["wrong workflow ref", { workflowRef: "main" }],
    ["missing workflow ref", { workflowRef: undefined }],
    ["wrong target SHA", { targetSha: "b".repeat(40) }],
    ["missing target SHA", { targetSha: undefined }],
  ])("rejects %s", (_label, changes) => {
    expect(() =>
      validateFullReleaseValidationManifest({
        manifest: { ...valid, ...changes },
        npmDistTag: "stable",
        expectedWorkflowRef: branch,
        expectedSha: sha,
      }),
    ).toThrow();
  });
});

describe("stable selector capture", () => {
  it("distinguishes bootstrap absence from an existing selector", () => {
    expect(parsePriorStableSelector('{"latest":"2026.7.1"}')).toBe("absent");
    expect(parsePriorStableSelector('{"stable":"2026.6.33"}')).toBe("2026.6.33");
  });

  it.each(["not json", "null", "[]", '"2026.6.33"'])("rejects invalid result %s", (value) => {
    expect(() => parsePriorStableSelector(value)).toThrow();
  });

  it("rejects command failure rather than treating it as bootstrap", () => {
    expect(() => capturePriorStableSelector({ query: () => ({ status: 1, stdout: "" }) })).toThrow(
      /query failed/u,
    );
  });
});

describe("stable registry readback", () => {
  it("accepts eventual convergence and sleeps 10 seconds between attempts", async () => {
    let attempt = 0;
    const sleep = vi.fn(async () => {});
    const result = await verifyStableRegistryReadback({
      expectedVersion: "2026.6.33",
      query: async (target: string) => {
        if (target === "openclaw@2026.6.33") {
          attempt += 1;
        }
        return { status: 0, stdout: attempt >= 2 ? "2026.6.33\n" : "2026.6.32\n" };
      },
      sleep,
    });
    expect(result).toEqual({
      exactVersion: "2026.6.33",
      stableSelector: "2026.6.33",
      attemptsUsed: 2,
    });
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(10_000);
  });

  it("exhausts exactly 12 dual-query attempts on mismatch or failure", async () => {
    const query = vi.fn(async () => ({ status: 1, stdout: "" }));
    const sleep = vi.fn(async () => {});
    await expect(
      verifyStableRegistryReadback({ expectedVersion: "2026.6.33", query, sleep }),
    ).rejects.toThrow(/after 12 attempts/u);
    expect(query).toHaveBeenCalledTimes(24);
    expect(sleep).toHaveBeenCalledTimes(11);
    expect(sleep.mock.calls.every(([delay]) => delay === 10_000)).toBe(true);
  });
});

describe("stable selector repair", () => {
  it("returns the exact add or remove command", () => {
    expect(stableSelectorRepairCommand("2026.5.40")).toBe(
      "npm dist-tag add openclaw@2026.5.40 stable",
    );
    expect(stableSelectorRepairCommand("absent")).toBe("npm dist-tag rm openclaw stable");
  });
});
