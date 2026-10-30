import fs from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import { recordDeferredPluginMigrations } from "../infra/deferred-plugin-migrations.js";
import {
  captureSqliteDatabaseAdmissions,
  retireSqliteDatabaseAdmissionForPath,
} from "../infra/sqlite-database-admission.js";
import { isStaleIdentitylessUpdateRun } from "../infra/update-run-activity.js";
import { readInterruptedUpdateCandidateAsync } from "../infra/update-run-interruption-worker.js";
import { reconcileInterruptedUpdateRuns } from "../infra/update-run-interruption.js";
import {
  createUpdateRun,
  finishUpdateRun,
  recordUpdateRunStep,
} from "../infra/update-run-ledger.js";
import { getUpdateRun, listUpdateRunsAsync } from "../infra/update-run-reader.js";
import type { UpdateRunRecord } from "../infra/update-run-record.js";
import { createUpdateRunRecordFixture } from "../infra/update-run-record.test-support.js";
import { ABANDONED_UPDATE_RUN_MS } from "../infra/update-run-timeouts.js";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import { withOpenClawStateDatabaseReadSnapshot } from "../state/openclaw-state-db-readonly.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";
import { noteStaleUpdateRuns } from "./doctor-update-run.js";

const snapshot = vi.hoisted(() => ({ active: false }));
vi.mock("../state/openclaw-state-db-readonly.js", async (original) => ({
  ...(await original<typeof import("../state/openclaw-state-db-readonly.js")>()),
  withOpenClawStateDatabaseReadSnapshot: vi.fn(async (operation: () => Promise<unknown>) => {
    snapshot.active = true;
    try {
      return await operation();
    } finally {
      snapshot.active = false;
    }
  }),
}));
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));
vi.mock("../infra/update-run-reader.js", async (original) => ({
  ...(await original<typeof import("../infra/update-run-reader.js")>()),
  listUpdateRunsAsync: vi.fn(),
}));
vi.mock("../infra/update-run-interruption.js", async (original) => ({
  ...(await original<typeof import("../infra/update-run-interruption.js")>()),
  reconcileInterruptedUpdateRuns: vi.fn(),
}));
vi.mock("../infra/update-run-interruption-worker.js", () => ({
  readInterruptedUpdateCandidateAsync: vi.fn(),
}));

const listRuns = vi.mocked(listUpdateRunsAsync);
const readCandidate = vi.mocked(readInterruptedUpdateCandidateAsync);
const reconcile = vi.mocked(reconcileInterruptedUpdateRuns);
const readSnapshot = vi.mocked(withOpenClawStateDatabaseReadSnapshot);
const noteMock = vi.mocked(note);

beforeEach(() => {
  reconcile.mockResolvedValue([]);
  readCandidate.mockResolvedValue(undefined);
});
afterEach(() => vi.resetAllMocks());

function runtimeFailure() {
  return Object.assign(new Error("runtime binary not executable: /fixture/node (EACCES)"), {
    code: "EACCES",
  });
}

function recordWarning(runId: string, detail: string, endedAtMs = 1, suffix = "") {
  recordUpdateRunStep(runId, {
    step: `warning:openclaw doctor${suffix}`,
    status: "completed",
    detail,
    endedAtMs,
  });
}

function makeHistory(overrides: Partial<UpdateRunRecord>): UpdateRunRecord {
  return createUpdateRunRecordFixture("interrupted-update", {
    reason: "abandoned",
    ...overrides,
  });
}

function expectHistoryNote(message: string) {
  expect(note).toHaveBeenCalledWith(expect.stringContaining(message), "Update history");
}

it("keeps history read failure advisory without refreshing a running update", async () => {
  await withOpenClawTestState({ label: "update-history-refusal" }, async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() - ABANDONED_UPDATE_RUN_MS - 1);
    let run: UpdateRunRecord;
    try {
      run = createUpdateRun({ trigger: "cli" });
    } finally {
      clock.mockRestore();
    }
    const failure = runtimeFailure();
    readCandidate.mockRejectedValue(failure);
    listRuns.mockRejectedValue(failure);
    await expect(noteStaleUpdateRuns({ migrateState: true })).resolves.toBeUndefined();
    expectHistoryNote(failure.message);
    const saved = getUpdateRun(run.runId)!;
    expect(saved).toEqual({
      ...run,
      steps: expect.arrayContaining([
        expect.objectContaining({
          step: "warning:update-history-reconciliation",
          status: "completed",
          detail: expect.stringContaining(failure.message),
        }),
      ]),
    });
    expect(isStaleIdentitylessUpdateRun(saved)).toBe(true);
  });
});

