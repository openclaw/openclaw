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

async function expectRefusal(
  value: ReturnType<typeof fixture>,
  result: ReturnType<typeof migrateLegacyTuiLastSessions>,
  warning: string,
  session: string | null,
) {
  expect(result.changes).toEqual([]);
  expect(result.warnings.join("\n")).toContain(warning);
  expect(fs.existsSync(value.sourcePath)).toBe(true);
  await expect(value.read()).resolves.toBe(session);
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
    await expectRefusal(state, result, "must be valid UTF-8", null);
    expect(result.warningDisposition).toBe("recoverable");
    expect(fs.readFileSync(state.sourcePath)).toEqual(bytes);
  });

  it("requires Doctor opt-in and discards heartbeat pointers", async () => {
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
    const state = fixture(value);
    await expectRefusal(state, state.run(), "Failed reading legacy TUI last-session state", null);
  });

  it("rejects unexpected fields before claiming or writing", async () => {
    const { sourcePath, run, read } = fixture({
      terminal: { "": 1, later: 2, ...pointer() },
    });
    const result = run();
    expect(result.warnings).toEqual([
      `Failed reading legacy TUI last-session state ${sourcePath}: Error: legacy TUI last-session record terminal has unexpected field ""`,
    ]);
    expect(fs.readdirSync(path.dirname(sourcePath))).toEqual(["last-session.json"]);
    await expect(read()).resolves.toBeNull();
  });

  it.each([100, 200])("preserves the SQLite pointer at timestamp %s", async (timestamp) => {
    const state = fixture({ terminal: pointer("agent:main:legacy") });
    seedPointer(state.stateDir, timestamp);
    const result = state.run();
    if (timestamp === 100) {
      await expectRefusal(
        state,
        result,
        "divergent JSON and SQLite pointers at the same timestamp",
        "agent:main:current",
      );
    } else {
      expect(result).toMatchObject({
        warnings: [],
        notices: ["Kept 1 newer shared SQLite TUI last-session pointer(s) over legacy JSON"],
      });
      expect(fs.existsSync(state.sourcePath)).toBe(false);
      await expect(state.read()).resolves.toBe("agent:main:current");
    }
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
    await expectRefusal(state, result, warning, session);
    if (hook === "beforeVerify") {
      return;
    }
    expect(state.run().warnings).toEqual([]);
    expect(fs.existsSync(state.sourcePath)).toBe(false);
    await expect(state.read()).resolves.toBe(
      hook === "beforeClaim" ? "agent:main:second" : session,
    );
  });
});
