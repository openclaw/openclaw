import { describe, expect, it, vi } from "vitest";
import {
  validateExtendedStableCoreRun,
  validateExtendedStablePreflightRun,
  validateLaterMonthLatest,
  verifyExtendedStableCloseout,
} from "../../scripts/openclaw-npm-extended-stable-closeout.mjs";

const sha = "a".repeat(40);
const branch = "extended-stable/2026.6.33";
const run = {
  workflowName: "OpenClaw NPM Release",
  event: "workflow_dispatch",
  status: "completed",
  conclusion: "success",
  headBranch: branch,
  headSha: sha,
};

describe("extended-stable core run closeout", () => {
  it("accepts a successful exact run", () => {
    expect(
      validateExtendedStableCoreRun(
        { run, jobs: [] },
        { expectedBranch: branch, expectedSha: sha },
      ),
    ).toEqual({ mode: "success" });
  });

  it("accepts only the bounded publish-success/readback-failure shape", () => {
    const payload = {
      run: { ...run, conclusion: "failure" },
      jobs: [
        { name: "validate_publish_request", conclusion: "success", steps: [] },
        {
          name: "publish_openclaw_npm",
          conclusion: "failure",
          steps: [
            { name: "Publish", conclusion: "success" },
            { name: "Verify extended-stable registry readback", conclusion: "failure" },
            { name: "Summarize extended-stable npm publication", conclusion: "success" },
          ],
        },
      ],
    };
    expect(
      validateExtendedStableCoreRun(payload, { expectedBranch: branch, expectedSha: sha }),
    ).toEqual({ mode: "published-readback-failed" });
    expect(() =>
      validateExtendedStableCoreRun(
        {
          ...payload,
          jobs: [
            {
              conclusion: "failure",
              steps: [
                { name: "Publish", conclusion: "failure" },
                { name: "Verify extended-stable registry readback", conclusion: "skipped" },
              ],
            },
          ],
        },
        { expectedBranch: branch, expectedSha: sha },
      ),
    ).toThrow(/publish succeeded/u);
  });

  it.each(["cancelled", "timed_out", "action_required", "neutral"])(
    "rejects an extra %s job conclusion",
    (conclusion) => {
      expect(() =>
        validateExtendedStableCoreRun(
          {
            run: { ...run, conclusion: "failure" },
            jobs: [
              { name: "unexpected", conclusion, steps: [] },
              {
                name: "publish_openclaw_npm",
                conclusion: "failure",
                steps: [
                  { name: "Publish", conclusion: "success" },
                  { name: "Verify extended-stable registry readback", conclusion: "failure" },
                ],
              },
            ],
          },
          { expectedBranch: branch, expectedSha: sha },
        ),
      ).toThrow(/unexpected/u);
    },
  );

  it("rejects a second non-success step conclusion", () => {
    expect(() =>
      validateExtendedStableCoreRun(
        {
          run: { ...run, conclusion: "failure" },
          jobs: [
            {
              name: "publish_openclaw_npm",
              conclusion: "failure",
              steps: [
                { name: "Publish", conclusion: "success" },
                { name: "Verify extended-stable registry readback", conclusion: "failure" },
                { name: "Post publish", conclusion: "cancelled" },
              ],
            },
          ],
        },
        { expectedBranch: branch, expectedSha: sha },
      ),
    ).toThrow(/unexpected/u);
  });

  it("rejects a non-success step hidden under another successful job", () => {
    expect(() =>
      validateExtendedStableCoreRun(
        {
          run: { ...run, conclusion: "failure" },
          jobs: [
            {
              name: "validate_publish_request",
              conclusion: "success",
              steps: [{ name: "Validate", conclusion: "timed_out" }],
            },
            {
              name: "publish_openclaw_npm",
              conclusion: "failure",
              steps: [
                { name: "Publish", conclusion: "success" },
                { name: "Verify extended-stable registry readback", conclusion: "failure" },
              ],
            },
          ],
        },
        { expectedBranch: branch, expectedSha: sha },
      ),
    ).toThrow(/unexpected/u);
  });
});

