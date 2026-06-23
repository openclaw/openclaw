// Verifies host hook cleanup behavior for session-store state.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearSessionStoreCacheForTest,
  loadSessionStore,
  saveSessionStore,
} from "../config/sessions/store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import * as jsonFiles from "../infra/json-files.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { runPluginHostCleanup } from "./host-hook-cleanup.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";

describe("plugin host cleanup session stores", () => {
  let stateDir: string | undefined;
  let previousStateDir: string | undefined;

  afterEach(async () => {
    clearSessionStoreCacheForTest();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    if (stateDir) {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
    stateDir = undefined;
    previousStateDir = undefined;
  });

  it("does not rewrite session stores when cleanup scans find no plugin-owned state", async () => {
    stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-cleanup-noop-"),
    );
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const storePath = path.join(stateDir, "sessions.json");
    await saveSessionStore(
      storePath,
      {
        "agent:main:main": {
          sessionId: "session-id",
          updatedAt: Date.now(),
        } satisfies SessionEntry,
      },
      { skipMaintenance: true },
    );
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
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const storePath = path.join(stateDir, "sessions.json");
    await saveSessionStore(
      storePath,
      {
        "agent:main:main": {
          sessionId: "session-id",
          updatedAt: Date.now(),
          pluginExtensions: {
            test: {
              state: { active: true },
            },
          },
        } satisfies SessionEntry,
      },
      { skipMaintenance: true },
    );

    const result = await runPluginHostCleanup({
      cfg: { session: { store: storePath } },
      registry: createEmptyPluginRegistry(),
      reason: "reset",
      sessionKey: "agent:main:main",
      skipPersistentSessionState: true,
    });

    expect(result).toEqual({ cleanupCount: 0, failures: [] });
    expect(
      loadSessionStore(storePath, { skipCache: true })["agent:main:main"]?.pluginExtensions,
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
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const firstStorePath = path.join(stateDir, "agent-a", "sessions.json");
    const secondStorePath = path.join(stateDir, "agent-b", "sessions.json");
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
    await saveSessionStore(
      firstStorePath,
      {
        "agent:a:main": firstEntry,
        "agent:a:unrelated": unrelatedEntry,
      },
      { skipMaintenance: true },
    );
    await saveSessionStore(
      secondStorePath,
      {
        "agent:b:other": secondEntry,
      },
      { skipMaintenance: true },
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
    const firstStore = loadSessionStore(firstStorePath, { skipCache: true });
    const secondStore = loadSessionStore(secondStorePath, { skipCache: true });
    expect(firstStore["agent:a:main"]?.pluginExtensions).toEqual({
      other: { state: { preserved: true } },
    });
    expect(firstStore["agent:a:main"]?.pluginNextTurnInjections).toBeUndefined();
    expect(firstStore["agent:a:main"]?.updatedAt).toBeGreaterThan(beforeUpdatedAt);
    expect(firstStore["agent:a:unrelated"]).toEqual(unrelatedEntry);
    expect(secondStore["agent:b:other"]?.pluginExtensions).toBeUndefined();
    expect(secondStore["agent:b:other"]?.updatedAt).toBeGreaterThan(beforeUpdatedAt);
  });
});
