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
import { clearRetiredTuiPointers, tuiLastSessionOperations } from "./tui-last-session.kernel.js";

const tempDirs: string[] = [];
const defaultScopeKey = buildTuiLastSessionScopeKey({
  connectionUrl: "ws://127.0.0.1:18789",
  agentId: "Main",
  sessionScope: "per-sender",
});
const resolveForMain = (
  rememberedKey: string,
  sessions: Parameters<typeof resolveRememberedTuiSessionKey>[0]["sessions"],
) => resolveRememberedTuiSessionKey({ rememberedKey, currentAgentId: "main", sessions });

async function expectOffThread(run: () => Promise<void>) {
  const sql = observeMainThreadSql();
  sql.calibrate();
  try {
    await run();
    sql.expectIdle();
  } finally {
    sql.restore();
  }
}

async function createStore() {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tui-last-session-"));
  tempDirs.push(stateDir);
  return {
    stateDir,
    options: { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } },
    read: (scopeKey: string) => readTuiLastSessionKey({ scopeKey, stateDir }),
    write: (scopeKey: string, sessionKey: string) =>
      writeTuiLastSessionKey({ scopeKey, sessionKey, stateDir }),
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("tui last session state", () => {
  it("the worker confines a credential-shaped scope to the TUI namespace", async () => {
    const { options } = await createStore();
    const database = openOpenClawStateDatabase(options);
    const context = captureOpenClawStateWorkerContext(options);
    const open = () => database;
    const unused = () => {
      throw new Error("Unexpected writer route");
    };
    runWithSqliteWorkerStateContext(context, () =>
      tuiLastSessionOperations["tui.lastSession.write"](
        { scopeKey: "authProfiles.store", sessionKey: "agent:main:scoped" },
        {
          open,
          write: unused,
          writeAdmitted: unused,
          stateOptions: () => ({ ...options, path: database.path }),
        },
      ),
    );
    expect(readConfigMachineStateWithMetadata("authProfiles.store", options)).toBeUndefined();
    expect(
      readConfigMachineStateWithMetadata("tui.lastSession.authProfiles.store", options)?.value,
    ).toBe("agent:main:scoped");
  });
  it("reads and clears remembered sessions without creating state on a fresh install", async () => {
    const { stateDir, read } = await createStore();

    await expect(read("missing")).resolves.toBeNull();
    await expect(
      clearTuiLastSessionPointers({ sessionKeys: new Set(["agent:main:retired"]), stateDir }),
    ).resolves.toBe(0);
    await expect(fs.stat(path.join(stateDir, "state", "openclaw.sqlite"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("persists scoped pointers off-thread and clears only retired session ownership", async () => {
    const { stateDir, options, read, write } = await createStore();
    const scopeKey = defaultScopeKey;
    expect(scopeKey).toBe("e433a54b3bcb5ba081907f4ee903ddf5");
    await expectOffThread(async () => {
      await write(scopeKey, "agent:main:main");
      await expect(read(scopeKey)).resolves.toBe("agent:main:main");
    });
    await expect(fs.stat(path.join(stateDir, "tui", "last-session.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    closeOpenClawStateDatabaseForTest();
    await expect(read(scopeKey)).resolves.toBe("agent:main:main");
    await write("remote", "agent:main:telegram:thread");
    await write("other-terminal", "agent:main:main");
    configMachineState.writeConfigMachineState("unrelated", "agent:main:main", options);
    await expectOffThread(async () => {
      expect(
        await clearTuiLastSessionPointers({ stateDir, sessionKeys: new Set(["agent:main:main"]) }),
      ).toBe(2);
      await expect(read(scopeKey)).resolves.toBeNull();
      await expect(read("other-terminal")).resolves.toBeNull();
      await expect(read("remote")).resolves.toBe("agent:main:telegram:thread");
    });
    expect(readConfigMachineStateWithMetadata<string>("unrelated", options)?.value).toBe(
      "agent:main:main",
    );
  });

  it("atomically preserves concurrent updates to independent scopes", async () => {
    const { read, write } = await createStore();
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        write(index % 2 === 0 ? "terminal" : "remote", `agent:main:tui-${index}`),
      ),
    );

    await expect(read("terminal")).resolves.toBe("agent:main:tui-38");
    await expect(read("remote")).resolves.toBe("agent:main:tui-39");
  });

  it.each(["agent:main:tui-123", "tui-123"])(
    "restores %s only from a row belonging to the current agent",
    (rememberedKey) => {
      const sessions = [
        "agent:main:main",
        "agent:ops:tui-123",
        "agent:main:tui-123",
        "agent:ops:tui-999",
      ].map((key) => ({ key }));

      expect(resolveForMain(rememberedKey, sessions)).toBe("agent:main:tui-123");
      expect(resolveForMain(rememberedKey, [{ key: "agent:ops:tui-123" }])).toBeNull();
      expect(resolveForMain("agent:ops:tui-999", sessions)).toBeNull();
      expect(resolveForMain("agent:main:missing", sessions)).toBeNull();
    },
  );

  it.each([
    { key: "agent:main:telegram:direct:123:heartbeat", origin: undefined },
    { key: "agent:main:main", origin: { provider: "heartbeat", surface: "heartbeat" } },
  ])("does not restore heartbeat-owned $key", async (session) => {
    if (!session.origin) {
      const { read, write } = await createStore();
      await write(defaultScopeKey, session.key);
      await expect(read(defaultScopeKey)).resolves.toBeNull();
    }
    expect(resolveForMain(session.key, [session, { key: "agent:main:tui-123" }])).toBeNull();
  });

  it("keeps a live replacement pointer written after the retired-pointer scan", async () => {
    const { options, read, write } = await createStore();
    await write("terminal", "agent:main:retired");
    const database = openOpenClawStateDatabase(options);
    const update = configMachineState.updateConfigMachineState;
    const replaceAfterScan = vi
      .spyOn(configMachineState, "updateConfigMachineState")
      .mockImplementationOnce((stateKey, mutate, selectedOptions) => {
        configMachineState.writeConfigMachineState(stateKey, "agent:main:live", selectedOptions);
        return update(stateKey, mutate, selectedOptions);
      });

    expect(clearRetiredTuiPointers(new Set(["agent:main:retired"]), options, () => database)).toBe(
      0,
    );
    expect(replaceAfterScan).toHaveBeenCalledOnce();
    await expect(read("terminal")).resolves.toBe("agent:main:live");
  });

  it("returns zero without requesting a writer when no restore pointer matches", async () => {
    const { options, read, write } = await createStore();
    await write("terminal", "agent:main:live");
    const context = captureOpenClawStateWorkerContext(options);
    const open = vi.fn(() => {
      throw new Error("Writer admission refused");
    });
    expect(
      runWithSqliteWorkerStateContext(context, () =>
        tuiLastSessionOperations["tui.lastSession.clear"](
          { retiredSessionKeys: ["agent:main:retired"] },
          {
            open,
            write: open,
            writeAdmitted: open,
            stateOptions: () => ({
              path: context.admission.databasePath,
              env: context.environment,
            }),
          },
        ),
      ),
    ).toBe(0);
    expect(open).not.toHaveBeenCalled();
    await expect(read("terminal")).resolves.toBe("agent:main:live");
  });
});

describe("createRememberSessionKeyWriter", () => {
  it("captures the selected scope and joins accepted writes before closing admission", async () => {
    const pending = createDeferredCore();
    const write = vi.fn<typeof writeTuiLastSessionKey>(async () => pending.promise);
    let selectedScope = "main";
    const reportFailure = vi.fn();
    const writer = createRememberSessionKeyWriter({
      buildScopeKey: () => selectedScope,
      reportFailure,
      write,
    });
    await writer.remember("  ");
    await writer.remember("unknown");
    expect(write).not.toHaveBeenCalled();
    const accepted = writer.remember("agent:main:kept");
    selectedScope = "later";
    let closed = false;
    const closing = writer.close().then(() => {
      closed = true;
    });
    await writer.remember("agent:main:late");
    expect(closed).toBe(false);
    expect(write.mock.calls).toEqual([[{ scopeKey: "main", sessionKey: "agent:main:kept" }]]);
    pending.resolve();
    await Promise.all([accepted, closing]);
    expect(closed).toBe(true);
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it("reports the first write failure once and keeps later writes silent", async () => {
    const failures: string[] = [];
    const writer = createRememberSessionKeyWriter({
      buildScopeKey: (sessionKey) => `scope:${sessionKey}`,
      reportFailure: (message) => failures.push(message),
      write: async () => {
        throw new Error("SQLITE_CORRUPT: database disk image is malformed");
      },
    });

    await Promise.all([writer.remember("agent:main:one"), writer.remember("agent:main:two")]);
    await writer.close();

    expect(failures).toEqual(["SQLITE_CORRUPT: database disk image is malformed"]);
  });
});
