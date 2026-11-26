import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { deadDriverFixture } from "../infra/update-run-fixture.test-support.js";
import { persistInterruptedUpdateObservationAsync } from "../infra/update-run-interruption-worker.js";
import { acknowledgeAbandonedUpdateRun } from "../infra/update-run-ledger.js";
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
import { VERSION } from "../version.js";
import { observeLegacyTrialReadiness } from "./gateway-trial.js";
import { legacyTrialReceipt } from "./legacy-trial-record.js";
import { captureLegacyTrial, prepareLegacyTrialRun } from "./legacy-trial.js";
import { resolvePrefix } from "./store.js";

vi.mock("../version.js", async (original) => ({
  ...(await original<typeof import("../version.js")>()),
  resolveRuntimeServiceBuildId: () => "legacy-candidate-build",
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

async function fixture(nestedSlot = false) {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "legacy-trial-"));
  directories.push(state);
  vi.stubEnv("OPENCLAW_STATE_DIR", state);
  vi.stubEnv("OPENCLAW_LAUNCHER_IPC", "");
  openOpenClawStateDatabase();
  const prefix = resolvePrefix();
  const packagePath = nestedSlot ? path.join("lib", "node_modules", "openclaw") : "openclaw";
  const slot = path.join(prefix, packagePath);
  const root = path.join(prefix, "releases", "exact-candidate", packagePath);
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(path.dirname(slot), { recursive: true });
  await fs.symlink(root, slot, "junction");
  const trial = {
    target: path.relative(path.dirname(slot), root),
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
    expect.objectContaining({ step: legacyTrialReceipt(f.trial).step, status: "completed" }),
  );
  expect(await getUpdateRunAsync(f.runId, foreign)).toEqual(before);
});

