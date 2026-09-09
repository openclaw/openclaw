import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildUpdateRestartSentinelPayload } from "../infra/update-restart-sentinel-payload.js";
import {
  createUpdateRun,
  recordUpdateRunPhase,
  recordUpdateRunVerification,
} from "../infra/update-run-ledger.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import { finalizeRestartUpdateRun } from "./server-restart-update-run.js";

// The runtime build ID is a process-level constant resolved from packaged
// build info; vary it per test through this mutable override instead.
let runtimeBuildId: string | null = null;
vi.mock("../version.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../version.js")>()),
  resolveRuntimeServiceBuildId: () => runtimeBuildId,
}));

const directories = createTempDirTracker();
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  runtimeBuildId = null;
  directories.cleanup();
});

describe("update restart verification ownership", () => {
  it.each(["api", "chat", "control-ui", "campaign"] as const)(
    "finishes an unmanaged %s update after replacement startup",
    async (trigger) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", directories.make("update-unmanaged-boot-"));
      const version = resolveRuntimeServiceVersion();
      const run = createUpdateRun({ trigger, target: { version } });
      recordUpdateRunPhase(run.runId, "restarting", { after: { version } });
      const payload = buildUpdateRestartSentinelPayload({
        result: { status: "ok", mode: "npm", after: { version }, steps: [], durationMs: 1 },
        meta: { runId: run.runId },
      });
      expect(await finalizeRestartUpdateRun(payload)).toMatchObject({
        status: "succeeded",
        phase: "finished",
        finishedAtMs: expect.any(Number),
        verification: { booted: true, serviceRunning: true, versionMatch: true },
      });
    },
  );

  it.each(["api", "chat", "control-ui", "campaign"] as const)(
    "preserves managed %s verification after replacement startup",
    async (trigger) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", directories.make("update-managed-boot-"));
      const version = resolveRuntimeServiceVersion();
      const run = createUpdateRun({ trigger, target: { version } });
      recordUpdateRunPhase(run.runId, "verifying", { after: { version } });
      const payload = buildUpdateRestartSentinelPayload({
        result: { status: "ok", mode: "npm", after: { version }, steps: [], durationMs: 1 },
        meta: { runId: run.runId, handoffId: "managed-update-handoff" },
      });
      expect(await finalizeRestartUpdateRun(payload, true)).toMatchObject({
        status: "running",
        phase: "verifying",
        finishedAtMs: null,
        verification: { booted: true, serviceRunning: true, versionMatch: true },
      });
    },
  );

  it.each(["api", "chat", "control-ui", "campaign"] as const)(
    "preserves the restored-version verification for a failed managed %s update",
    async (trigger) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", directories.make("update-managed-restore-"));
      const restoredVersion = "1.2.3";
      const targetVersion = "2.0.0";
      vi.stubEnv("OPENCLAW_VERSION", restoredVersion);
      runtimeBuildId = "build-restored";
      // The failed update booting the old version records the target, not the
      // restored disk version: after.version stays empty (staged-install
      // verification failed), so the helper's restore verification is the only
      // versionMatch fact. It compares the restored gateway against the
      // restored disk version, not against the update target.
      const run = createUpdateRun({ trigger, target: { version: targetVersion } });
      recordUpdateRunPhase(run.runId, "restarting");
      recordUpdateRunPhase(run.runId, "verifying", { after: {} });
      recordUpdateRunVerification(run.runId, {
        serviceRunning: true,
        runningVersion: restoredVersion,
        runningBuildId: "build-restored",
        versionMatch: true,
        settled: true,
        channelsReady: true,
        pluginErrors: [],
      });
      const payload = buildUpdateRestartSentinelPayload({
        result: {
          status: "error",
          mode: "npm",
          reason: "managed-service-handoff-failed",
          steps: [],
          durationMs: 1,
        },
        meta: { runId: run.runId, handoffId: "managed-update-handoff" },
      });
      const observed = await finalizeRestartUpdateRun(payload, true);
      // The restored gateway booted on the restored version. The helper already
      // verified that identity; the boot must not regrade it against the
      // update target.
      expect(observed?.verification.versionMatch).toBe(true);
      expect(observed?.verification.runningVersion).toBe(restoredVersion);
      expect(observed).toMatchObject({ status: "running", phase: "verifying" });
    },
  );

  it("regrades a restored-version boot reporting a different build against the update target", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", directories.make("update-managed-restore-build-mismatch-"));
    const restoredVersion = "1.2.3";
    vi.stubEnv("OPENCLAW_VERSION", restoredVersion);
    runtimeBuildId = "build-other";
    // The restore helper verified version 1.2.3/build-restored. A later boot
    // serving 1.2.3/build-other is a different binary; reusing the recorded
    // verification would publish a false verified result.
    const run = createUpdateRun({ trigger: "api", target: { version: "2.0.0" } });
    recordUpdateRunPhase(run.runId, "restarting");
    recordUpdateRunPhase(run.runId, "verifying", { after: {} });
    recordUpdateRunVerification(run.runId, {
      serviceRunning: true,
      runningVersion: restoredVersion,
      runningBuildId: "build-restored",
      versionMatch: true,
      settled: true,
      channelsReady: true,
      pluginErrors: [],
    });
    const payload = buildUpdateRestartSentinelPayload({
      result: {
        status: "error",
        mode: "npm",
        reason: "managed-service-handoff-failed",
        steps: [],
        durationMs: 1,
      },
      meta: { runId: run.runId, handoffId: "managed-update-handoff" },
    });
    const observed = await finalizeRestartUpdateRun(payload, true);
    expect(observed?.verification.versionMatch).toBe(false);
    expect(observed?.verification.runningVersion).toBe(restoredVersion);
  });

  it("regrades a restored-version boot whose build cannot be resolved when a build was recorded", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", directories.make("update-managed-restore-build-missing-"));
    const restoredVersion = "1.2.3";
    vi.stubEnv("OPENCLAW_VERSION", restoredVersion);
    runtimeBuildId = null;
    const run = createUpdateRun({ trigger: "api", target: { version: "2.0.0" } });
    recordUpdateRunPhase(run.runId, "restarting");
    recordUpdateRunPhase(run.runId, "verifying", { after: {} });
    recordUpdateRunVerification(run.runId, {
      serviceRunning: true,
      runningVersion: restoredVersion,
      runningBuildId: "build-restored",
      versionMatch: true,
      settled: true,
      channelsReady: true,
      pluginErrors: [],
    });
    const payload = buildUpdateRestartSentinelPayload({
      result: {
        status: "error",
        mode: "npm",
        reason: "managed-service-handoff-failed",
        steps: [],
        durationMs: 1,
      },
      meta: { runId: run.runId, handoffId: "managed-update-handoff" },
    });
    const observed = await finalizeRestartUpdateRun(payload, true);
    expect(observed?.verification.versionMatch).toBe(false);
  });

  it("reuses a restored-version verification recorded without build identity", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", directories.make("update-managed-restore-build-unrecorded-"));
    const restoredVersion = "1.2.3";
    vi.stubEnv("OPENCLAW_VERSION", restoredVersion);
    runtimeBuildId = "build-other";
    // The recorder never learned the restored build, so no stronger identity
    // check is possible; version equality is all the verification recorded.
    const run = createUpdateRun({ trigger: "api", target: { version: "2.0.0" } });
    recordUpdateRunPhase(run.runId, "restarting");
    recordUpdateRunPhase(run.runId, "verifying", { after: {} });
    recordUpdateRunVerification(run.runId, {
      serviceRunning: true,
      runningVersion: restoredVersion,
      versionMatch: true,
      settled: true,
      channelsReady: true,
      pluginErrors: [],
    });
    const payload = buildUpdateRestartSentinelPayload({
      result: {
        status: "error",
        mode: "npm",
        reason: "managed-service-handoff-failed",
        steps: [],
        durationMs: 1,
      },
      meta: { runId: run.runId, handoffId: "managed-update-handoff" },
    });
    const observed = await finalizeRestartUpdateRun(payload, true);
    expect(observed?.verification.versionMatch).toBe(true);
  });

  it("keeps ordinary expected-build checks when target verification already succeeded", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", directories.make("update-ordinary-build-check-"));
    const version = resolveRuntimeServiceVersion();
    runtimeBuildId = "build-running";
    // after.version is set, so target verification succeeded: the recorded
    // versionMatch is an ordinary verification, not a restore, and the
    // expected build must still be enforced even for the same binary.
    const run = createUpdateRun({ trigger: "api", target: { version } });
    recordUpdateRunPhase(run.runId, "restarting");
    recordUpdateRunPhase(run.runId, "verifying", {
      after: { version, buildId: "build-expected" },
    });
    recordUpdateRunVerification(run.runId, {
      serviceRunning: true,
      runningVersion: version,
      runningBuildId: "build-running",
      versionMatch: true,
    });
    const payload = buildUpdateRestartSentinelPayload({
      result: { status: "ok", mode: "npm", after: { version }, steps: [], durationMs: 1 },
      meta: { runId: run.runId },
    });
    const observed = await finalizeRestartUpdateRun(payload);
    expect(observed?.verification.versionMatch).toBe(false);
  });

  it("fails an expired unmanaged pending restart", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", directories.make("update-unmanaged-expiry-"));
    const run = createUpdateRun({ trigger: "api" });
    recordUpdateRunPhase(run.runId, "restarting");
    expect(
      await finalizeRestartUpdateRun(
        {
          kind: "update",
          status: "skipped",
          ts: Date.now(),
          stats: { runId: run.runId, reason: "restart-health-pending" },
        },
        true,
      ),
    ).toMatchObject({ status: "failed", phase: "finished", reason: "restart-unhealthy" });
  });

  it.each([
    "requested",
    "staging",
    "validating",
    "repairing",
    "activating",
    "restarting",
    "verifying",
  ] as const)("does not let sentinel expiry finish the orchestrator during %s", async (phase) => {
    vi.stubEnv("OPENCLAW_STATE_DIR", directories.make("update-boot-owner-"));
    const run = createUpdateRun({
      trigger: "cli",
      target: { version: resolveRuntimeServiceVersion() },
    });
    recordUpdateRunPhase(run.runId, phase);
    const observed = await finalizeRestartUpdateRun(
      {
        kind: "update",
        status: "skipped",
        ts: Date.now(),
        stats: { runId: run.runId, reason: "restart-health-pending" },
      },
      true,
    );
    expect(observed).toMatchObject({
      status: "running",
      phase: phase === "restarting" ? "verifying" : phase,
      confirmedAtMs: null,
      verification: { booted: true },
    });
  });
});
