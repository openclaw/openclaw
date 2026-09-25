import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { note } from "../../../packages/terminal-core/src/note.js";
import { noteStaleUpdateRuns } from "../../commands/doctor-update-run.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import * as temporaryState from "../../infra/tmp-openclaw-dir.js";
import { readUpdateRunDriver } from "../../infra/update-run-driver.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  listUpdateRuns,
  recordUpdateRunPhase,
  recordUpdateRunStep,
} from "../../infra/update-run-ledger.js";
import { isAcknowledgedAbandonedUpdateRun } from "../../infra/update-run-record.js";
import { ABANDONED_UPDATE_RUN_MS } from "../../infra/update-run-timeouts.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveOpenClawStateSqliteDir } from "../../state/openclaw-state-db.paths.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { ProducedPluginUpdateResult } from "./update-command-plugins-internals.js";
import { updateRepairCommand } from "./update-repair-command.js";

const mocks = vi.hoisted(() => ({
  root: vi.fn(),
  doctor: vi.fn(),
  plugins: vi.fn(),
  convergence: vi.fn(),
}));
vi.mock("../../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));
vi.mock("./shared.js", async (original) => ({
  ...(await original<typeof import("./shared.js")>()),
  resolveUpdateRoot: mocks.root,
  tryWriteCompletionCache: async () => "skipped",
}));
vi.mock("./update-command-plugins.js", () => ({ updatePluginsAfterCoreUpdate: mocks.plugins }));
vi.mock("./update-command-fresh-doctor.js", async (original) => ({
  ...(await original<typeof import("./update-command-fresh-doctor.js")>()),
  runUpdateFinalizationDoctorInFreshProcess: mocks.doctor,
  completePostCorePluginUpdate: mocks.convergence,
}));
// Service and subprocess effects are covered by update-command-lease.test.ts.
// Keep public selection, finalization, SQLite, leases, and Doctor history reads real.
vi.mock("../../commands/doctor-maintenance.js", () => ({
  beginDoctorMaintenance: async () => undefined,
}));
vi.mock("../daemon-cli/restart-health-probe.js", () => ({
  resolveGatewayRestartProbeContext: async () => ({ config: {} }),
  confirmGatewayReachable: async () => ({ reachable: false }),
  waitForGatewayHttpReadiness: async () => ({ healthz: 503, readyz: 503 }),
}));
vi.mock("../../infra/update-triage.js", () => ({
  prepareUpdateFailureTriage: async () => async () => ({ status: "completed", hint: "" }),
}));

const pluginResult: ProducedPluginUpdateResult = {
  assessment: { kind: "no-payload-repair" },
  status: "ok",
  changed: false,
  sync: { changed: false, switchedToBundled: [], switchedToNpm: [], warnings: [], errors: [] },
  npm: { changed: false, outcomes: [] },
  integrityDrifts: [],
};
let state: OpenClawTestState;

beforeEach(async () => {
  vi.clearAllMocks();
  state = await createOpenClawTestState({
    label: "repair-history",
    env: { OPENCLAW_UPDATE_RUN_ID: undefined },
  });
  const control = state.path("control");
  await fs.mkdir(control, { mode: 0o700 });
  vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
  await state.writeConfig({ plugins: { enabled: false }, update: { channel: "stable" } });
  await fs.writeFile(state.path("package.json"), JSON.stringify({ version: "1.0.0" }));
  mocks.root.mockResolvedValue(state.root);
  mocks.doctor.mockReset().mockResolvedValue(undefined);
  mocks.plugins.mockReset().mockResolvedValue(pluginResult);
  mocks.convergence.mockReset().mockImplementation(async ({ pluginUpdate }) => ({
    pluginUpdate,
    configSnapshot: await readConfigFileSnapshot({ skipPluginValidation: true }),
  }));
  for (const method of ["log", "error", "writeJson"] as const) {
    vi.spyOn(defaultRuntime, method).mockImplementation(() => undefined);
  }
  vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await state.cleanup();
});

function seedHistory(ageMs: number, reason = "abandoned") {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() - ageMs);
  try {
    const run = createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } });
    recordUpdateRunStep(run.runId, {
      step: "preflight",
      status: "failed",
      detail: "Original failure",
    });
    return finishUpdateRun(run.runId, { status: "failed", reason });
  } finally {
    clock.mockRestore();
  }
}
async function repair() {
  await updateRepairCommand({ json: true, yes: true, timeout: "15", deferCompletionCache: true });
}
async function abandonedWarnings() {
  vi.mocked(note).mockClear();
  await noteStaleUpdateRuns({ migrateState: false });
  return vi
    .mocked(note)
    .mock.calls.flatMap(([message]) =>
      typeof message === "string" && message.includes("remains abandoned") ? [message] : [],
    );
}