it.each(["running", "abandoned", "nested-slot", "complete-oldest-in-long-history"])(
  "automatically completes the exact healthy legacy update after its driver exits (%s)",
  async (kind) => {
    const f = await fixture(kind === "nested-slot");
    let historyFailure: UpdateRunRecord | undefined;
    if (kind.endsWith("-in-long-history")) {
      f.trial.previous = "releases/" + "old-generation/".repeat(80) + "openclaw";
      await fs.writeFile(f.file, JSON.stringify(f.trial));
      for (let index = 0; index < 100; index++) {
        const other = await createUpdateRunAsync({ trigger: "cli" });
        await finishUpdateRunAsync(other.runId, { status: "failed", reason: "build-failed" });
        if (index === 0) {
          historyFailure = await getUpdateRunAsync(other.runId);
        }
      }
    }
    await prepareLegacyTrialRun(f.runId, f.root, () => {});
    expect((await getUpdateRunAsync(f.runId))?.after).toEqual({});
    if (kind === "abandoned") {
      await reconcileAbandonedUpdateRunsAsync({ runIds: [f.runId] });
    }
    const recover = await observeLegacyTrialReadiness(f.trial.buildId, f.root);
    await expect(fs.stat(f.file)).rejects.toMatchObject({ code: "ENOENT" });
    await recover!();
    const run = await getUpdateRunAsync(f.runId);
    if (historyFailure) {
      expect(await getUpdateRunAsync(historyFailure.runId)).toEqual(historyFailure);
    }
    expect(run).toMatchObject({
      status: "succeeded",
      after: { version: VERSION, buildId: f.trial.buildId },
    });
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
    await observeLegacyTrialReadiness(
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
  const recover = await observeLegacyTrialReadiness(f.trial.buildId, f.root);
  await expect(fs.stat(f.file)).rejects.toMatchObject({ code: "ENOENT" });
  await recover!();
  expect(await getUpdateRunAsync(f.runId)).toEqual(before);
});

it("removes the healthy trial while the original updater is still alive", async () => {
  const f = await fixture();
  await recordUpdateRunPhaseAsync(f.runId, "restarting", {
    origin: { driver: deadDriverFixture().driver },
  });
  await prepareLegacyTrialRun(f.runId, f.root, () => {});
  const recover = await observeLegacyTrialReadiness(f.trial.buildId, f.root);
  await expect(fs.stat(f.file)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await recover!()).toBe(false);
  expect(await getUpdateRunAsync(f.runId)).toMatchObject({ status: "running" });
});

it("preserves an abandoned update acknowledged by repair", async () => {
  const f = await fixture();
  await prepareLegacyTrialRun(f.runId, f.root, () => {});
  await reconcileAbandonedUpdateRunsAsync({ runIds: [f.runId] });
  expect(acknowledgeAbandonedUpdateRun(f.runId)).toBe(true);
  const acknowledged = await getUpdateRunAsync(f.runId);
  const recover = await observeLegacyTrialReadiness(f.trial.buildId, f.root);
  await expect(fs.stat(f.file)).rejects.toMatchObject({ code: "ENOENT" });
  await recover!();
  expect(await getUpdateRunAsync(f.runId)).toEqual(acknowledged);
});

it.each(["newer", "older"])(
  "retries history without rearming the trial while a %s active run blocks completion",
  async (order) => {
    const f = await fixture();
    let blockerRunId = f.runId;
    if (order === "older") {
      const current = await createUpdateRunAsync({
        trigger: "cli",
        target: { kind: "git" },
        origin: { driver: deadDriverFixture().dead },
      });
      f.runId = current.runId;
      await recordUpdateRunPhaseAsync(f.runId, "restarting");
    }
    await prepareLegacyTrialRun(f.runId, f.root, () => {});
    if (order === "newer") {
      await reconcileAbandonedUpdateRunsAsync({ runIds: [f.runId] });
      blockerRunId = (await createUpdateRunAsync({ trigger: "cli" })).runId;
    }
    const recover = await observeLegacyTrialReadiness(f.trial.buildId, f.root);
    await expect(fs.stat(f.file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await recover!()).toBe(false);
    expect((await getUpdateRunAsync(f.runId))?.status).toBe(
      order === "older" ? "running" : "failed",
    );
    await finishUpdateRunAsync(blockerRunId, {
      status: "failed",
      reason: "unrelated-fixture-failure",
    });
    const unrelated = await getUpdateRunAsync(blockerRunId);
    expect(await recover!()).toBe(true);
    expect(await getUpdateRunAsync(f.runId)).toMatchObject({
      status: "succeeded",
      after: { version: VERSION, buildId: f.trial.buildId },
    });
    expect(await getUpdateRunAsync(blockerRunId)).toEqual(unrelated);
    await expect(fs.stat(f.file)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

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
  const recover = await observeLegacyTrialReadiness(f.trial.buildId, f.root);
  await expect(fs.stat(f.file)).rejects.toMatchObject({ code: "ENOENT" });
  await recover!();
  expect(await Promise.all(runIds.map((runId) => getUpdateRunAsync(runId)))).toEqual(before);
});

it.each(["unrelated-failure", "wrong-candidate", "stored-recovery"])(
  "completes only the correlated core-ready interrupted run (%s)",
  async (kind) => {
    const f = await fixture();
    await prepareLegacyTrialRun(f.runId, f.root, () => {});
    if (kind === "unrelated-failure") {
      await recordUpdateRunStepAsync(f.runId, {
        step: "plugin install",
        status: "failed",
        detail: "registry refused",
      });
    }
    await reconcileAbandonedUpdateRunsAsync({ runIds: [f.runId] });
    const unrelated = await createUpdateRunAsync({ trigger: "cli" });
    await finishUpdateRunAsync(unrelated.runId, { status: "failed", reason: "build-failed" });
    const unrelatedBefore = await getUpdateRunAsync(unrelated.runId);
    if (kind === "stored-recovery") {
      const { writeConfigMachineState } = await import("../state/config-machine-state-write.js");
      const { UPDATE_RECOVERY_KEY_PREFIX } = await import("../infra/update-run-recovery-keys.js");
      writeConfigMachineState(UPDATE_RECOVERY_KEY_PREFIX + f.runId, { retained: true });
    }
    const before = await getUpdateRunAsync(f.runId);
    const result = await persistInterruptedUpdateObservationAsync(
      captureOpenClawStateWorkerContext(),
      {
        legacyReady: legacyTrialReceipt(f.trial),
        detail: "The matching release is core-ready.",
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
    expect(result?.accepted).toBe(false);
    expect(await getUpdateRunAsync(unrelated.runId)).toEqual(unrelatedBefore);
    expect(await getUpdateRunAsync(f.runId)).toEqual(before);
  },
);

it.each(["replaced-trial", "replaced-build", "invalid-trial"])(
  "rejects captured evidence after its trial or selected build changes (%s)",
  async (kind) => {
    const f = await fixture();
    await prepareLegacyTrialRun(f.runId, f.root, () => {});
    const captured = await captureLegacyTrial(f.root, f.trial.buildId);
    expect(captured).toBeDefined();
    const before = await getUpdateRunAsync(f.runId);
    await fs.rm(f.file);
    if (kind === "replaced-trial") {
      await fs.writeFile(f.file, JSON.stringify({ ...f.trial, createdAt: f.trial.createdAt + 1 }));
    } else if (kind === "replaced-build") {
      const root = path.join(resolvePrefix(), "releases", "other-candidate", "openclaw");
      await fs.mkdir(root, { recursive: true });
      await fs.unlink(path.join(resolvePrefix(), "openclaw"));
      await fs.symlink(root, path.join(resolvePrefix(), "openclaw"), "junction");
    } else if (kind === "invalid-trial") {
      await fs.writeFile(f.file, "{unfinished");
    }
    const bytes = await fs.readFile(f.file, "utf8").catch(() => null);
    const recover = await observeLegacyTrialReadiness(f.trial.buildId, f.root, captured);
    expect(recover).toBeUndefined();
    expect(await getUpdateRunAsync(f.runId)).toEqual(before);
    expect(await fs.readFile(f.file, "utf8").catch(() => null)).toBe(bytes);
  },
);
