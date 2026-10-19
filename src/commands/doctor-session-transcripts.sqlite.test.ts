import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreparedPostSessionPluginMigration } from "../infra/state-migrations.types.js";

const note = vi.hoisted(() => vi.fn());
const repairReservedIncognitoSessionKeys = vi.hoisted(() => vi.fn());
const repairCanonicalSessionDeliveryStates = vi.hoisted(() => vi.fn());
const repairCanonicalSessionResolvedSkills = vi.hoisted(() => vi.fn());
const repairCanonicalSessionKeys = vi.hoisted(() => vi.fn());
const repairLegacySessionWorktreeWorkspaces = vi.hoisted(() => vi.fn());
const migrateLegacyMainSessionKeys = vi.hoisted(() => vi.fn());
const runDoctorSessionSqlite = vi.hoisted(() => vi.fn());
const hasRetainedDoctorSessionSources = vi.hoisted(() => vi.fn());
const settleRetainedDoctorSessionSources = vi.hoisted(() => vi.fn());
const withDoctorSqliteMaintenanceLock = vi.hoisted(() => vi.fn());
const runPostSessionPluginDoctorStateRepairs = vi.hoisted(() => vi.fn());

// mock-isolation: capture Doctor notes without rendering terminal output.
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

vi.mock("./doctor-session-sqlite.js", () => ({
  hasRetainedDoctorSessionSources,
  runDoctorSessionSqlite,
  settleRetainedDoctorSessionSources,
}));

vi.mock("../infra/state-migrations.plugin-doctor.js", () => ({
  runPostSessionPluginDoctorStateRepairs,
}));

// mock-isolation: observe repair ordering without mutating session state.
vi.mock("./doctor-session-incognito-key-repair.js", () => ({ repairReservedIncognitoSessionKeys }));

vi.mock("./doctor-session-delivery-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./doctor-session-delivery-state.js")>();
  return {
    ...actual,
    repairCanonicalSessionDeliveryStates,
    repairCanonicalSessionResolvedSkills,
  };
});

vi.mock("./doctor-session-exec-policy.js", () => ({
  repairLegacySessionExecPolicy: vi.fn(),
}));

// mock-isolation: observe repair ordering without mutating canonical session keys.
vi.mock("./doctor-session-canonical-keys.js", () => ({ repairCanonicalSessionKeys }));

vi.mock("./doctor-session-worktree-workspace.js", () => ({
  repairLegacySessionWorktreeWorkspaces,
}));

vi.mock("../config/sessions/legacy-main-session-migration.js", () => ({
  migrateLegacyMainSessionKeys,
}));

vi.mock("./doctor-sqlite-maintenance-lock.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./doctor-sqlite-maintenance-lock.js")>();
  return {
    ...actual,
    withDoctorSqliteMaintenanceLock,
  };
});

import { runSessionTranscriptsHealth } from "../flows/doctor-health-contribution-runners.state.js";
import type { DoctorHealthFlowContext } from "../flows/doctor-health-contribution-types.js";
import { GatewayLockError } from "../infra/gateway-lock.js";
import { createDoctorPrompter } from "./doctor-prompter.js";
import type { DoctorSessionSqliteReport } from "./doctor-session-sqlite-types.js";
import { noteSessionTranscriptHealth } from "./doctor-session-transcripts.js";
import { DoctorSqliteMaintenanceLockUnavailableError } from "./doctor-sqlite-maintenance-lock.js";

function sessionSqliteReport(totals: Partial<DoctorSessionSqliteReport["totals"]> = {}) {
  return {
    targets: [],
    totals: {
      archivedTranscriptFiles: 0,
      archivedUnreferencedJsonlFiles: 0,
      importedTranscriptEvents: 0,
      issues: 0,
      legacyEntries: 0,
      sqliteEntries: 0,
      unreferencedJsonlFiles: 0,
      validatedTranscriptEvents: 0,
      ...totals,
    },
  };
}

