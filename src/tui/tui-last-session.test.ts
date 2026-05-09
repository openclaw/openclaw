import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  importLegacyTuiLastSessionStoreToSqlite,
  resolveLegacyTuiLastSessionStatePath,
} from "./tui-last-session-legacy.js";
import {
  buildTuiLastSessionScopeKey,
  clearTuiLastSessionPointers,
  isHeartbeatLikeTuiSession,
  readTuiLastSessionKey,
  resolveRememberedTuiSessionKey,
  writeTuiLastSessionKey,
} from "./tui-last-session.js";

const tempDirs: string[] = [];

async function makeTempStateDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tui-last-session-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("tui last session state", () => {
  it("persists the last session under a scoped hashed key", async () => {
    const stateDir = await makeTempStateDir();
    const scopeKey = buildTuiLastSessionScopeKey({
      connectionUrl: "ws://127.0.0.1:18789",
      agentId: "Main",
      sessionScope: "per-sender",
    });

    await writeTuiLastSessionKey({
      scopeKey,
      sessionKey: "agent:main:tui-123",
      stateDir,
    });

    await expect(readTuiLastSessionKey({ scopeKey, stateDir })).resolves.toBe("agent:main:tui-123");
    await expect(fs.access(resolveLegacyTuiLastSessionStatePath(stateDir))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("restores from SQLite without legacy JSON", async () => {
    const stateDir = await makeTempStateDir();
    const scopeKey = buildTuiLastSessionScopeKey({
      connectionUrl: "local",
      agentId: "main",
      sessionScope: "per-sender",
    });

    await writeTuiLastSessionKey({
      scopeKey,
      sessionKey: "agent:main:tui-sqlite",
      stateDir,
    });
    await expect(fs.access(resolveLegacyTuiLastSessionStatePath(stateDir))).rejects.toMatchObject({
      code: "ENOENT",
    });

    await expect(readTuiLastSessionKey({ scopeKey, stateDir })).resolves.toBe(
      "agent:main:tui-sqlite",
    );
  });

  it("imports legacy JSON into SQLite through the doctor migration helper", async () => {
    const stateDir = await makeTempStateDir();
    const scopeKey = buildTuiLastSessionScopeKey({
      connectionUrl: "legacy",
      agentId: "main",
      sessionScope: "per-sender",
    });
    const statePath = resolveLegacyTuiLastSessionStatePath(stateDir);
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(
      statePath,
      JSON.stringify({ [scopeKey]: { sessionKey: "agent:main:legacy-json", updatedAt: 1000 } }),
    );

    await expect(readTuiLastSessionKey({ scopeKey, stateDir })).resolves.toBeNull();
    await expect(importLegacyTuiLastSessionStoreToSqlite({ stateDir })).resolves.toEqual({
      imported: true,
      pointers: 1,
    });
    await expect(fs.access(statePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readTuiLastSessionKey({ scopeKey, stateDir })).resolves.toBe(
      "agent:main:legacy-json",
    );
  });

  it("removes empty legacy JSON through the doctor migration helper", async () => {
    const stateDir = await makeTempStateDir();
    const statePath = resolveLegacyTuiLastSessionStatePath(stateDir);
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, "{}\n", "utf8");

    await expect(importLegacyTuiLastSessionStoreToSqlite({ stateDir })).resolves.toEqual({
      imported: true,
      pointers: 0,
    });
    await expect(fs.access(statePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("clears stale pointers from SQLite after legacy JSON import", async () => {
    const stateDir = await makeTempStateDir();
    const staleScope = buildTuiLastSessionScopeKey({
      connectionUrl: "stale",
      agentId: "main",
      sessionScope: "per-sender",
    });
    const liveScope = buildTuiLastSessionScopeKey({
      connectionUrl: "live",
      agentId: "main",
      sessionScope: "per-sender",
    });
    await writeTuiLastSessionKey({
      scopeKey: staleScope,
      sessionKey: "agent:main:main",
      stateDir,
    });
    await writeTuiLastSessionKey({
      scopeKey: liveScope,
      sessionKey: "agent:main:tui-live",
      stateDir,
    });
    const legacyScope = buildTuiLastSessionScopeKey({
      connectionUrl: "legacy-stale",
      agentId: "main",
      sessionScope: "per-sender",
    });
    const statePath = resolveLegacyTuiLastSessionStatePath(stateDir);
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(
      statePath,
      JSON.stringify({ [legacyScope]: { sessionKey: "agent:main:legacy-stale", updatedAt: 1000 } }),
    );
    await importLegacyTuiLastSessionStoreToSqlite({ stateDir });

    await expect(
      clearTuiLastSessionPointers({
        stateDir,
        sessionKeys: new Set(["agent:main:main", "agent:main:legacy-stale"]),
      }),
    ).resolves.toBe(2);

    await expect(readTuiLastSessionKey({ scopeKey: staleScope, stateDir })).resolves.toBeNull();
    await expect(readTuiLastSessionKey({ scopeKey: legacyScope, stateDir })).resolves.toBeNull();
    await expect(readTuiLastSessionKey({ scopeKey: liveScope, stateDir })).resolves.toBe(
      "agent:main:tui-live",
    );
    await expect(fs.access(statePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores only a remembered session that still belongs to the current agent", () => {
    const sessions = [
      { key: "agent:main:main" },
      { key: "agent:main:tui-123" },
      { key: "agent:ops:tui-999" },
    ];

    expect(
      resolveRememberedTuiSessionKey({
        rememberedKey: "agent:main:tui-123",
        currentAgentId: "main",
        sessions,
      }),
    ).toBe("agent:main:tui-123");
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
  });

  it("does not persist or restore heartbeat sessions", async () => {
    const stateDir = await makeTempStateDir();
    const scopeKey = buildTuiLastSessionScopeKey({
      connectionUrl: "ws://127.0.0.1:18789",
      agentId: "main",
      sessionScope: "per-sender",
    });

    await writeTuiLastSessionKey({
      scopeKey,
      sessionKey: "agent:main:telegram:direct:123:heartbeat",
      stateDir,
    });

    await expect(readTuiLastSessionKey({ scopeKey, stateDir })).resolves.toBeNull();
    expect(
      resolveRememberedTuiSessionKey({
        rememberedKey: "agent:main:telegram:direct:123:heartbeat",
        currentAgentId: "main",
        sessions: [{ key: "agent:main:telegram:direct:123:heartbeat" }],
      }),
    ).toBeNull();
  });

  it("does not restore heartbeat-origin sessions when resolving a remembered key", () => {
    const sessions = [
      {
        key: "agent:main:main",
        origin: { provider: "heartbeat", surface: "heartbeat" },
      },
      { key: "agent:main:tui-123" },
    ];

    expect(isHeartbeatLikeTuiSession(sessions[0])).toBe(true);
    expect(
      resolveRememberedTuiSessionKey({
        rememberedKey: "agent:main:main",
        currentAgentId: "main",
        sessions,
      }),
    ).toBeNull();
  });
});
