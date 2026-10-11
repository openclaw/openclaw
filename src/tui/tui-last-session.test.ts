// Verifies last-session persistence and lookup for TUI launch.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as configMachineState from "../state/config-machine-state-write.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { executeSharedStateCommand } from "../state/openclaw-state-worker-runtime.js";
import { readConfigMachineStateWithMetadata } from "../test-utils/config-machine-state.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  buildTuiLastSessionScopeKey,
  clearTuiLastSessionPointers,
  createRememberSessionKeyWriter,
  readTuiLastSessionKey,
  resolveRememberedTuiSessionKey,
  writeTuiLastSessionKey,
} from "./tui-last-session.js";
import { clearRetiredTuiPointers } from "./tui-last-session.kernel.js";

const tempDirs: string[] = [];

async function makeTempStateDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tui-last-session-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("tui last session state", () => {
  it("reads and clears remembered sessions without creating state on a fresh install", async () => {
    const stateDir = await makeTempStateDir();

    await expect(readTuiLastSessionKey({ scopeKey: "missing", stateDir })).resolves.toBeNull();
    await expect(
      clearTuiLastSessionPointers({ sessionKeys: new Set(["agent:main:retired"]), stateDir }),
    ).resolves.toBe(0);
    await expect(fs.stat(path.join(stateDir, "state", "openclaw.sqlite"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("persists scoped pointers off-thread and clears only retired session ownership", async () => {
    const stateDir = await makeTempStateDir();
    const scopeKey = buildTuiLastSessionScopeKey({
      connectionUrl: "ws://127.0.0.1:18789",
      agentId: "Main",
      sessionScope: "per-sender",
    });
    const read = (scope: string) => readTuiLastSessionKey({ scopeKey: scope, stateDir });
    const write = (scope: string, sessionKey: string) =>
      writeTuiLastSessionKey({ scopeKey: scope, sessionKey, stateDir });
    const sql = observeMainThreadSql();
    sql.calibrate();
    try {
      await write(scopeKey, "agent:main:main");
      await expect(read(scopeKey)).resolves.toBe("agent:main:main");
      sql.expectIdle();
    } finally {
      sql.restore();
    }
    const options = { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
    expect(
      readConfigMachineStateWithMetadata<string>(`tui.lastSession.${scopeKey}`, options),
    ).toEqual({ value: "agent:main:main", updatedAtMs: expect.any(Number) });
    await expect(fs.stat(path.join(stateDir, "tui", "last-session.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    closeOpenClawStateDatabaseForTest();
    await expect(read(scopeKey)).resolves.toBe("agent:main:main");
    await write("remote", "agent:main:telegram:thread");
    await write("other-terminal", "agent:main:main");
    configMachineState.writeConfigMachineState(
      "unrelated.sessionReference",
      "agent:main:main",
      options,
    );
    const clearingSql = observeMainThreadSql();
    clearingSql.calibrate();
    try {
      expect(
        await clearTuiLastSessionPointers({ stateDir, sessionKeys: new Set(["agent:main:main"]) }),
      ).toBe(2);
      await expect(read(scopeKey)).resolves.toBeNull();
      await expect(read("other-terminal")).resolves.toBeNull();
      await expect(read("remote")).resolves.toBe("agent:main:telegram:thread");
      clearingSql.expectIdle();
    } finally {
      clearingSql.restore();
    }
    expect(
      readConfigMachineStateWithMetadata<string>("unrelated.sessionReference", options)?.value,
    ).toBe("agent:main:main");
  });

  it("atomically preserves concurrent updates to independent scopes", async () => {
    const stateDir = await makeTempStateDir();
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        writeTuiLastSessionKey({
          scopeKey: index % 2 === 0 ? "terminal" : "remote",
          sessionKey: `agent:main:tui-${index}`,
          stateDir,
        }),
      ),
    );

    await expect(readTuiLastSessionKey({ scopeKey: "terminal", stateDir })).resolves.toBe(
      "agent:main:tui-38",
    );
    await expect(readTuiLastSessionKey({ scopeKey: "remote", stateDir })).resolves.toBe(
      "agent:main:tui-39",
    );
  });

  it.each(["agent:main:tui-123", "tui-123"])(
    "restores %s only from a row belonging to the current agent",
    (rememberedKey) => {
      const sessions = [
        { key: "agent:main:main" },
        { key: "agent:ops:tui-123" },
        { key: "agent:main:tui-123" },
        { key: "agent:ops:tui-999" },
      ];

      expect(
        resolveRememberedTuiSessionKey({
          rememberedKey,
          currentAgentId: "main",
          sessions,
        }),
      ).toBe("agent:main:tui-123");
      expect(
        resolveRememberedTuiSessionKey({
          rememberedKey,
          currentAgentId: "main",
          sessions: [{ key: "agent:ops:tui-123" }],
        }),
      ).toBeNull();
      expect(
        resolveRememberedTuiSessionKey({
          rememberedKey: "agent:ops:tui-999",
          currentAgentId: "main",
          sessions,
        }),
      ).toBeNull();
      expect(
        resolveRememberedTuiSessionKey({
          rememberedKey: "agent:main:missing",
          currentAgentId: "main",
          sessions,
        }),
      ).toBeNull();
    },
  );

  it.each([
    { key: "agent:main:telegram:direct:123:heartbeat", origin: undefined },
    { key: "agent:main:main", origin: { provider: "heartbeat", surface: "heartbeat" } },
  ])("does not restore heartbeat-owned $key", async (session) => {
    if (!session.origin) {
      const stateDir = await makeTempStateDir();
      const scopeKey = buildTuiLastSessionScopeKey({
        connectionUrl: "ws://127.0.0.1:18789",
        agentId: "main",
        sessionScope: "per-sender",
      });
      await writeTuiLastSessionKey({ scopeKey, sessionKey: session.key, stateDir });
      await expect(readTuiLastSessionKey({ scopeKey, stateDir })).resolves.toBeNull();
    }
    expect(
      resolveRememberedTuiSessionKey({
        rememberedKey: session.key,
        currentAgentId: "main",
        sessions: [session, { key: "agent:main:tui-123" }],
      }),
    ).toBeNull();
  });

  it("keeps a live replacement pointer written after the retired-pointer scan", async () => {
    const stateDir = await makeTempStateDir();
    await writeTuiLastSessionKey({
      scopeKey: "terminal",
      sessionKey: "agent:main:retired",
      stateDir,
    });
    const options = { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
    const database = openOpenClawStateDatabase(options);
    const update = configMachineState.updateConfigMachineState;
    const replaceAfterScan = vi
      .spyOn(configMachineState, "updateConfigMachineState")
      .mockImplementationOnce((stateKey, mutate, selectedOptions) => {
        configMachineState.writeConfigMachineState(stateKey, "agent:main:live", selectedOptions);
        return update(stateKey, mutate, selectedOptions);
      });

    try {
      expect(
        clearRetiredTuiPointers(new Set(["agent:main:retired"]), options, () => database),
      ).toBe(0);
      expect(replaceAfterScan).toHaveBeenCalledOnce();
      await expect(readTuiLastSessionKey({ scopeKey: "terminal", stateDir })).resolves.toBe(
        "agent:main:live",
      );
    } finally {
      replaceAfterScan.mockRestore();
    }
  });

  it("returns zero without requesting a writer when no restore pointer matches", async () => {
    const stateDir = await makeTempStateDir();
    await writeTuiLastSessionKey({ scopeKey: "terminal", sessionKey: "agent:main:live", stateDir });
    const context = captureOpenClawStateWorkerContext({
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    const open = vi.fn(() => {
      throw new Error("Writer admission refused");
    });
    expect(
      runWithSqliteWorkerStateContext(context, () =>
        executeSharedStateCommand(
          { type: "tui.lastSession.clear", input: { retiredSessionKeys: ["agent:main:retired"] } },
          { databasePath: context.admission.databasePath },
          open,
          open,
          open,
          open,
        ),
      ),
    ).toBe(0);
    expect(open).not.toHaveBeenCalled();
    await expect(readTuiLastSessionKey({ scopeKey: "terminal", stateDir })).resolves.toBe(
      "agent:main:live",
    );
  });
});

describe("createRememberSessionKeyWriter", () => {
  it("captures the selected scope and joins accepted writes before closing admission", async () => {
    const pending = createDeferredCore();
    const writes: Array<{ scopeKey: string; sessionKey: string }> = [];
    let selectedScope = "main";
    const reportFailure = vi.fn();
    const writer = createRememberSessionKeyWriter({
      buildScopeKey: () => selectedScope,
      reportFailure,
      write: async (input) => {
        writes.push(input);
        await pending.promise;
      },
    });
    await writer.remember("  ");
    await writer.remember("unknown");
    expect(writes).toEqual([]);
    const accepted = writer.remember("agent:main:kept");
    selectedScope = "later";
    let closed = false;
    const closing = writer.close().then(() => {
      closed = true;
    });
    await writer.remember("agent:main:late");
    expect(closed).toBe(false);
    expect(writes).toEqual([{ scopeKey: "main", sessionKey: "agent:main:kept" }]);
    pending.resolve();
    await Promise.all([accepted, closing]);
    expect(closed).toBe(true);
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it("reports the first write failure once and keeps later writes silent", async () => {
    const failures: string[] = [];
    const write = async () => {
      throw new Error("SQLITE_CORRUPT: database disk image is malformed");
    };
    const writer = createRememberSessionKeyWriter({
      buildScopeKey: (sessionKey) => `scope:${sessionKey}`,
      reportFailure: (message) => failures.push(message),
      write,
    });

    await Promise.all([writer.remember("agent:main:one"), writer.remember("agent:main:two")]);
    await writer.close();

    expect(failures).toEqual(["SQLITE_CORRUPT: database disk image is malformed"]);
  });
});
