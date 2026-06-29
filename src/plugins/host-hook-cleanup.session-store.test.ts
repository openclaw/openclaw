// Verifies host hook cleanup behavior for session-store state.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import * as jsonFiles from "../infra/json-files.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { runPluginHostCleanup } from "./host-hook-cleanup.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";

describe("plugin host cleanup session stores", () => {
  let stateDir: string | undefined;
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);

  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
    if (stateDir) {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
    stateDir = undefined;
  });

  it("does not rewrite session stores when cleanup scans find no plugin-owned state", async () => {
    stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-cleanup-noop-"),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    const storePath = path.join(stateDir, "sessions.json");
    await replaceSessionEntry({ sessionKey: "agent:main:main", storePath }, {
      sessionId: "session-id",
      updatedAt: Date.now(),
    } satisfies SessionEntry);
    const writeSpy = vi.spyOn(jsonFiles, "writeTextAtomic");

    const result = await runPluginHostCleanup({
      cfg: { session: { store: storePath } },
      registry: createEmptyPluginRegistry(),
      pluginId: "noop-plugin",
      reason: "disable",
    });

    expect(result).toEqual({ cleanupCount: 0, failures: [] });
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("can defer persistent session-state cleanup to an atomic owner", async () => {
    stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-cleanup-deferred-"),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    const storePath = path.join(stateDir, "sessions.json");
    await replaceSessionEntry({ sessionKey: "agent:main:main", storePath }, {
      sessionId: "session-id",
      updatedAt: Date.now(),
      pluginExtensions: {
        test: {
          state: { active: true },
        },
      },
    } satisfies SessionEntry);

    const result = await runPluginHostCleanup({
      cfg: { session: { store: storePath } },
      registry: createEmptyPluginRegistry(),
      reason: "reset",
      sessionKey: "agent:main:main",
      skipPersistentSessionState: true,
    });

    expect(result).toEqual({ cleanupCount: 0, failures: [] });
    expect(
      loadSessionEntry({ sessionKey: "agent:main:main", storePath })?.pluginExtensions,
    ).toEqual({
      test: {
        state: { active: true },
      },
    });
  });

  it("clears plugin-owned session state across resolved stores without touching unrelated rows", async () => {
    stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-cleanup-multistore-"),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    const firstStorePath = path.join(stateDir, "agents", "a", "sessions", "sessions.json");
    const secondStorePath = path.join(stateDir, "agents", "b", "sessions", "sessions.json");
    const beforeUpdatedAt = 100;
    const unrelatedUpdatedAt = Date.now();
    const firstEntry: SessionEntry = {
      sessionId: "shared-session",
      updatedAt: beforeUpdatedAt,
      pluginExtensions: {
        cleanup: { state: { active: true } },
        other: { state: { preserved: true } },
      },
      pluginNextTurnInjections: {
        cleanup: [
          {
            id: "remove",
            pluginId: "cleanup",
            text: "remove",
            placement: "append_context",
            createdAt: beforeUpdatedAt,
          },
        ],
      },
    };
    const secondEntry: SessionEntry = {
      sessionId: "shared-session",
      updatedAt: beforeUpdatedAt,
      pluginExtensions: {
        cleanup: { state: { active: true } },
      },
    };
    const unrelatedEntry: SessionEntry = {
      sessionId: "unrelated-session",
      updatedAt: unrelatedUpdatedAt,
      pluginExtensions: {
        cleanup: { state: { keep: true } },
      },
    };
    await replaceSessionEntry(
      { sessionKey: "agent:a:telegram:group:shared-room", storePath: firstStorePath },
      firstEntry,
    );
    await replaceSessionEntry(
      { sessionKey: "agent:a:telegram:group:unrelated-room", storePath: firstStorePath },
      unrelatedEntry,
    );
    await replaceSessionEntry(
      { sessionKey: "agent:b:telegram:group:shared-room", storePath: secondStorePath },
      secondEntry,
    );

    const result = await runPluginHostCleanup({
      cfg: { session: { store: firstStorePath } },
      registry: createEmptyPluginRegistry(),
      pluginId: "cleanup",
      reason: "disable",
      sessionKey: "shared-session",
      sessionStorePaths: [firstStorePath, secondStorePath],
    });

    expect(result).toEqual({ cleanupCount: 2, failures: [] });
    const firstMain = loadSessionEntry({
      sessionKey: "agent:a:telegram:group:shared-room",
      storePath: firstStorePath,
    });
    const firstUnrelated = loadSessionEntry({
      sessionKey: "agent:a:telegram:group:unrelated-room",
      storePath: firstStorePath,
    });
    const secondOther = loadSessionEntry({
      sessionKey: "agent:b:telegram:group:shared-room",
      storePath: secondStorePath,
    });
    expect(firstMain?.pluginExtensions).toEqual({
      other: { state: { preserved: true } },
    });
    expect(firstMain?.pluginNextTurnInjections).toBeUndefined();
    expect(firstMain?.updatedAt).toBeGreaterThan(beforeUpdatedAt);
    expect(firstUnrelated).toEqual(unrelatedEntry);
    expect(secondOther?.pluginExtensions).toBeUndefined();
    expect(secondOther?.updatedAt).toBeGreaterThan(beforeUpdatedAt);
  });

  it("clears shared custom SQLite stores for each resolved agent", async () => {
    stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-cleanup-shared-custom-"),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    const sharedStorePath = path.join(stateDir, "custom", "sessions.json");
    const beforeUpdatedAt = 100;
    const entry: SessionEntry = {
      sessionId: "shared-session",
      updatedAt: beforeUpdatedAt,
      pluginExtensions: {
        cleanup: { state: { active: true } },
      },
    };
    await replaceSessionEntry(
      { agentId: "main", sessionKey: "agent:main:main", storePath: sharedStorePath },
      entry,
    );
    await replaceSessionEntry(
      { agentId: "work", sessionKey: "agent:work:main", storePath: sharedStorePath },
      entry,
    );

    const result = await runPluginHostCleanup({
      cfg: {
        session: { store: sharedStorePath },
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      },
      registry: createEmptyPluginRegistry(),
      pluginId: "cleanup",
      reason: "disable",
    });

    expect(result).toEqual({ cleanupCount: 2, failures: [] });
    const main = loadSessionEntry({
      agentId: "main",
      sessionKey: "agent:main:main",
      storePath: sharedStorePath,
    });
    const work = loadSessionEntry({
      agentId: "work",
      sessionKey: "agent:work:main",
      storePath: sharedStorePath,
    });
    expect(main?.pluginExtensions).toBeUndefined();
    expect(main?.updatedAt).toBeGreaterThan(beforeUpdatedAt);
    expect(work?.pluginExtensions).toBeUndefined();
    expect(work?.updatedAt).toBeGreaterThan(beforeUpdatedAt);
  });
});