type OrderedMock = { mock: { invocationCallOrder: number[] } };

function expectCalledBefore(first: OrderedMock, second: OrderedMock) {
  expect(expectDefined(first.mock.invocationCallOrder[0], "first call")).toBeLessThan(
    expectDefined(second.mock.invocationCallOrder[0], "second call"),
  );
}

const legacyMainReport = { armed: false, complete: false, changes: [], warnings: [] };

const postSessionMigration: PreparedPostSessionPluginMigration = {
  step: {
    id: "plugin-doctor-post-session-state",
    phase: "final",
    source: [{ kind: "owner", id: "plugin:acpx:acpx-session-owner-resources" }],
    target: [{ kind: "owner", id: "plugin:acpx:doctor-state" }],
    requiredness: "conditional",
    reversibility: "checkpoint-required",
  },
  plannedActions: [{ pluginId: "acpx", id: "acpx-session-owner-resources" }],
};

describe("doctor session transcript repair", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  let receipts: unknown[];
  const onStepReceipt = (receipt: unknown) => {
    receipts.push(receipt);
  };
  const maintenanceAuthority = { assertCurrent() {} };
  type DoctorOptions = NonNullable<Parameters<typeof noteSessionTranscriptHealth>[0]>;
  const doctor = (overrides: Partial<DoctorOptions> = {}) =>
    noteSessionTranscriptHealth({ cfg: {}, env, shouldRepair: true, ...overrides });
  const expectNote = (text: string) =>
    expect(note).toHaveBeenCalledWith(expect.stringContaining(text), "Session SQLite");
  const stepReceipt = (details: object) =>
    expect.objectContaining({ id: "plugin-doctor-post-session-state", ...details });

  beforeEach(async () => {
    note.mockClear();
    receipts = [];
    repairReservedIncognitoSessionKeys.mockReset().mockReturnValue({ found: 0 });
    repairCanonicalSessionDeliveryStates.mockReset().mockReturnValue({ found: 0 });
    repairCanonicalSessionResolvedSkills.mockReset().mockReturnValue({ found: 0 });
    repairCanonicalSessionKeys.mockReset().mockResolvedValue({ foundGroups: 0 });
    repairLegacySessionWorktreeWorkspaces.mockReset().mockResolvedValue({ found: 0 });
    migrateLegacyMainSessionKeys.mockReset().mockResolvedValue(legacyMainReport);
    runDoctorSessionSqlite.mockReset();
    hasRetainedDoctorSessionSources.mockReset().mockReturnValue(false);
    settleRetainedDoctorSessionSources.mockReset();
    runPostSessionPluginDoctorStateRepairs
      .mockReset()
      .mockResolvedValue({ changes: [], warnings: [] });
    withDoctorSqliteMaintenanceLock
      .mockReset()
      .mockImplementation((params: { run: (authority: { assertCurrent(): void }) => unknown }) =>
        params.run(maintenanceAuthority),
      );
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-transcripts-")),
    );
    env = { ...process.env, OPENCLAW_STATE_DIR: root };
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("runs session SQLite import through the public doctor repair path", async () => {
    runDoctorSessionSqlite.mockResolvedValueOnce(
      sessionSqliteReport({
        archivedTranscriptFiles: 2,
        archivedUnreferencedJsonlFiles: 1,
        importedTranscriptEvents: 2,
        legacyEntries: 1,
        sqliteEntries: 1,
      }),
    );
    const cfg = {};

    await doctor({ cfg, env });

    expect(runDoctorSessionSqlite).toHaveBeenCalledWith(
      { allAgents: true, cfg, env, mode: "import" },
      maintenanceAuthority,
    );
    expect(migrateLegacyMainSessionKeys).toHaveBeenCalledWith({ cfg, env, mode: "doctor-fix" });
    expect(repairCanonicalSessionKeys.mock.invocationCallOrder[0]).toBeLessThan(
      repairLegacySessionWorktreeWorkspaces.mock.invocationCallOrder[0]!,
    );
    for (const repair of [
      repairLegacySessionWorktreeWorkspaces,
      repairReservedIncognitoSessionKeys,
      repairCanonicalSessionResolvedSkills,
    ]) {
      expect(repair).toHaveBeenCalledWith({ apply: true, cfg, env, targets: [] });
    }
    expectCalledBefore(runDoctorSessionSqlite, migrateLegacyMainSessionKeys);
    expectCalledBefore(migrateLegacyMainSessionKeys, repairCanonicalSessionKeys);
    expectCalledBefore(repairCanonicalSessionKeys, repairCanonicalSessionResolvedSkills);
    expectCalledBefore(repairCanonicalSessionResolvedSkills, repairReservedIncognitoSessionKeys);
    expectCalledBefore(
      repairCanonicalSessionDeliveryStates,
      runPostSessionPluginDoctorStateRepairs,
    );
    expect(runPostSessionPluginDoctorStateRepairs).toHaveBeenCalledWith({
      config: cfg,
      env,
      maintenanceAuthority: { assertCurrent: expect.any(Function) },
    });
    expect(withDoctorSqliteMaintenanceLock).toHaveBeenCalledWith({
      env,
      operation: "session SQLite import",
      run: expect.any(Function),
    });
    expectNote("Legacy entries: 1");
    expectNote("Archived 2 legacy transcript artifact(s).");
  });

  it("defers workspace writes while legacy-main source cleanup is incomplete", async () => {
    runDoctorSessionSqlite.mockResolvedValueOnce(sessionSqliteReport());
    migrateLegacyMainSessionKeys.mockResolvedValueOnce({
      ...legacyMainReport,
      armed: true,
      warnings: ["source changed; retry openclaw doctor --fix"],
    });
    const cfg = { agents: { entries: { ops: {} } } };
    await noteSessionTranscriptHealth({ cfg, env, shouldRepair: true });
    expect(repairCanonicalSessionKeys).toHaveBeenCalledWith({ apply: true, cfg, env });
    expect(repairLegacySessionWorktreeWorkspaces).toHaveBeenCalledWith({
      apply: false,
      cfg,
      env,
      targets: [],
    });
  });

  it("explains how to shrink SQLite files after removing persisted runtime skills", async () => {
    runDoctorSessionSqlite.mockResolvedValueOnce(sessionSqliteReport({ sqliteEntries: 2 }));
    repairCanonicalSessionResolvedSkills.mockReturnValueOnce({
      found: 2,
      repaired: 2,
    });

    await doctor();

    expectNote("Logical SQLite pages are freed");
    expectNote(
      'shrinking the on-disk database requires "openclaw doctor --session-sqlite compact --session-sqlite-all-agents"',
    );
  });

  it("keeps dry-run read-only and actionable with 20,353 historical warnings", async () => {
    const code = "historical_transcript_deferred";
    const count = 20_353;

    const sessionsDir = path.join(root, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const storePath = path.join(sessionsDir, "sessions.json");
    const warnings = Array.from(
      { length: count },
      (_, index) =>
        `history-${index}: multiple primary files claim this identity; originals retained without importing`,
    );
    const issues = [
      ...warnings.map((message) => ({ code, message })),
      { code: "transcript_missing", message: "Active session transcript is missing." },
    ];
    const originalIssues = structuredClone(issues);
    runDoctorSessionSqlite.mockResolvedValueOnce({
      targets: [{ storePath, issues }],
      totals: sessionSqliteReport({ issues: issues.length, legacyEntries: 1 }).totals,
    });
    const cfg = {};

    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: () => {
        throw new Error("Unexpected Doctor exit");
      },
    };
    const options = { nonInteractive: true };
    const ctx: DoctorHealthFlowContext = {
      cfg,
      env,
      runtime,
      options,
      cfgForPersistence: cfg,
      configResult: { cfg },
      configPath: path.join(root, "openclaw.json"),
      sourceConfigValid: true,
      prompter: createDoctorPrompter({ runtime, options }),
    };
    await runSessionTranscriptsHealth(ctx);
    expect(ctx.updateWarnings).toEqual(
      expect.arrayContaining(
        warnings.slice(0, 5).map((warning) => `${storePath}: [${code}] ${warning}`),
      ),
    );

    expect(runDoctorSessionSqlite).toHaveBeenCalledWith(
      { allAgents: true, cfg, env, mode: "dry-run", integrityCheck: "quick" },
      undefined,
    );
    expect(migrateLegacyMainSessionKeys).toHaveBeenCalledWith({ cfg, env, mode: "detect" });
    expect(repairLegacySessionWorktreeWorkspaces).toHaveBeenCalledWith({
      apply: false,
      cfg,
      env,
      integrityCheck: "quick",
      targets: [],
    });
    expect(withDoctorSqliteMaintenanceLock).not.toHaveBeenCalled();
    expect(runPostSessionPluginDoctorStateRepairs).toHaveBeenCalledWith({
      config: cfg,
      env,
      maintenanceAuthority: undefined,
    });
    expectNote(
      'Inspect with "openclaw doctor --session-sqlite dry-run --session-sqlite-all-agents".',
    );
    for (const warning of warnings.slice(0, 5)) {
      expectNote(`${storePath}: [${code}] ${warning}`);
    }
    expect(issues).toEqual(originalIssues);
    expect(ctx.updateWarnings).toContain(
      `${storePath}: [transcript_missing] Active session transcript is missing.`,
    );
    const output = note.mock.calls.find(([, title]) => title === "Session SQLite")![0];
    expect(output).toContain("Active session transcript is missing.");
    expect(ctx.updateWarnings).toHaveLength(7);
    expect(output).toContain(`${count} historical transcript claim(s)`);
    expect(output).toContain(`${count - 5} omitted`);
    expect(output).toContain("originals and migration manifests remain protected");
    expect(output).toContain(
      "openclaw doctor --session-sqlite dry-run --session-sqlite-all-agents --json",
    );
    expect(output).not.toContain("history-5:");
    expect(output.split("\n").length).toBeLessThan(20);
  });

  it("registers retained-source settlement only when the import retained sources", async () => {
    const report = sessionSqliteReport();
    runDoctorSessionSqlite.mockResolvedValueOnce(report);
    hasRetainedDoctorSessionSources.mockReturnValueOnce(true);

    await noteSessionTranscriptHealth({ cfg: {}, env, shouldRepair: true });

    expect(hasRetainedDoctorSessionSources).toHaveBeenCalledWith(report);
    const call = runPostSessionPluginDoctorStateRepairs.mock.calls[0]?.[0] as {
      beforeCompletion?: (ids: readonly string[], assertCurrent: () => void) => Promise<void>;
    };
    expect(call.beforeCompletion).toEqual(expect.any(Function));
    const assertCurrent = () => {};
    await call.beforeCompletion?.(["acpx"], assertCurrent);
    expect(settleRetainedDoctorSessionSources).toHaveBeenCalledWith(
      report,
      ["acpx"],
      { assertCurrent: expect.any(Function) },
      assertCurrent,
    );
  });

  it("passes frozen post-session actions to the writer and records mutation before receipt", async () => {
    runDoctorSessionSqlite.mockResolvedValue(sessionSqliteReport());
    let mutations = 0;
    runPostSessionPluginDoctorStateRepairs
      .mockImplementationOnce(async () => {
        mutations += 1;
        return { changes: ["repaired frozen plugin action"], warnings: [] };
      })
      .mockResolvedValueOnce({ changes: [], warnings: [] });
    const recordReceipt = (receipt: unknown) => {
      expect(mutations).toBe(1);
      receipts.push(receipt);
    };
    const params = {
      cfg: {},
      env,
      shouldRepair: true,
      postSessionPluginMigration: postSessionMigration,
      onStepReceipt: recordReceipt,
    };

    const first = await doctor(params);
    const replay = await noteSessionTranscriptHealth(params);

    expect(runPostSessionPluginDoctorStateRepairs).toHaveBeenNthCalledWith(1, {
      config: {},
      env: params.env,
      maintenanceAuthority: { assertCurrent: expect.any(Function) },
      plannedActions: postSessionMigration.plannedActions,
    });
    expect(first).toEqual(
      stepReceipt({ outcome: "completed", changes: ["repaired frozen plugin action"] }),
    );
    expect(replay).toEqual(stepReceipt({ outcome: "skipped", changes: [] }));
    expect(receipts).toEqual([first, replay]);
  });

  const refusedReceipt = (code: string) =>
    stepReceipt({
      outcome: "refused",
      changes: [],
      refusal: expect.objectContaining({ code }),
    });
  const notRequiredStep: PreparedPostSessionPluginMigration["step"] = {
    ...postSessionMigration.step,
    source: [],
    target: [],
    requiredness: "not-required",
    reversibility: "not-applicable",
  };
  it.each([
    "writer failure",
    "unauthorized repair",
    "not-required step",
    "refused bound plan",
  ] as const)("closes the post-session step: %s", async (scenario) => {
    const writerFailure = scenario === "writer failure";
    const notRequired = scenario === "not-required step";
    const boundRefusal = scenario === "refused bound plan";
    runDoctorSessionSqlite.mockResolvedValue(sessionSqliteReport());
    if (writerFailure) {
      runPostSessionPluginDoctorStateRepairs.mockRejectedValueOnce(new Error("writer failed"));
    }
    const receipt = await doctor({
      cfg: boundRefusal
        ? { plugins: { entries: { external: { enabled: true } } } }
        : notRequired
          ? { plugins: { enabled: false } }
          : {},
      shouldRepair: writerFailure || boundRefusal,
      ...(boundRefusal
        ? { postSessionPluginMigrationPlanBound: true }
        : {
            postSessionPluginMigration: notRequired
              ? { step: notRequiredStep, plannedActions: [] }
              : postSessionMigration,
          }),
      onStepReceipt,
    });
    const expected = boundRefusal
      ? undefined
      : notRequired
        ? { ...notRequiredStep, outcome: "skipped", changes: [], warnings: [] }
        : refusedReceipt(writerFailure ? "step-threw" : "repair-not-authorized");
    expect(receipt).toEqual(expected);
    expect(receipts).toEqual(boundRefusal ? [] : [receipt]);
    expect(runPostSessionPluginDoctorStateRepairs).toHaveBeenCalledTimes(writerFailure ? 1 : 0);
  });

  it("reports the native cause when session SQLite import cannot acquire its lock", async () => {
    const cause = new GatewayLockError(
      "lock operation failed",
      Object.assign(new Error("function not implemented"), { code: "ENOSYS" }),
    );

    withDoctorSqliteMaintenanceLock.mockRejectedValueOnce(
      new DoctorSqliteMaintenanceLockUnavailableError("session SQLite import", cause),
    );

    await expect(doctor({ env })).resolves.toBeUndefined();

    expect(runDoctorSessionSqlite).not.toHaveBeenCalled();
    expectNote(cause.message);
    expectNote("ENOSYS");
    expectNote('run "openclaw doctor --fix" for session-store maintenance');
  });

  it("keeps non-lock session SQLite import failures fatal", async () => {
    runDoctorSessionSqlite.mockRejectedValueOnce(new Error("SQLite import failed"));

    await expect(
      doctor({
        postSessionPluginMigration: postSessionMigration,
        onStepReceipt,
      }),
    ).rejects.toThrow("SQLite import failed");
    expect(runPostSessionPluginDoctorStateRepairs).not.toHaveBeenCalled();
    expect(receipts).toEqual([refusedReceipt("blocked-by-session-repair-failure")]);
  });
});
