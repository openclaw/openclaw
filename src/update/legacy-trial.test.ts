import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  withUpdateCommandExecutor,
  withDelegatedUpdateCommandExecutor,
} from "../cli/update-cli/update-command-executor.js";
import { execFileUtf8 } from "../daemon/exec-file.js";
import { withGatewayServiceUpdateAuthority } from "../daemon/service-update-authority.js";
import { TICK_INTERVAL_MS } from "../gateway/server-constants.js";
import { createPreparedReadinessFixture } from "../gateway/server/readiness.test-support.js";
import * as tempRoot from "../infra/tmp-openclaw-dir.js";
import { deadDriverFixture } from "../infra/update-run-fixture.test-support.js";
import { persistInterruptedUpdateObservationAsync } from "../infra/update-run-interruption-worker.js";
import { getUpdateRunAsync } from "../infra/update-run-reader.js";
import { reconcileAbandonedUpdateRunsAsync } from "../infra/update-run-reconciliation.js";
import type { UpdateRunRecord } from "../infra/update-run-record.js";
import {
  createUpdateRunAsync,
  finishUpdateRunAsync,
  recordUpdateRunPhaseAsync,
  recordUpdateRunStepAsync,
} from "../infra/update-run-write.async.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { VERSION } from "../version.js";
import { announceReady } from "./gateway-trial.js";
import { prepareLegacyTrialRun } from "./legacy-trial.js";
import { prepareUpdateRepairHistory } from "./repair-history.js";
import { resolvePrefix } from "./store.js";

const startupRoot = vi.hoisted(() => ({ value: "" }));
vi.mock("../infra/openclaw-root.js", async (original) => ({
  ...(await original<typeof import("../infra/openclaw-root.js")>()),
  resolveOpenClawPackageRootSync: () => startupRoot.value,
}));

vi.mock("../version.js", async (original) => ({
  ...(await original<typeof import("../version.js")>()),
  resolveRuntimeServiceBuildId: () => "legacy-candidate-build",
}));
vi.mock("../infra/update-run-interruption-health.js", async (original) => ({
  ...(await original<typeof import("../infra/update-run-interruption-health.js")>()),
  observeInterruptedUpdateGateway: async () => ({
    outcome: "unverified",
    elapsedMs: 0,
    phase: "health",
  }),
}));
const directories: string[] = [];
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of directories.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function fixture() {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "legacy-trial-"));
  directories.push(state);
  vi.stubEnv("OPENCLAW_STATE_DIR", state);
  vi.stubEnv("OPENCLAW_LAUNCHER_IPC", "");
  openOpenClawStateDatabase();
  const prefix = resolvePrefix();
  const root = path.join(prefix, "releases", "exact-candidate", "openclaw");
  await fs.mkdir(root, { recursive: true });
  await fs.symlink(root, path.join(prefix, "openclaw"), "junction");
  const trial = {
    target: "releases/exact-candidate/openclaw",
    previous: "releases/previous/openclaw",
    version: VERSION,
    buildId: "legacy-candidate-build",
    createdAt: Date.now(),
    attempts: 1,
  };
  const file = path.join(prefix, "releases", ".trial");
  await fs.writeFile(file, JSON.stringify(trial));
  const run = await createUpdateRunAsync({
    trigger: "cli",
    target: { kind: "git" },
    origin: { driver: deadDriverFixture().dead },
  });
  await recordUpdateRunPhaseAsync(run.runId, "restarting");
  return { root, file, trial, runId: run.runId };
}

it.each(["repairing", "restarting"] as const)(
  "does not correlate a Git-targeted repair during %s with the original activation",
  async (phase) => {
    const f = await fixture();
    const repair = await createUpdateRunAsync({ trigger: "cli", target: { kind: "git" } });
    await recordUpdateRunPhaseAsync(repair.runId, "repairing");
    await recordUpdateRunPhaseAsync(repair.runId, phase);
    const before = await getUpdateRunAsync(repair.runId);
    await prepareLegacyTrialRun(repair.runId, f.root, () => {});
    expect(await getUpdateRunAsync(repair.runId)).toEqual(before);
    await prepareLegacyTrialRun(f.runId, f.root, () => {});
    await announceReady(f.trial.buildId, f.root);
    expect((await getUpdateRunAsync(f.runId))?.steps).toContainEqual(
      expect.objectContaining({ step: "finalize:legacy-release-ready", status: "completed" }),
    );
  },
);