it("repairs config after update history discovery cannot launch its runtime", async () => {
  const databasePath = await withOpenClawTestState(
    { label: "history-failure-config-repair", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
    async (state) => {
      try {
        await state.writeConfig({
          gateway: { mode: "local", bind: "localhost" },
          plugins: { enabled: false },
        });
        readSnapshot.mockRejectedValueOnce(runtimeFailure());
        const result = await runDoctorConfigPreflight({
          migrateState: false,
          migrateLegacyConfig: false,
          repairPrefixedConfig: true,
        });
        expect(result.snapshot.valid).toBe(true);
        expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toMatchObject({
          gateway: { bind: "loopback" },
        });
        expectHistoryNote("EACCES");
        return state.statePath("state", "openclaw.sqlite");
      } finally {
        // Physical admissions outlive handles; retire this fixture before its files are deleted.
        await state.restoreEnv();
        retireSqliteDatabaseAdmissionForPath(state.statePath("state", "openclaw.sqlite"));
      }
    },
  );
  expect(captureSqliteDatabaseAdmissions().map(({ location }) => location)).not.toContain(
    databasePath,
  );
});

it("keeps a warning visible when the existing history database cannot record it", async () => {
  await withOpenClawTestState({ label: "history-warning-unavailable" }, async (state) => {
    listRuns.mockRejectedValue(new Error("history unavailable"));
    await expect(noteStaleUpdateRuns()).resolves.toBeUndefined();
    expectHistoryNote("history unavailable");
    expectHistoryNote("warning could not be saved");
    await expect(fs.access(state.statePath("state", "openclaw.sqlite"))).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );
  });
});

it("does not admit mutations while a history child still has unsettled process custody", async () => {
  const failure = new CommandProcessCleanupError({
    cause: new Error("child cleanup is unsettled"),
  });
  listRuns.mockRejectedValue(failure);
  await expect(noteStaleUpdateRuns()).rejects.toBe(failure);
});

it("keeps foreign-destination remediation visible until a later successful update", async () => {
  let latest = makeHistory({
    runId: "6631ecee-adbf-41e8-a0e3-1b88b28b0a59",
    reason: "global-install-foreign-destination",
    target: { kind: "package", version: "2026.9.4" },
    before: { version: "2026.7.1-2" },
    steps: [{ step: "global-install-foreign-destination", status: "failed" }],
  });
  listRuns.mockImplementation(async (input) => (input?.active ? [] : [latest]));
  readCandidate.mockResolvedValue(latest);
  await noteStaleUpdateRuns({});
  expect(note).toHaveBeenCalledOnce();
  expectHistoryNote("OpenClaw update failed: global-install-foreign-destination.");
  expectHistoryNote(
    "https://docs.openclaw.ai/install/update-troubleshooting#node-and-global-install-permissions",
  );

  latest = {
    ...latest,
    status: "succeeded",
    reason: null,
    steps: [],
  };
  noteMock.mockClear();
  await noteStaleUpdateRuns({});
  expect(note).not.toHaveBeenCalled();
});

it("refreshes history outside the discovery snapshot after settling an interrupted update", async () => {
  const abandoned = makeHistory({});
  const settled: UpdateRunRecord = {
    ...abandoned,
    status: "succeeded",
    reason: null,
    after: { buildId: "candidate-build" },
  };
  readCandidate.mockResolvedValue(abandoned);
  reconcile.mockImplementation(async () => {
    expect(snapshot.active).toBe(false);
    return [settled];
  });
  const readScopes: boolean[] = [];
  listRuns.mockImplementation(async (input) => {
    readScopes.push(snapshot.active);
    return snapshot.active ? [abandoned] : input?.active ? [] : [settled];
  });
  await noteStaleUpdateRuns();
  expect(readScopes).toEqual([true, true, false, false]);
  expect(note).toHaveBeenCalledExactlyOnceWith(
    "Update interrupted-update: recorded succeeded after verifying the installed and serving candidate build candidate-build; its updater exited before recording completion.",
    "Update history",
  );
});

