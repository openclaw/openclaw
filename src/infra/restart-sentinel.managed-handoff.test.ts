import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  clearRestartSentinelIfRevision,
  inspectManagedHandoffSentinel,
  recordManagedHandoffSentinelOutcome,
  readRestartSentinel,
  writeRestartSentinel,
} from "./restart-sentinel.js";
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeStateDatabaseForTest();
    cleanup();
  }),
);
async function withRestartSentinelStateDir(run: () => Promise<void>) {
  await withEnvAsync({ OPENCLAW_STATE_DIR: tempDirs.make("handoff-sentinel-") }, run);
}

describe("managed handoff sentinel owner", () => {
  const handoff = {
    handoffId: "managed-handoff",
    runId: "managed-run",
    root: "/fixture/openclaw",
  };
  const handoffPayload = {
    kind: "update" as const,
    status: "skipped" as const,
    ts: 1,
    stats: {
      ...handoff,
      reason: "restart-health-pending",
    },
  };
  const handoffOutcome = {
    ...handoff,
    fallbackPayload: handoffPayload,
    reason: "managed-service-handoff-failed",
    triageHint: "Run openclaw update repair",
    serviceKind: "launchd",
    handoffFailure: "candidate failed",
  };
  const recordOutcome = (
    overrides: Partial<Parameters<typeof recordManagedHandoffSentinelOutcome>[0]> = {},
  ) =>
    recordManagedHandoffSentinelOutcome({ ...handoffOutcome, ...overrides }, process.env, () => {});

  it("records a managed recovery through the writer while preserving the child failure", async () => {
    await withRestartSentinelStateDir(async () => {
      await writeRestartSentinel({
        ...handoffPayload,
        status: "error",
        continuation: { kind: "agentTurn", message: "Do not run after failure" },
        stats: { ...handoffPayload.stats, reason: "candidate-doctor-failed" },
      });
      const inspected = await inspectManagedHandoffSentinel(handoff);
      expect(inspected.sentinel?.payload.stats?.reason).toBe("candidate-doctor-failed");
      const recorded = await recordOutcome({
        expectedRevision: inspected.revision,
        completedStatus: "error",
        restored: true,
      });
      expect(recorded.kind).toBe("recorded");
      expect(recorded.sentinel?.payload).toMatchObject({
        status: "error",
        doctorHint: "Run openclaw update repair",
        stats: {
          reason: "candidate-doctor-failed",
          steps: [{ name: "service-restore", command: "launchd", log: { exitCode: 0 } }],
        },
      });
      expect(recorded.sentinel?.payload.continuation).toBeUndefined();
      expect(await readRestartSentinel()).toEqual(recorded.sentinel);
    });
  });

  it.each(["consumed", "changed", "other-handoff", "other-root", "other-run"] as const)(
    "refuses managed recovery when its inspected notice is %s",
    async (scenario) => {
      await withRestartSentinelStateDir(async () => {
        const written = await writeRestartSentinel(handoffPayload);
        const inspected = await inspectManagedHandoffSentinel(handoff);
        if (scenario === "consumed") {
          await clearRestartSentinelIfRevision(written.revision);
        } else if (scenario === "changed") {
          await writeRestartSentinel(handoffPayload);
        } else {
          await writeRestartSentinel({
            ...handoffPayload,
            stats: {
              ...handoffPayload.stats,
              ...(scenario === "other-handoff" ? { handoffId: "another-handoff" } : {}),
              ...(scenario === "other-root" ? { root: "/fixture/another-install" } : {}),
              ...(scenario === "other-run" ? { runId: "another-run" } : {}),
            },
          });
        }
        const before = await readRestartSentinel();
        const result = await recordOutcome(
          scenario === "consumed" || scenario === "changed"
            ? { expectedRevision: inspected.revision }
            : {},
        );
        expect(result.kind).toBe("refused");
        expect(await readRestartSentinel()).toEqual(before);
      });
    },
  );

  it("does not resurrect a consumed completed handoff notice", async () => {
    await withRestartSentinelStateDir(async () => {
      const written = await writeRestartSentinel(handoffPayload);
      await clearRestartSentinelIfRevision(written.revision);
      await expect(recordOutcome({ completedStatus: "skipped", restored: true })).resolves.toEqual({
        kind: "unchanged",
        sentinel: null,
      });
      expect(await readRestartSentinel()).toBeNull();
    });
  });
});