it("keeps the admitted activation ledger across asynchronous trial discovery", async () => {
  const f = await fixture();
  const original = { env: { ...process.env } };
  const foreignState = path.join(path.dirname(resolvePrefix()), "other-profile");
  const foreign = { env: { ...process.env, OPENCLAW_STATE_DIR: foreignState } };
  await createUpdateRunAsync({ runId: f.runId, trigger: "cli", target: { kind: "git" } }, foreign);
  await recordUpdateRunPhaseAsync(f.runId, "restarting", {}, foreign);
  const before = await getUpdateRunAsync(f.runId, foreign);
  const read = fs.readFile;
  vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
    const bytes = await read(...args);
    if (args[0] === f.file) {
      vi.stubEnv("OPENCLAW_STATE_DIR", foreignState);
    }
    return bytes;
  });
  await prepareLegacyTrialRun(f.runId, f.root, () => {});
  expect((await getUpdateRunAsync(f.runId, original))?.steps).toContainEqual(
    expect.objectContaining({ step: "finalize:legacy-release-prepared", status: "completed" }),
  );
  expect(await getUpdateRunAsync(f.runId, foreign)).toEqual(before);
});

it.each(["missing", "repair", "invalid-grant"] as const)(
  "keeps independently authorized native restoration separate from %s correlation",
  async (kind) => {
    const f = await fixture();
    const control = path.join(path.dirname(resolvePrefix()), "control");
    await fs.mkdir(control, { mode: 0o700 });
    vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
    const repair = await createUpdateRunAsync({ trigger: "cli", target: { kind: "git" } });
    await recordUpdateRunPhaseAsync(repair.runId, "repairing");
    const runId = kind === "missing" ? "missing-original-update" : repair.runId;
    const effect = path.join(control, "restored-service");
    const restore = async (fence: { assertCurrent: () => void }) =>
      withGatewayServiceUpdateAuthority(fence.assertCurrent, async () => {
        await prepareLegacyTrialRun(runId, f.root, fence.assertCurrent);
        const command = await execFileUtf8(process.execPath, [
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(effect)}, "restored")`,
        ]);
        expect(command.code, command.stderr).toBe(0);
      });
    if (kind === "invalid-grant") {
      await expect(withDelegatedUpdateCommandExecutor({}, runId, f.root, restore)).rejects.toThrow(
        "Candidate executor grant is malformed",
      );
      await expect(fs.stat(effect)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      const before = await getUpdateRunAsync(repair.runId);
      await withUpdateCommandExecutor(runId, async (executor) =>
        restore(await executor.enter(f.root)),
      );
      expect(await fs.readFile(effect, "utf8")).toBe("restored");
      expect(await getUpdateRunAsync(repair.runId)).toEqual(before);
    }
  },
);

it.each(["sidecars", "methods"] as const)(
  "records the legacy ready receipt before repair four seconds after verified %s startup",
  async (boundary) => {
    const f = await fixture();
    await prepareLegacyTrialRun(f.runId, f.root, () => {});
    startupRoot.value = f.root;
    vi.resetModules();
    const owner = await import("../gateway/stale-install.js");
    const { createGatewayReadyAnnouncer, logGatewayReady } =
      await import("../gateway/server-startup-readiness.js");
    const dispose = owner.registerGatewayInstallationReplacementHandler(() => {});
    const clock = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(clock.clock);
    let maintenanceTicks = 0;
    scheduler.schedule({
      id: "installation",
      delayMs: TICK_INTERVAL_MS,
      run: async () => {
        maintenanceTicks++;
        await owner.checkGatewayInstallationReplacement();
      },
    });
    let healthy = false;
    const params = {
      getReadiness: createPreparedReadinessFixture(() => ({
        ready: healthy,
        coreReady: healthy,
        failing: healthy ? [] : ["core-startup"],
        uptimeMs: clock.clock.now(),
      })),
      log: { info: vi.fn() },
      isChatSendAvailable: () => true,
      areSidecarsReady: () => true,
      startupTrace: {
        mark: vi.fn(),
        detail: vi.fn(),
        measure: async <T>(_name: string, run: () => T | Promise<T>) => await run(),
      },
    };
    const ready =
      boundary === "methods" ? createGatewayReadyAnnouncer(params) : () => logGatewayReady(params);
    try {
      await ready();
      expect(await fs.readFile(f.file, "utf8")).toBe(JSON.stringify(f.trial));
      healthy = true;
      await ready();
      await clock.advanceBy(4000);
      expect(maintenanceTicks).toBe(0);
      expect((await getUpdateRunAsync(f.runId))?.steps).toContainEqual(
        expect.objectContaining({ step: "finalize:legacy-release-ready", status: "completed" }),
      );
      await expect(fs.stat(f.file)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      dispose();
      await scheduler.stop();
    }
  },
);

it.each([false, true])(
  "ends a healthy old-launcher trial without claiming unfinished update success (driver already reconciled=%s)",
  async (abandoned) => {
    const f = await fixture();
    await prepareLegacyTrialRun(f.runId, f.root, () => {});
    expect((await getUpdateRunAsync(f.runId))?.after).toEqual({});
    if (abandoned) {
      await reconcileAbandonedUpdateRunsAsync({ runIds: [f.runId] });
    }
    await announceReady(f.trial.buildId, f.root);
    await expect(fs.stat(f.file)).rejects.toMatchObject({ code: "ENOENT" });
    const run = await getUpdateRunAsync(f.runId);
    expect(run?.status).toBe(abandoned ? "failed" : "running");
    expect(run?.steps).toContainEqual(
      expect.objectContaining({
        step: "finalize:legacy-release-ready",
        status: "completed",
      }),
    );
  },
);

it.each(["modern", "wrong-build", "wrong-root", "restoring", "pending"])(
  "leaves a %s trial with its owner",
  async (kind) => {
    const f = await fixture();
    const bytes = JSON.stringify({
      ...f.trial,
      ...(kind === "modern" ? { v: 2, runId: f.runId, phase: "trial" } : {}),
      ...(kind === "restoring" ? { restoring: [] } : {}),
      ...(kind === "pending" ? { pending: true } : {}),
    });
    await fs.writeFile(f.file, bytes);
    await announceReady(
      kind === "wrong-build" ? "other-build" : f.trial.buildId,
      kind === "wrong-root" ? path.dirname(f.root) : f.root,
    );
    expect(await fs.readFile(f.file, "utf8")).toBe(bytes);
  },
);

it("does not attribute an uncorrelated healthy trial to the newest failed run", async () => {
  const f = await fixture();
  await finishUpdateRunAsync(f.runId, { status: "failed", reason: "abandoned" });
  const before = await getUpdateRunAsync(f.runId);
  await announceReady(f.trial.buildId, f.root);
  await expect(fs.stat(f.file)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await getUpdateRunAsync(f.runId)).toEqual(before);
});

// Worker contract proof, not a full update: maintenance receipts model the existing
// repair owner's completed operations; the upgrade lane must exercise those operations.
it("keeps correlated history selectable when repair cannot verify the serving build", async () => {
  const f = await fixture();
  await prepareLegacyTrialRun(f.runId, f.root, () => {});
  await announceReady(f.trial.buildId, f.root);
  await reconcileAbandonedUpdateRunsAsync({ runIds: [f.runId] });
  const before = await getUpdateRunAsync(f.runId);
  const settle = prepareUpdateRepairHistory([f.runId]);
  const repair = await createUpdateRunAsync({ trigger: "cli" });
  await recordUpdateRunPhaseAsync(repair.runId, "repairing");
  expect(await settle(repair.runId, f.root, true)).toEqual([]);
  expect(await getUpdateRunAsync(f.runId)).toEqual(before);
});

it("does not attribute an ambiguous publication to any matching run", async () => {
  const f = await fixture();
  await prepareLegacyTrialRun(f.runId, f.root, () => {});
  const runIds = [f.runId];
  for (let index = 0; index < 2; index++) {
    const other = await createUpdateRunAsync({ trigger: "cli", target: { kind: "git" } });
    await recordUpdateRunPhaseAsync(other.runId, "restarting");
    await prepareLegacyTrialRun(other.runId, f.root, () => {});
    runIds.push(other.runId);
  }
  const before = await Promise.all(runIds.map((runId) => getUpdateRunAsync(runId)));
  await announceReady(f.trial.buildId, f.root);
  await expect(fs.stat(f.file)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await Promise.all(runIds.map((runId) => getUpdateRunAsync(runId)))).toEqual(before);
});

it.each([
  "complete",
  "complete-oldest-in-long-history",
  "complete-newest-in-long-history",
  "unrelated-failure",
  "live-driver",
  "wrong-candidate",
  "unfinished-maintenance",
  "changed-row",
  "stored-recovery",
])("corrects only the correlated interrupted run after repair (%s)", async (kind) => {
  const f = await fixture();
  const completes = kind.startsWith("complete");
  let historyFailure: UpdateRunRecord | undefined;
  if (kind.endsWith("-in-long-history")) {
    for (let index = 0; index < 100; index++) {
      const other = await createUpdateRunAsync({ trigger: "cli" });
      await finishUpdateRunAsync(other.runId, { status: "failed", reason: "build-failed" });
      if (index === 0) {
        historyFailure = await getUpdateRunAsync(other.runId);
      }
    }
    if (kind === "complete-newest-in-long-history") {
      await finishUpdateRunAsync(f.runId, { status: "failed", reason: "build-failed" });
      const newest = await createUpdateRunAsync({
        trigger: "cli",
        target: { kind: "git" },
        origin: { driver: deadDriverFixture().dead },
      });
      f.runId = newest.runId;
      await recordUpdateRunPhaseAsync(f.runId, "restarting");
    }
  }
  if (kind === "live-driver") {
    await recordUpdateRunPhaseAsync(f.runId, "restarting", {
      origin: { driver: deadDriverFixture().driver },
    });
  }
  await prepareLegacyTrialRun(f.runId, f.root, () => {});
  await announceReady(f.trial.buildId, f.root);
  if (kind === "unrelated-failure") {
    await recordUpdateRunStepAsync(f.runId, {
      step: "plugin install",
      status: "failed",
      detail: "registry refused",
    });
  }
  if (kind !== "live-driver") {
    await reconcileAbandonedUpdateRunsAsync({ runIds: [f.runId] });
  }
  const expected = (await getUpdateRunAsync(f.runId))!;
  const unrelated = await createUpdateRunAsync({ trigger: "cli" });
  await finishUpdateRunAsync(unrelated.runId, { status: "failed", reason: "build-failed" });
  const unrelatedBefore = await getUpdateRunAsync(unrelated.runId);
  const repair = await createUpdateRunAsync({ trigger: "cli" });
  await recordUpdateRunPhaseAsync(repair.runId, "repairing");
  for (const phase of ["doctor", "plugins", "targetConfigConvergence"]) {
    await recordUpdateRunStepAsync(repair.runId, {
      step: `finalize:${phase}`,
      status: kind === "unfinished-maintenance" && phase === "plugins" ? "skipped" : "completed",
    });
  }
  if (kind === "changed-row") {
    await recordUpdateRunStepAsync(f.runId, {
      step: "post-activation doctor inspections",
      status: "completed",
    });
  }
  if (kind === "stored-recovery") {
    const { writeConfigMachineState } = await import("../state/config-machine-state-write.js");
    const { UPDATE_RECOVERY_KEY_PREFIX } = await import("../infra/update-run-recovery-keys.js");
    writeConfigMachineState(UPDATE_RECOVERY_KEY_PREFIX + f.runId, { retained: true });
  }
  const before = await getUpdateRunAsync(f.runId);
  const result = await persistInterruptedUpdateObservationAsync(
    captureOpenClawStateWorkerContext(),
    {
      expected,
      legacyRepairRunId: repair.runId,
      detail: "Repair completed; matching release serves.",
      verification: {
        booted: true,
        serviceRunning: true,
        coreReady: true,
        settled: true,
        versionMatch: true,
        runningVersion: VERSION,
        runningBuildId: kind === "wrong-candidate" ? "different-build" : f.trial.buildId,
      },
    },
  );
  expect(result?.accepted).toBe(completes);
  expect(await getUpdateRunAsync(unrelated.runId)).toEqual(unrelatedBefore);
  if (historyFailure) {
    expect(await getUpdateRunAsync(historyFailure.runId)).toEqual(historyFailure);
  }
  if (completes) {
    expect(await getUpdateRunAsync(f.runId)).toMatchObject({
      status: "succeeded",
      after: { version: VERSION, buildId: f.trial.buildId },
      reason: null,
    });
  } else {
    expect(await getUpdateRunAsync(f.runId)).toEqual(before);
  }
});