it("stops replaying resolved state migration warnings without erasing history", async () => {
  await withOpenClawTestState({ label: "update-warning-resolution" }, async () => {
    const pending = (pluginId: string) => ({
      pluginId,
      reason: "The plugin has not reported completion.",
      command: "openclaw doctor --fix",
    });
    await recordDeferredPluginMigrations({
      pending: [pending("resolved"), pending("unfinished")],
    });
    const warnings = [
      'Plugin "unrecorded" state migration is pending: Completion has never been recorded.',
      'Plugin "unfinished" state migration is pending: The plugin has not reported completion.',
      "Unrelated update warning",
      'Plugin "resolved" state migration is pending: The plugin has not reported completion.',
    ] as const;
    const run = createUpdateRun({ trigger: "cli" });
    for (const [index, detail] of warnings.entries()) {
      recordWarning(run.runId, detail, 1, `:${index}`);
    }
    const history = finishUpdateRun(run.runId, { status: "succeeded" });
    let latestRunId = run.runId;
    listRuns.mockImplementation(async (input) =>
      input?.active ? [] : [getUpdateRun(latestRunId)!],
    );
    const output = async () => {
      noteMock.mockClear();
      await noteStaleUpdateRuns({ migrateState: false });
      return noteMock.mock.calls.map(([message]) => message).join("\n");
    };
    expect(await output()).toContain(warnings[3]);
    await recordDeferredPluginMigrations({ pending: [], resolvedPluginIds: ["resolved"] });
    const repaired = await output();
    expect(repaired).not.toContain(warnings[3]);
    expect(repaired).not.toContain(warnings[0]);
    for (const warning of warnings.slice(1, 3)) {
      expect(repaired).toContain(warning);
    }
    expect(getUpdateRun(run.runId)).toEqual(history);
    await recordDeferredPluginMigrations({ pending: [pending("resolved")] });
    expect(await output()).toContain(warnings[3]);
    expect(getUpdateRun(run.runId)).toEqual(history);
    await recordDeferredPluginMigrations({ pending: [], resolvedPluginIds: ["resolved"] });
    const later = createUpdateRun({ trigger: "cli" });
    recordWarning(later.runId, warnings[3], Date.now() + 60_000);
    const laterHistory = finishUpdateRun(later.runId, { status: "succeeded" });
    latestRunId = later.runId;
    expect(await output()).not.toContain(warnings[3]);
    expect(getUpdateRun(later.runId)).toEqual(laterHistory);
  });
});

it.each(["completed", "skipped", undefined] as const)(
  "uses the selected historical run's model retirement receipt (%s)",
  async (status) => {
    await withOpenClawTestState({ label: "model-retirement-history" }, async () => {
      const warning = "Model retirement deferred until configured plugin installation converges.";
      const run = createUpdateRun({ trigger: "cli" });
      recordWarning(run.runId, warning);
      recordWarning(run.runId, "Unrelated update warning", 2, ":unrelated");
      if (status) {
        recordUpdateRunStep(run.runId, { step: "finalize:doctor:model-retirement", status });
      }
      const history = finishUpdateRun(run.runId, { status: "succeeded" });
      // Another run's completion must not settle the selected history's warning.
      const active = createUpdateRun({ trigger: "cli" });
      recordUpdateRunStep(active.runId, {
        step: "finalize:doctor:model-retirement",
        status: "completed",
      });
      listRuns.mockImplementation(async (input) => (input?.active ? [active] : [history!]));

      await noteStaleUpdateRuns({ migrateState: false });

      const output = noteMock.mock.calls.map(([message]) => message).join("\n");
      expect(output.includes(warning)).toBe(status !== "completed");
      expect(output).toContain("Unrelated update warning");
      expect(getUpdateRun(run.runId)).toEqual(history);
    });
  },
);