describe("extended-stable preflight run closeout", () => {
  const payload = {
    run,
    jobs: [
      { name: "preflight_openclaw_npm", conclusion: "success" },
      { name: "validate_publish_request", conclusion: "skipped" },
      { name: "publish_openclaw_npm", conclusion: "skipped" },
    ],
    artifacts: [
      { id: 42, name: "openclaw-npm-preflight-v2026.6.33", expired: false },
      { id: 43, name: "dependency-release-evidence-v2026.6.33", expired: false },
    ],
  };

  it("requires a successful preflight-only job shape and exact unexpired artifact", () => {
    expect(
      validateExtendedStablePreflightRun(payload, {
        expectedBranch: branch,
        expectedSha: sha,
        expectedArtifactName: "openclaw-npm-preflight-v2026.6.33",
      }),
    ).toEqual({ artifactId: 42 });
  });

  it.each([
    [
      "publish ran",
      {
        jobs: payload.jobs.map((job) =>
          job.name === "publish_openclaw_npm" ? { ...job, conclusion: "success" } : job,
        ),
      },
    ],
    ["artifact expired", { artifacts: [{ ...payload.artifacts[0], expired: true }] }],
    ["artifact duplicated", { artifacts: [payload.artifacts[0], payload.artifacts[0]] }],
  ])("rejects %s", (_label, override) => {
    expect(() =>
      validateExtendedStablePreflightRun(
        { ...payload, ...override },
        {
          expectedBranch: branch,
          expectedSha: sha,
          expectedArtifactName: "openclaw-npm-preflight-v2026.6.33",
        },
      ),
    ).toThrow();
  });

  it.each([
    ["wrong branch", { headBranch: "main" }],
    ["wrong SHA", { headSha: "b".repeat(40) }],
    ["wrong workflow", { workflowName: "Full Release Validation" }],
  ])("rejects %s", (_label, runOverride) => {
    expect(() =>
      validateExtendedStablePreflightRun(
        { ...payload, run: { ...payload.run, ...runOverride } },
        {
          expectedBranch: branch,
          expectedSha: sha,
          expectedArtifactName: "openclaw-npm-preflight-v2026.6.33",
        },
      ),
    ).toThrow();
  });
});

describe("extended-stable latest preservation", () => {
  it.each(["2026.7.2", "2026.7.2-1", "2027.1.1"])("accepts later-month %s", (latest) => {
    expect(validateLaterMonthLatest(latest, "2026.6.33")).toBe(latest);
  });

  it.each(["2026.6.2", "2026.7.33", "2026.7.2-beta.1"])("rejects invalid latest %s", (latest) => {
    expect(() => validateLaterMonthLatest(latest, "2026.6.33")).toThrow();
  });
});

describe("extended-stable registry snapshot", () => {
  it("verifies core and canonical plugins and emits a deterministic compact snapshot", async () => {
    const query = vi.fn(async (target: string) => ({
      status: 0,
      stdout: target === "openclaw@latest" ? "2026.7.2-1\n" : "2026.6.33\n",
    }));
    const snapshot = await verifyExtendedStableCloseout({
      expectedVersion: "2026.6.33",
      expectedSha: sha,
      baseline: {
        schemaVersion: 1,
        version: "2026.6.33",
        sourceSha: sha,
        previousExtendedStable: "absent",
        latest: "2026.7.2-1",
      },
      plan: {
        all: [
          { packageName: "@openclaw/zeta", version: "2026.6.33" },
          { packageName: "@openclaw/alpha", version: "2026.6.33" },
        ],
      },
      query,
      sleep: vi.fn(async () => {}),
    });
    expect(snapshot).toEqual({
      schemaVersion: 1,
      version: "2026.6.33",
      corePackages: [
        { packageName: "@openclaw/ai", exact: "2026.6.33", extendedStable: "2026.6.33" },
        { packageName: "openclaw", exact: "2026.6.33", extendedStable: "2026.6.33" },
      ],
      latest: "2026.7.2-1",
      plugins: [
        { packageName: "@openclaw/alpha", exact: "2026.6.33", extendedStable: "2026.6.33" },
        { packageName: "@openclaw/zeta", exact: "2026.6.33", extendedStable: "2026.6.33" },
      ],
    });
    expect(query).toHaveBeenCalledWith("@openclaw/ai@extended-stable");
  });

  it("fails closed when latest moves after baseline capture", async () => {
    await expect(
      verifyExtendedStableCloseout({
        expectedVersion: "2026.6.33",
        expectedSha: sha,
        baseline: {
          schemaVersion: 1,
          version: "2026.6.33",
          sourceSha: sha,
          previousExtendedStable: "absent",
          latest: "2026.7.2",
        },
        plan: { all: [{ packageName: "@openclaw/example", version: "2026.6.33" }] },
        query: async (target: string) => ({
          status: 0,
          stdout: target === "openclaw@latest" ? "2026.7.3\n" : "2026.6.33\n",
        }),
        sleep: vi.fn(async () => {}),
        attempts: 1,
      }),
    ).rejects.toThrow(/expected-latest=2026.7.2/u);
  });

  it("rejects an empty canonical plugin inventory", async () => {
    await expect(
      verifyExtendedStableCloseout({
        expectedVersion: "2026.6.33",
        expectedSha: sha,
        baseline: {
          schemaVersion: 1,
          version: "2026.6.33",
          sourceSha: sha,
          previousExtendedStable: "absent",
          latest: "2026.7.2",
        },
        plan: { all: [] },
        query: vi.fn(),
        sleep: vi.fn(),
      }),
    ).rejects.toThrow(/must not be empty/u);
  });
});
