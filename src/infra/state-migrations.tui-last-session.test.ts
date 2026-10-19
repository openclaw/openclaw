import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { readConfigMachineStateWithMetadata } from "../test-utils/config-machine-state.js";
import { readTuiLastSessionKey } from "../tui/tui-last-session.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import {
  detectLegacyTuiLastSessions,
  migrateLegacyTuiLastSessions,
} from "./state-migrations.tui-last-session.js";

type TuiLastSessionTestDatabase = Pick<OpenClawStateKyselyDatabase, "config_machine_state">;

const tempDirs = createTempDirTracker();

function writeLegacyStore(stateDir: string, value: unknown): string {
  const sourcePath = path.join(stateDir, "tui", "last-session.json");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return sourcePath;
}

const pointer = (sessionKey = "agent:main:tui-123", updatedAt = 100) => ({ sessionKey, updatedAt });

function fixture(value: unknown = { terminal: pointer() }) {
  const stateDir = tempDirs.make("openclaw-tui-migration-");
  const sourcePath = writeLegacyStore(stateDir, value);
  return {
    stateDir,
    sourcePath,
    run: (
      overrides: Omit<
        Parameters<typeof migrateLegacyTuiLastSessions>[0],
        "detected" | "stateDir"
      > = {},
    ) =>
      migrateLegacyTuiLastSessions({
        detected: { sourcePath, hasLegacy: true },
        stateDir,
        ...overrides,
      }),
    read: (scopeKey = "terminal") => readTuiLastSessionKey({ scopeKey, stateDir }),
  };
}

function seedPointer(stateDir: string, updatedAt: number): void {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<TuiLastSessionTestDatabase>(db)
          .insertInto("config_machine_state")
          .values({
            state_key: "tui.lastSession.terminal",
            value_json: JSON.stringify("agent:main:current"),
            updated_at_ms: updatedAt,
          }),
      );
    },
    { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } },
  );
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