// Existing selector tests replace finalization; finalizer tests pass hand-selected IDs.
// These cases must fail if the public command drops historical terminal candidates.
describe("public repair historical acknowledgment", () => {
  it.each([
    { age: 2 * ABANDONED_UPDATE_RUN_MS, newer: false },
    { age: 2 * ABANDONED_UPDATE_RUN_MS, newer: true },
    { age: 60_000, newer: true },
  ])(
    "clears Doctor warnings after full repair (age=$age, newer=$newer)",
    async ({ age, newer }) => {
      const previous = seedHistory(age);
      if (newer) {
        const latest = createUpdateRun({ trigger: "cli" });
        finishUpdateRun(latest.runId, { status: "succeeded" });
      }
      expect(await abandonedWarnings()).toHaveLength(1);
      await repair();
      expect(mocks.doctor).toHaveBeenCalledOnce();
      expect(mocks.plugins).toHaveBeenCalledOnce();
      const repaired = getUpdateRun(previous.runId)!;
      expect(isAcknowledgedAbandonedUpdateRun(repaired)).toBe(true);
      expect(repaired).toMatchObject({
        ...previous,
        updatedAtMs: expect.any(Number),
        steps: expect.arrayContaining(previous.steps),
      });
      expect(defaultRuntime.writeJson).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: "ok", reconciledRuns: [previous.runId] }),
      );
      expect(await abandonedWarnings()).toEqual([]);
      await repair();
      expect(getUpdateRun(previous.runId)).toEqual(repaired);
      expect(mocks.doctor).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["ok", "warning"] as const)(
    "acknowledges multiple rows only after %s convergence, excluding a newly admitted row",
    async (status) => {
      const old = seedHistory(4 * ABANDONED_UPDATE_RUN_MS);
      const recent = seedHistory(60_000);
      const unrelated = seedHistory(30_000, "doctor-failed");
      let admitted: ReturnType<typeof seedHistory> | undefined;
      mocks.plugins.mockImplementationOnce(async () => {
        expect(getUpdateRun(old.runId)).toEqual(old);
        expect(getUpdateRun(recent.runId)).toEqual(recent);
        admitted = seedHistory(0);
        return { ...pluginResult, status };
      });
      await repair();
      for (const run of [old, recent]) {
        expect(isAcknowledgedAbandonedUpdateRun(getUpdateRun(run.runId)!)).toBe(true);
      }
      expect(getUpdateRun(unrelated.runId)).toEqual(unrelated);
      expect(getUpdateRun(admitted!.runId)).toEqual(admitted);
      const result = vi.mocked(defaultRuntime.writeJson).mock.lastCall?.[0];
      expect(result).toMatchObject({ status, reconciledRuns: [recent.runId, old.runId] });
      expect(await abandonedWarnings()).toEqual([expect.stringContaining(admitted!.runId)]);
    },
  );

  it.each(["doctor", "convergence", "error"])(
    "preserves history when repair fails in %s",
    async (phase) => {
      const old = seedHistory(4 * ABANDONED_UPDATE_RUN_MS);
      const recent = seedHistory(60_000);
      if (phase === "doctor") {
        mocks.doctor.mockRejectedValueOnce(new Error("Doctor failed"));
      } else if (phase === "convergence") {
        mocks.convergence.mockRejectedValueOnce(new Error("Convergence failed"));
      } else {
        mocks.plugins.mockResolvedValueOnce({ ...pluginResult, status: "error" });
      }
      await expect(repair()).rejects.toThrow();
      expect(getUpdateRun(old.runId)).toEqual(old);
      expect(getUpdateRun(recent.runId)).toEqual(recent);
      expect(await abandonedWarnings()).toHaveLength(2);
    },
  );

  it.each(["live", "unobservable"])(
    "preserves history while an unrelated driver is %s",
    async (liveness) => {
      const old = seedHistory(4 * ABANDONED_UPDATE_RUN_MS);
      const driver = readUpdateRunDriver();
      expect(driver).toBeDefined();
      createUpdateRun({
        trigger: "cli",
        origin: {
          driver: {
            ...driver!,
            ...(liveness === "unobservable" ? { host: "other-host.invalid" } : {}),
          },
        },
      });
      await expect(repair()).rejects.toThrow("remains recorded as running");
      expect(getUpdateRun(old.runId)).toEqual(old);
      expect(mocks.doctor).not.toHaveBeenCalled();
    },
  );

  it("retains the hundredth captured row when finalization creates a newer run", async () => {
    const outside = seedHistory(10 * ABANDONED_UPDATE_RUN_MS);
    const boundary = seedHistory(9 * ABANDONED_UPDATE_RUN_MS);
    for (let index = 0; index < 99; index++) {
      const run = createUpdateRun({ trigger: "cli" });
      finishUpdateRun(run.runId, { status: "succeeded" });
    }
    expect(listUpdateRuns({ limit: 100 }).at(-1)?.runId).toBe(boundary.runId);
    expect(await abandonedWarnings()).toEqual([expect.stringContaining(boundary.runId)]);
    await repair();
    expect(isAcknowledgedAbandonedUpdateRun(getUpdateRun(boundary.runId)!)).toBe(true);
    expect(getUpdateRun(outside.runId)).toEqual(outside);
    expect(defaultRuntime.writeJson).toHaveBeenLastCalledWith(
      expect.objectContaining({ reconciledRuns: [boundary.runId] }),
    );
  });

  it("acknowledges historical rows while continuing its live owning update", async () => {
    const old = seedHistory(4 * ABANDONED_UPDATE_RUN_MS);
    const driver = readUpdateRunDriver();
    expect(driver).toBeDefined();
    const owner = createUpdateRun({ trigger: "cli", origin: { driver } });
    vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", owner.runId);

    await repair();

    expect(isAcknowledgedAbandonedUpdateRun(getUpdateRun(old.runId)!)).toBe(true);
    expect(getUpdateRun(owner.runId)?.status).toBe("running");
    expect(defaultRuntime.writeJson).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "ok", reconciledRuns: [old.runId] }),
    );
    expect(await abandonedWarnings()).toEqual([]);
  });

  it("preserves historical rows when retained recovery blocks finalization", async () => {
    const old = seedHistory(4 * ABANDONED_UPDATE_RUN_MS);
    await fs.mkdir(path.join(resolveOpenClawStateSqliteDir(), ".openclaw-restore-retained"));

    await expect(repair()).rejects.toThrow("full-state recovery is deferred");

    expect(getUpdateRun(old.runId)).toEqual(old);
    expect(mocks.doctor).not.toHaveBeenCalled();
  });

  it("does not acknowledge terminal history if a captured active run remains unresolved", async () => {
    const old = seedHistory(4 * ABANDONED_UPDATE_RUN_MS);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() - 2 * ABANDONED_UPDATE_RUN_MS);
    const active = createUpdateRun({ trigger: "cli" });
    recordUpdateRunPhase(active.runId, "verifying");
    clock.mockRestore();
    mocks.plugins.mockImplementationOnce(async () => {
      recordUpdateRunStep(active.runId, {
        step: "build",
        status: "in_progress",
        startedAtMs: Date.now(),
      });
      return pluginResult;
    });
    await expect(repair()).rejects.toThrow("did not assume the update resumed");
    expect(getUpdateRun(old.runId)).toEqual(old);
    expect(getUpdateRun(active.runId)?.status).toBe("running");
    expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
  });
});
