// Hub-delegated ACP maintenance clears delegate markers after expiry cleanup.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSessionStore } from "../config/sessions/store-load.js";
import {
  readSessionStoreForTest,
  writeSessionStoreForTest,
} from "../config/sessions/test-helpers.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  resetTaskRegistryMaintenanceRuntimeForTests,
  runTaskRegistryMaintenance,
  setTaskRegistryMaintenanceRuntimeForTests,
  stopTaskRegistryMaintenanceForTests,
} from "./task-registry.maintenance.js";

const runtimeConfigState = vi.hoisted(() => ({
  cfg: {} as {
    session?: { store?: string };
    acp?: { allowedAgents?: string[]; delegate?: { idleHours?: number; maxAgeHours?: number } };
  },
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => runtimeConfigState.cfg,
}));

afterEach(() => {
  stopTaskRegistryMaintenanceForTests();
  resetTaskRegistryMaintenanceRuntimeForTests();
  runtimeConfigState.cfg = {};
});

function installHubDelegatedMaintenanceRuntime(params: {
  home: string;
  storePath: string;
  sessionKey: string;
  closeAcpSession: ReturnType<typeof vi.fn>;
  hasActiveAcpTurn?: (sessionKey: string) => boolean;
  readAcpSessionEntry?: () => {
    cfg: typeof runtimeConfigState.cfg;
    storePath: string;
    sessionKey: string;
    storeSessionKey: string;
    entry?: SessionEntry;
    acp?: SessionEntry["acp"];
    storeReadFailed: boolean;
  };
}) {
  runtimeConfigState.cfg = {
    session: { store: params.storePath },
    acp: { allowedAgents: ["codex"], delegate: { idleHours: 72, maxAgeHours: 168 } },
  };
  setTaskRegistryMaintenanceRuntimeForTests({
    listAcpSessionEntries: async () => [],
    readAcpSessionEntry:
      params.readAcpSessionEntry ??
      (() => ({
        cfg: runtimeConfigState.cfg as never,
        storePath: params.storePath,
        sessionKey: params.sessionKey,
        storeSessionKey: params.sessionKey,
        entry: undefined,
        storeReadFailed: false,
      })),
    closeAcpSession: params.closeAcpSession,
    loadSessionStore,
    resolveStorePath: () => params.storePath,
    parseAgentSessionKey: () => ({ agentId: "codex" }) as never,
    isCronJobActive: () => false,
    getAgentRunContext: () => undefined,
    hasActiveAcpTurn: params.hasActiveAcpTurn ?? (() => false),
    hasActiveTaskForChildSessionKey: () => false,
    deleteTaskRecordById: () => true,
    ensureTaskRegistryReady: () => {},
    getTaskById: () => undefined,
    listTaskRecords: () => [],
    markTaskLostById: () => null,
    markTaskTerminalById: () => null,
    maybeDeliverTaskTerminalUpdate: async () => null,
    resolveTaskForLookupToken: () => undefined,
    setTaskCleanupAfterById: () => null,
    isRuntimeAuthoritative: () => true,
    resolveCronJobsStorePath: () => path.join(params.home, "cron/jobs.json"),
    loadCronJobsStoreSync: () => ({ version: 1, jobs: [] }),
    readCronRunLogEntriesSync: () => [],
  });
}

describe("task-registry maintenance hub-delegated cleanup", () => {
  it("clears hubDelegated after closing expired delegate sessions", async () => {
    const home = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "openclaw-hub-delegate-maint-"));
    try {
      const storePath = path.join(home, "agents/codex/sessions/sessions.json");
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      const sessionKey = "agent:codex:acp:expired-delegate";
      const createdAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
      writeSessionStoreForTest(storePath, {
        [sessionKey]: {
          sessionId: "sess-expired",
          updatedAt: createdAt,
          label: "refactor",
          hubDelegated: {
            ownerSessionKey: "agent:main:main",
            createdAt,
          },
        },
      });
      const closeAcpSession = vi.fn(async () => {});
      installHubDelegatedMaintenanceRuntime({
        home,
        storePath,
        sessionKey,
        closeAcpSession,
      });

      await runTaskRegistryMaintenance();

      expect(closeAcpSession).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey,
          reason: "delegate-max-age-expired",
        }),
      );
      expect(readSessionStoreForTest(storePath)[sessionKey]?.hubDelegated).toBeUndefined();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("skips idle-expired hub-delegated cleanup while an ACP turn is active", async () => {
    const home = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "openclaw-hub-delegate-maint-"));
    try {
      const storePath = path.join(home, "agents/codex/sessions/sessions.json");
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      const sessionKey = "agent:codex:acp:idle-active-turn";
      const createdAt = Date.now() - 4 * 24 * 60 * 60 * 1000;
      const lastActivityAt = Date.now() - 4 * 24 * 60 * 60 * 1000;
      const persistentAcpMeta = {
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: sessionKey,
        mode: "persistent" as const,
        state: "running" as const,
        lastActivityAt,
      };
      writeSessionStoreForTest(storePath, {
        [sessionKey]: {
          sessionId: "sess-idle-active",
          updatedAt: lastActivityAt,
          label: "long-task",
          hubDelegated: {
            ownerSessionKey: "agent:main:main",
            createdAt,
          },
          acp: persistentAcpMeta,
        },
      });
      const closeAcpSession = vi.fn(async () => {});
      installHubDelegatedMaintenanceRuntime({
        home,
        storePath,
        sessionKey,
        closeAcpSession,
        hasActiveAcpTurn: (activeSessionKey) => activeSessionKey === sessionKey,
        readAcpSessionEntry: () => ({
          cfg: runtimeConfigState.cfg as never,
          storePath,
          sessionKey,
          storeSessionKey: sessionKey,
          entry: readSessionStoreForTest(storePath)[sessionKey],
          acp: persistentAcpMeta,
          storeReadFailed: false,
        }),
      });

      await runTaskRegistryMaintenance();

      expect(closeAcpSession).not.toHaveBeenCalled();
      expect(readSessionStoreForTest(storePath)[sessionKey]?.hubDelegated).toBeDefined();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
