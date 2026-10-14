// Doctor session transcript tests cover transcript inspection and repair guidance.
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

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note,
}));

vi.mock("./doctor-session-sqlite.js", () => ({
  hasRetainedDoctorSessionSources,
  runDoctorSessionSqlite,
  settleRetainedDoctorSessionSources,
}));

vi.mock("../infra/state-migrations.plugin-doctor.js", () => ({
  runPostSessionPluginDoctorStateRepairs,
}));

vi.mock("./doctor-session-incognito-key-repair.js", () => ({
  repairReservedIncognitoSessionKeys,
}));

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

vi.mock("./doctor-session-canonical-keys.js", () => ({
  repairCanonicalSessionKeys,
}));

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

const preparedPostSessionPluginMigration: PreparedPostSessionPluginMigration = {
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
  const maintenanceAuthority = { assertCurrent() {} };

  beforeEach(async () => {
    note.mockClear();
    repairReservedIncognitoSessionKeys.mockReset().mockReturnValue({ found: 0, repaired: 0 });
    repairCanonicalSessionDeliveryStates
      .mockReset()
      .mockReturnValue({ found: 0, repaired: 0, scannedStores: 0 });
    repairCanonicalSessionResolvedSkills
      .mockReset()
      .mockReturnValue({ found: 0, repaired: 0, scannedStores: 0 });
    repairCanonicalSessionKeys.mockReset().mockResolvedValue({
      archivedTranscriptDirectories: [],
      foundGroups: 0,
      repairBatches: 0,
      removedRows: 0,
      repairedGroups: 0,
      scannedStores: 0,
    });
    repairLegacySessionWorktreeWorkspaces
      .mockReset()
      .mockResolvedValue({ found: 0, repaired: 0, scannedStores: 0 });
    migrateLegacyMainSessionKeys.mockReset().mockResolvedValue({
      armed: false,
      changes: [],
      complete: false,
      ledgerComplete: false,
      legacyAgentId: "main",
      mainKey: "main",
      outcomes: [{ kind: "not-armed" }],
      warnings: [],
    });
    runDoctorSessionSqlite.mockReset();
    hasRetainedDoctorSessionSources.mockReset().mockReturnValue(false);
    settleRetainedDoctorSessionSources.mockReset();
    runPostSessionPluginDoctorStateRepairs
      .mockReset()
      .mockResolvedValue({ changes: [], warnings: [] });
    withDoctorSqliteMaintenanceLock
      .mockReset()
      .mockImplementation(
        async (params: { run: (authority: { assertCurrent(): void }) => unknown }) =>
          await params.run(maintenanceAuthority),
      );
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-transcripts-")),
    );
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
    const env = { ...process.env, OPENCLAW_STATE_DIR: root };
    const cfg = {};

    await noteSessionTranscriptHealth({
      cfg,
      env,
      shouldRepair: true,
    });

    expect(runDoctorSessionSqlite).toHaveBeenCalledWith(
      { allAgents: true, cfg, env, mode: "import" },
      maintenanceAuthority,
    );
    expect(migrateLegacyMainSessionKeys).toHaveBeenCalledWith({
      cfg,
      env,
      mode: "doctor-fix",
    });
    expect(repairLegacySessionWorktreeWorkspaces).toHaveBeenCalledWith({
      apply: true,
      cfg,
      env,
      targets: [],
    });
    expect(repairCanonicalSessionKeys.mock.invocationCallOrder[0]).toBeLessThan(
      repairLegacySessionWorktreeWorkspaces.mock.invocationCallOrder[0]!,
    );
    expect(repairReservedIncognitoSessionKeys).toHaveBeenCalledWith({
      apply: true,
      cfg,
      env,
      targets: [],
    });
    expect(repairCanonicalSessionResolvedSkills).toHaveBeenCalledWith({
      apply: true,
      cfg,
      env,
      targets: [],
    });
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
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Legacy entries: 1"),
      "Session SQLite",
    );
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Archived 2 legacy transcript artifact(s)."),
      "Session SQLite",
    );
  });

  it("defers workspace writes while legacy-main source cleanup is incomplete", async () => {
    runDoctorSessionSqlite.mockResolvedValueOnce(sessionSqliteReport());
    migrateLegacyMainSessionKeys.mockResolvedValueOnce({
      armed: true,
      changes: [],
      complete: false,
      ledgerComplete: false,
      legacyAgentId: "main",
      mainKey: "main",
      ownerAgentId: "ops",
      outcomes: [{ kind: "divergent-canonical", canonicalKey: "agent:ops:main" }],
      warnings: ["source changed; retry openclaw doctor --fix"],
    });
    const cfg = { agents: { entries: { ops: {} } } };
    const env = { ...process.env, OPENCLAW_STATE_DIR: root };
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
      scannedStores: 1,
    });

    await noteSessionTranscriptHealth({
      cfg: {},
      env: { ...process.env, OPENCLAW_STATE_DIR: root },
      shouldRepair: true,
    });

    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Logical SQLite pages are freed"),
      "Session SQLite",
    );
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining(
        'shrinking the on-disk database requires "openclaw doctor --session-sqlite compact --session-sqlite-all-agents"',
      ),
      "Session SQLite",
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
      totals: {
        archivedTranscriptFiles: 0,
        archivedUnreferencedJsonlFiles: 0,
        importedTranscriptEvents: 0,
        issues: issues.length,
        legacyEntries: 1,
        sqliteEntries: 0,
        unreferencedJsonlFiles: 0,
        validatedTranscriptEvents: 0,
      },
    });
    const env = { ...process.env, OPENCLAW_STATE_DIR: root };
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
      { allAgents: true, cfg, env, mode: "dry-run" },
      undefined,
    );
    expect(migrateLegacyMainSessionKeys).toHaveBeenCalledWith({ cfg, env, mode: "detect" });
    expect(repairLegacySessionWorktreeWorkspaces).toHaveBeenCalledWith({
      apply: false,
      cfg,
      env,
      targets: [],
    });
    expect(withDoctorSqliteMaintenanceLock).not.toHaveBeenCalled();
    expect(runPostSessionPluginDoctorStateRepairs).toHaveBeenCalledWith({
      config: cfg,
      env,
      maintenanceAuthority: undefined,
    });
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining(
        'Inspect with "openclaw doctor --session-sqlite dry-run --session-sqlite-all-agents".',
      ),
      "Session SQLite",
    );
    for (const warning of warnings.slice(0, 5)) {
      expect(note).toHaveBeenCalledWith(
        expect.stringContaining(`${storePath}: [${code}] ${warning}`),
        "Session SQLite",
      );
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
    const env = { ...process.env, OPENCLAW_STATE_DIR: root };

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
    const receipts: unknown[] = [];
    const recordReceipt = (receipt: unknown) => {
      expect(mutations).toBe(1);
      receipts.push(receipt);
    };
    const params = {
      cfg: {},
      env: { ...process.env, OPENCLAW_STATE_DIR: root },
      shouldRepair: true,
      postSessionPluginMigration: preparedPostSessionPluginMigration,
      onStepReceipt: recordReceipt,
    };

    const first = await noteSessionTranscriptHealth(params);
    const replay = await noteSessionTranscriptHealth(params);

    expect(runPostSessionPluginDoctorStateRepairs).toHaveBeenNthCalledWith(1, {
      config: {},
      env: params.env,
      maintenanceAuthority: { assertCurrent: expect.any(Function) },
      plannedActions: preparedPostSessionPluginMigration.plannedActions,
    });
    expect(first).toMatchObject({
      id: "plugin-doctor-post-session-state",
      outcome: "completed",
      changes: ["repaired frozen plugin action"],
    });
    expect(replay).toMatchObject({
      id: "plugin-doctor-post-session-state",
      outcome: "skipped",
      changes: [],
    });
    expect(receipts).toEqual([first, replay]);
  });

  it("records a refused post-session receipt when the writer fails", async () => {
    runDoctorSessionSqlite.mockResolvedValue(sessionSqliteReport());
    runPostSessionPluginDoctorStateRepairs.mockRejectedValueOnce(new Error("writer failed"));
    const receipts: unknown[] = [];

    const receipt = await noteSessionTranscriptHealth({
      cfg: {},
      env: { ...process.env, OPENCLAW_STATE_DIR: root },
      shouldRepair: true,
      postSessionPluginMigration: preparedPostSessionPluginMigration,
      onStepReceipt: (entry) => receipts.push(entry),
    });

    expect(receipt).toMatchObject({
      id: "plugin-doctor-post-session-state",
      outcome: "refused",
      changes: [],
      refusal: { code: "step-threw" },
    });
    expect(receipts).toEqual([receipt]);
    expect(receipts).not.toContainEqual(expect.objectContaining({ outcome: "completed" }));
  });

  it("closes the planned post-session step when repair is not authorized", async () => {
    runDoctorSessionSqlite.mockResolvedValue(sessionSqliteReport());
    const receipts: unknown[] = [];

    const receipt = await noteSessionTranscriptHealth({
      cfg: {},
      env: { ...process.env, OPENCLAW_STATE_DIR: root },
      shouldRepair: false,
      postSessionPluginMigration: preparedPostSessionPluginMigration,
      onStepReceipt: (entry) => receipts.push(entry),
    });

    expect(runPostSessionPluginDoctorStateRepairs).not.toHaveBeenCalled();
    expect(receipt).toMatchObject({
      id: "plugin-doctor-post-session-state",
      outcome: "refused",
      changes: [],
      refusal: { code: "repair-not-authorized" },
    });
    expect(receipts).toEqual([receipt]);
    expect(receipts).not.toContainEqual(expect.objectContaining({ outcome: "completed" }));
  });

  it("skips a not-required post-session step before checking repair authorization", async () => {
    runDoctorSessionSqlite.mockResolvedValue(sessionSqliteReport());
    const step: PreparedPostSessionPluginMigration["step"] = {
      ...preparedPostSessionPluginMigration.step,
      source: [],
      target: [],
      requiredness: "not-required",
      reversibility: "not-applicable",
    };
    const receipts: unknown[] = [];
    const receipt = await noteSessionTranscriptHealth({
      cfg: { plugins: { enabled: false } },
      env: { ...process.env, OPENCLAW_STATE_DIR: root },
      shouldRepair: false,
      postSessionPluginMigration: { step, plannedActions: [] },
      onStepReceipt: (entry) => receipts.push(entry),
    });
    expect(receipt).toEqual({ ...step, outcome: "skipped", changes: [], warnings: [] });
    expect(receipts).toEqual([receipt]);
    expect(runPostSessionPluginDoctorStateRepairs.mock.calls.length).toBe(0);
  });

  it("does not fall back to dynamic plugin repair after the bound plan refused", async () => {
    runDoctorSessionSqlite.mockResolvedValue(sessionSqliteReport());
    const receipts: unknown[] = [];

    await noteSessionTranscriptHealth({
      cfg: { plugins: { entries: { external: { enabled: true } } } },
      env: { ...process.env, OPENCLAW_STATE_DIR: root },
      shouldRepair: true,
      postSessionPluginMigrationPlanBound: true,
      onStepReceipt: (receipt) => receipts.push(receipt),
    });

    expect(runPostSessionPluginDoctorStateRepairs).not.toHaveBeenCalled();
    expect(receipts).toEqual([]);
  });

  it("reports the native cause when session SQLite import cannot acquire its lock", async () => {
    const cause = new GatewayLockError(
      "lock operation failed",
      Object.assign(new Error("function not implemented"), { code: "ENOSYS" }),
    );

    const env = { ...process.env, OPENCLAW_STATE_DIR: root };
    withDoctorSqliteMaintenanceLock.mockRejectedValueOnce(
      new DoctorSqliteMaintenanceLockUnavailableError("session SQLite import", cause),
    );

    await expect(
      noteSessionTranscriptHealth({
        cfg: {},
        env,
        shouldRepair: true,
      }),
    ).resolves.toBeUndefined();

    expect(runDoctorSessionSqlite).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(expect.stringContaining(cause.message), "Session SQLite");
    if (cause.cause) {
      expect(note).toHaveBeenCalledWith(expect.stringContaining("ENOSYS"), "Session SQLite");
    }
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining('run "openclaw doctor --fix" for session-store maintenance'),
      "Session SQLite",
    );
  });

  it("keeps non-lock session SQLite import failures fatal", async () => {
    runDoctorSessionSqlite.mockRejectedValueOnce(new Error("SQLite import failed"));
    const receipts: unknown[] = [];

    await expect(
      noteSessionTranscriptHealth({
        cfg: {},
        env: { ...process.env, OPENCLAW_STATE_DIR: root },
        shouldRepair: true,
        postSessionPluginMigration: preparedPostSessionPluginMigration,
        onStepReceipt: (receipt) => receipts.push(receipt),
      }),
    ).rejects.toThrow("SQLite import failed");
    expect(runPostSessionPluginDoctorStateRepairs).not.toHaveBeenCalled();
    expect(receipts).toEqual([
      expect.objectContaining({
        id: "plugin-doctor-post-session-state",
        outcome: "refused",
        changes: [],
        refusal: expect.objectContaining({ code: "blocked-by-session-repair-failure" }),
      }),
    ]);
    expect(receipts).not.toContainEqual(
      expect.objectContaining({ outcome: expect.stringMatching(/completed|skipped|warning/) }),
    );
  });
});
