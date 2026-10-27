import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { readConfigMachineStateWithMetadata } from "../test-utils/config-machine-state.js";
import { readTuiLastSessionKey } from "../tui/tui-last-session.js";
import {
  detectLegacyTuiLastSessions,
  migrateLegacyTuiLastSessions,
} from "./state-migrations.tui-last-session.js";

const tempDirs = createTempDirTracker();
type MigrationOptions = Parameters<typeof migrateLegacyTuiLastSessions>[0];

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
    run: (overrides: Omit<MigrationOptions, "detected" | "stateDir"> = {}) =>
      migrateLegacyTuiLastSessions({
        detected: { sourcePath, hasLegacy: true },
        stateDir,
        ...overrides,
      }),
    read: (scopeKey = "terminal") => readTuiLastSessionKey({ scopeKey, stateDir }),
    async check(
      result: ReturnType<typeof migrateLegacyTuiLastSessions>,
      session: string | null,
      warning?: string,
    ) {
      if (warning) {
        expect(result.changes).toEqual([]);
        expect(result.warnings.join("\n")).toContain(warning);
      } else {
        expect(result.warnings).toEqual([]);
      }
      expect(fs.existsSync(sourcePath)).toBe(Boolean(warning));
      await expect(readTuiLastSessionKey({ scopeKey: "terminal", stateDir })).resolves.toBe(
        session,
      );
    },
  };
}

function seedPointer(stateDir: string, updatedAt: number): void {
  // Seed historical timestamps; the runtime writer stamps Date.now().
  runOpenClawStateWriteTransaction(
    ({ db }) =>
      db
        .prepare(
          "INSERT INTO config_machine_state(state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
        )
        .run("tui.lastSession.terminal", JSON.stringify("agent:main:current"), updatedAt),
    { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } },
  );
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

describe("legacy TUI last-session migration", () => {
  it("retains malformed UTF-8 without importing replacement characters", async () => {
    const state = fixture({ terminal: pointer("utf8-marker") });
    const bytes = fs.readFileSync(state.sourcePath);
    bytes[bytes.indexOf("utf8-marker")] = 0xff;
    fs.writeFileSync(state.sourcePath, bytes);
    const result = state.run();
    await state.check(result, null, "must be valid UTF-8");
    expect(result.warningDisposition).toBe("recoverable");
    expect(fs.readFileSync(state.sourcePath)).toEqual(bytes);
  });

  it("requires Doctor opt-in and discards heartbeat pointers", async () => {
    const state = fixture({
      terminal: pointer(),
      heartbeat: pointer("agent:main:telegram:direct:123:heartbeat", 200),
    });
    const { stateDir, sourcePath, read } = state;
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

    await state.check(result, "agent:main:tui-123");
    expect(
      readConfigMachineStateWithMetadata<string>("tui.lastSession.terminal", {
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      }),
    ).toEqual({ value: "agent:main:tui-123", updatedAtMs: 100 });
    await expect(read("heartbeat")).resolves.toBeNull();
    expect(fs.readdirSync(path.dirname(sourcePath))).not.toContain("last-session.json.migrated");
  });

  it.each([
    ["non-object top level", [], "must be a JSON object"],
    ["non-object record", { terminal: "agent:main:tui-123" }, "must be an object"],
    ["missing timestamp", { terminal: { sessionKey: "agent:main:tui-123" } }, "invalid timestamp"],
    ["unexpected field", { terminal: { "": 1, later: 2, ...pointer() } }, 'unexpected field ""'],
  ])("retains malformed source: %s", async (_label, value, warning) => {
    const state = fixture(value);
    await state.check(state.run(), null, warning);
    expect(fs.readdirSync(path.dirname(state.sourcePath))).toEqual(["last-session.json"]);
  });

  it.each([
    [100, "divergent JSON and SQLite pointers at the same timestamp"],
    [200, undefined],
  ] as const)("preserves the SQLite pointer at timestamp %s", async (timestamp, warning) => {
    const state = fixture({ terminal: pointer("agent:main:legacy") });
    seedPointer(state.stateDir, timestamp);
    await state.check(state.run(), "agent:main:current", warning);
  });

  it.each([
    ["beforeVerify", "source changed after doctor loaded it"],
    ["beforeClaim", "source changed before doctor could claim it"],
    ["removeSource", "simulated unlink failure"],
  ] as const)("retains sources after %s failure; retries cleanup", async (hook, warning) => {
    const session = hook === "removeSource" ? "agent:main:tui-123" : "agent:main:first";
    const state = fixture({ terminal: pointer(session) });
    const result = state.run({
      [hook]: () => {
        if (hook === "removeSource") {
          throw new Error(warning);
        }
        const target =
          hook === "beforeClaim" ? `${state.sourcePath}.replacement` : state.sourcePath;
        fs.writeFileSync(
          target,
          `${JSON.stringify({ terminal: pointer("agent:main:second", 200) })}\n`,
        );
        if (hook === "beforeClaim") {
          fs.renameSync(target, state.sourcePath);
        }
      },
    });
    await state.check(result, session, warning);
    if (hook === "beforeVerify") {
      return;
    }
    await state.check(state.run(), hook === "beforeClaim" ? "agent:main:second" : session);
  });
});
