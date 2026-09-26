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
const withDoctorSqliteMaintenanceLock = vi.hoisted(() => vi.fn());
const runPostSessionPluginDoctorStateRepairs = vi.hoisted(() => vi.fn());

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note,
}));

vi.mock("./doctor-session-sqlite.js", () => ({
  runDoctorSessionSqlite,
}));

vi.mock("../infra/state-migrations.plugin-doctor.js", () => ({
  runPostSessionPluginDoctorStateRepairs,
}));

vi.mock("./doctor-session-incognito-key-repair.js", () => ({
  repairReservedIncognitoSessionKeys,
}));

vi.mock("./doctor-session-delivery-state.js", () => ({
  repairCanonicalSessionDeliveryStates,
  repairCanonicalSessionResolvedSkills,
}));

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
    runPostSessionPluginDoctorStateRepairs
      .mockReset()
      .mockResolvedValue({ changes: [], warnings: [] });
    withDoctorSqliteMaintenanceLock
      .mockReset()
      .mockImplementation(
        async (params: { run: (authority: { assertCurrent(): void }) => unknown }) =>
          await params.run({ assertCurrent() {} }),
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

    expect(runDoctorSessionSqlite).toHaveBeenCalledWith({
      allAgents: true,
      cfg,
      env,
      mode: "import",
    });
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
      beforeCompletion: expect.any(Function),
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

  it("hands a large untouched original to public Doctor SQLite import without a raw repair copy", async () => {
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const transcriptPath = path.join(sessionsDir, "large.jsonl");
    await fs.writeFile(transcriptPath, '{"type":"session","id":"large","version":3}\n');
    const payload = "x".repeat(64 * 1024);
    for (let index = 0; index < 128; index += 1) {
      await fs.appendFile(
        transcriptPath,
        `${JSON.stringify({
          type: "message",
          id: `event-${index}`,
          parentId: index ? `event-${index - 1}` : null,
          message: { role: "assistant", provider: "openai-codex", content: payload },
        })}\n`,
      );
    }
    const originalSize = (await fs.stat(transcriptPath)).size;
    let filesAtImport: string[] = [];
    let sizeAtImport = 0;
    runDoctorSessionSqlite.mockImplementationOnce(async () => {
      filesAtImport = await fs.readdir(sessionsDir);
      sizeAtImport = (await fs.stat(transcriptPath)).size;
      return { totals: { legacyEntries: 0, unreferencedJsonlFiles: 0, issues: 0 } };
    });
    const readFile = vi.spyOn(fs, "readFile");
    try {
      await noteSessionTranscriptHealth({
        cfg: {},
        env: { ...process.env, OPENCLAW_STATE_DIR: root },
        shouldRepair: true,
      });
      expect({
        filesAtImport,
        sizeAtImport,
        fullRawRead: readFile.mock.calls.some(([file]) => file === transcriptPath),
      }).toEqual({
        filesAtImport: ["large.jsonl"],
        sizeAtImport: originalSize,
        fullRawRead: false,
      });
    } finally {
      readFile.mockRestore();
    }
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

  it.each([
    ["entry_invalid", 1],
    ["historical_duplicate_settled", 1],
    ["historical_transcript_deferred", 5],
    ["historical_transcript_deferred", 6],
    ["historical_transcript_deferred", 20_353],
  ] as const)(
    "keeps session SQLite dry-run read-only with %s (%i warnings)",
    async (code, count) => {
      const sessionsDir = path.join(root, "agents", "main", "sessions");
      await fs.mkdir(sessionsDir, { recursive: true });
      const storePath = path.join(sessionsDir, "sessions.json");
      const warnings =
        code === "entry_invalid"
          ? ["Session entry is missing a valid sessionId."]
          : code === "historical_duplicate_settled"
            ? [
                "Retired 1307 byte-identical duplicate archive(s); rollback references now use the verified surviving originals.",
              ]
            : Array.from(
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

      expect(runDoctorSessionSqlite).toHaveBeenCalledWith({
        allAgents: true,
        cfg,
        env,
        mode: "dry-run",
      });
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
      if (count > 5) {
        expect(ctx.updateWarnings).toHaveLength(7);
        expect(output).toContain(`${count} historical transcript claim(s)`);
        expect(output).toContain(`${count - 5} omitted`);
        expect(output).toContain("originals and migration manifests remain protected");
        expect(output).toContain(
          "openclaw doctor --session-sqlite dry-run --session-sqlite-all-agents --json",
        );
        expect(output).not.toContain("history-5:");
        expect(output.split("\n").length).toBeLessThan(20);
      } else {
        expect(ctx.updateWarnings).toHaveLength(warnings.length + 1);
      }
    },
  );

  it("reports post-session plugin changes and actionable ownership warnings", async () => {
    runDoctorSessionSqlite.mockResolvedValueOnce(sessionSqliteReport());
    runPostSessionPluginDoctorStateRepairs.mockResolvedValueOnce({
      changes: ["Removed 2 orphaned plugin session bindings"],
      warnings: ["Plugin lifecycle ownership unavailable; rerun openclaw doctor --fix"],
    });

    const receipts: unknown[] = [];
    const receipt = await noteSessionTranscriptHealth({
      cfg: {},
      env: { ...process.env, OPENCLAW_STATE_DIR: root },
      shouldRepair: true,
      postSessionPluginMigration: preparedPostSessionPluginMigration,
      onStepReceipt: (entry) => receipts.push(entry),
    });

    expect(receipt).toMatchObject({
      ...preparedPostSessionPluginMigration.step,
      changes: ["Removed 2 orphaned plugin session bindings"],
      outcome: "refused",
      refusal: { code: "step-refused" },
    });
    expect(receipts).toEqual([receipt]);
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Removed 2 orphaned plugin session bindings"),
      "Plugin session repair",
    );
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("rerun openclaw doctor --fix"),
      "Plugin session repair",
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
      beforeCompletion: expect.any(Function),
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

  it("skips session SQLite import when the Gateway owns the state lock", async () => {
    const env = { ...process.env, OPENCLAW_STATE_DIR: root };
    withDoctorSqliteMaintenanceLock.mockRejectedValueOnce(
      new DoctorSqliteMaintenanceLockUnavailableError(
        "session SQLite import",
        new GatewayLockError("gateway already running"),
      ),
    );

    await expect(
      noteSessionTranscriptHealth({
        cfg: {},
        env,
        shouldRepair: true,
      }),
    ).resolves.toBeUndefined();

    expect(runDoctorSessionSqlite).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining(
        "Skipped: Gateway or another SQLite maintenance command owns the state directory",
      ),
      "Session SQLite",
    );
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