describe("legacy TUI last-session migration", () => {
  it("runs only through explicit doctor detection and discards heartbeat pointers", async () => {
    const { stateDir, sourcePath, read } = fixture({
      terminal: pointer(),
      heartbeat: pointer("agent:main:telegram:direct:123:heartbeat", 200),
    });
    const runtimeDetection = detectLegacyTuiLastSessions({ stateDir });
    expect(runtimeDetection.hasLegacy).toBe(false);
    await expect(read()).resolves.toBeNull();
    expect(fs.existsSync(sourcePath)).toBe(true);

    const doctorDetection = detectLegacyTuiLastSessions({
      stateDir,
      doctorOnlyStateMigrations: true,
    });
    expect(doctorDetection.hasLegacy).toBe(true);
    const result = migrateLegacyTuiLastSessions({
      detected: doctorDetection,
      stateDir,
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toContain(
      "Migrated 1 TUI last-session pointer(s) → shared SQLite state",
    );
    expect(result.changes).toContain("Discarded 1 legacy heartbeat TUI restore pointer(s)");
    expect(fs.existsSync(sourcePath)).toBe(false);
    await expect(read()).resolves.toBe("agent:main:tui-123");
    expect(
      readConfigMachineStateWithMetadata<string>("tui.lastSession.terminal", {
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      }),
    ).toEqual({ value: "agent:main:tui-123", updatedAtMs: 100 });
    await expect(read("heartbeat")).resolves.toBeNull();
    expect(fs.readdirSync(path.dirname(sourcePath))).not.toContain("last-session.json.migrated");
  });

  it.each([
    ["non-object top level", []],
    ["non-object record", { terminal: "agent:main:tui-123" }],
    ["missing timestamp", { terminal: { sessionKey: "agent:main:tui-123" } }],
  ])("retains malformed source: %s", async (_label, value) => {
    const { sourcePath, run, read } = fixture(value);
    const result = run();

    expect(result.changes).toEqual([]);
    expect(result.warnings.join("\n")).toContain("Failed reading legacy TUI last-session state");
    expect(fs.existsSync(sourcePath)).toBe(true);
    await expect(read()).resolves.toBeNull();
  });

  it("rejects an empty unexpected field before claiming or writing", async () => {
    const { sourcePath, run, read } = fixture({
      terminal: { "": 1, later: 2, sessionKey: "agent:main:tui-123", updatedAt: 100 },
    });
    const result = run();
    expect(result.warnings).toEqual([
      `Failed reading legacy TUI last-session state ${sourcePath}: Error: legacy TUI last-session record terminal has unexpected field ""`,
    ]);
    expect(fs.readdirSync(path.dirname(sourcePath))).toEqual(["last-session.json"]);
    await expect(read()).resolves.toBeNull();
  });

  it("keeps a newer SQLite pointer and removes its superseded source", async () => {
    const { stateDir, sourcePath, run, read } = fixture({ terminal: pointer("agent:main:legacy") });
    seedPointer(stateDir, 200);
    const result = run();

    expect(result.warnings).toEqual([]);
    expect(result.notices).toEqual([
      "Kept 1 newer shared SQLite TUI last-session pointer(s) over legacy JSON",
    ]);
    expect(fs.existsSync(sourcePath)).toBe(false);
    await expect(read()).resolves.toBe("agent:main:current");
  });

  it("fails closed on equal-timestamp divergence", async () => {
    const { stateDir, sourcePath, run, read } = fixture({ terminal: pointer("agent:main:legacy") });
    seedPointer(stateDir, 100);
    const result = run();

    expect(result.changes).toEqual([]);
    expect(result.warnings.join("\n")).toContain(
      "divergent JSON and SQLite pointers at the same timestamp",
    );
    expect(fs.existsSync(sourcePath)).toBe(true);
    await expect(read()).resolves.toBe("agent:main:current");
  });

  it("retains a source that changes before verification", async () => {
    const { sourcePath, run, read } = fixture({ terminal: pointer("agent:main:first") });
    const result = run({
      beforeVerify: () => {
        fs.writeFileSync(
          sourcePath,
          `${JSON.stringify({ terminal: pointer("agent:main:second", 200) })}\n`,
        );
      },
    });

    expect(result.changes).toEqual([]);
    expect(result.warnings.join("\n")).toContain("source changed after doctor loaded it");
    expect(fs.existsSync(sourcePath)).toBe(true);
    await expect(read()).resolves.toBe("agent:main:first");
  });

  it("does not delete a replacement written after verification", async () => {
    const { sourcePath, run, read } = fixture({ terminal: pointer("agent:main:first") });
    const replacement = `${sourcePath}.replacement`;

    const first = run({
      beforeClaim: () => {
        fs.writeFileSync(
          replacement,
          `${JSON.stringify({ terminal: pointer("agent:main:second", 200) })}\n`,
        );
        fs.renameSync(replacement, sourcePath);
      },
    });

    expect(first.changes).toEqual([]);
    expect(first.warnings.join("\n")).toContain("source changed before doctor could claim it");
    expect(fs.existsSync(sourcePath)).toBe(true);
    await expect(read()).resolves.toBe("agent:main:first");

    const retry = run();
    expect(retry.warnings).toEqual([]);
    expect(fs.existsSync(sourcePath)).toBe(false);
    await expect(read()).resolves.toBe("agent:main:second");
  });

  it("retries source cleanup without overwriting the verified row", async () => {
    const { sourcePath, run, read } = fixture();
    const first = run({
      removeSource: () => {
        throw new Error("simulated unlink failure");
      },
    });
    expect(first.warnings.join("\n")).toContain("simulated unlink failure");
    expect(fs.existsSync(sourcePath)).toBe(true);

    const retry = run();
    expect(retry.warnings).toEqual([]);
    expect(fs.existsSync(sourcePath)).toBe(false);
    await expect(read()).resolves.toBe("agent:main:tui-123");
  });
});
