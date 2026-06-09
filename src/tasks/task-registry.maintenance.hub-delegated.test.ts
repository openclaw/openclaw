// Hub-delegated ACP maintenance clears delegate markers after expiry cleanup.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpRuntimeError } from "../acp/runtime/errors.js";
import { loadSessionStore } from "../config/sessions/store-load.js";
import {
  readSessionStoreForTest,
  writeSessionStoreForTest,
} from "../config/sessions/test-helpers.js";
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
      runtimeConfigState.cfg = {
        session: { store: storePath },
        acp: { allowedAgents: ["codex"], delegate: { idleHours: 72, maxAgeHours: 168 } },
      };

      const closeAcpSession = vi.fn(async () => {});
      const repairAcpSessionMetadata = vi.fn(async () => {
        const persisted = readSessionStoreForTest(storePath);
        expect(persisted[sessionKey]?.hubDelegated).toBeDefined();
        throw new AcpRuntimeError("ACP_BACKEND_UNAVAILABLE", "backend offline");
      });
      setTaskRegistryMaintenanceRuntimeForTests({
        listAcpSessionEntries: async () => [],
        readAcpSessionEntry: () => ({
          cfg: runtimeConfigState.cfg as never,
          storePath,
          sessionKey,
          storeSessionKey: sessionKey,
          entry: undefined,
          storeReadFailed: false,
        }),
        repairAcpSessionMetadata,
        closeAcpSession,
        loadSessionStore,
        resolveStorePath: () => storePath,
        parseAgentSessionKey: () => ({ agentId: "codex" }) as never,
        isCronJobActive: () => false,
        getAgentRunContext: () => undefined,
        hasActiveAcpTurn: () => false,
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
        resolveCronJobsStorePath: () => path.join(home, "cron/jobs.json"),
        loadCronJobsStoreSync: () => ({ version: 1, jobs: [] }),
        readCronRunLogEntriesSync: () => [],
      });

      await runTaskRegistryMaintenance();

      expect(closeAcpSession).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey,
          reason: "delegate-max-age-expired",
        }),
      );
      expect(repairAcpSessionMetadata).toHaveBeenCalledWith(
        expect.objectContaining({ sessionKey }),
      );
      const persisted = readSessionStoreForTest(storePath);
      expect(persisted[sessionKey]?.hubDelegated).toBeUndefined();
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
      writeSessionStoreForTest(storePath, {
        [sessionKey]: {
          sessionId: "sess-idle-active",
          updatedAt: lastActivityAt,
          label: "long-task",
          hubDelegated: {
            ownerSessionKey: "agent:main:main",
            createdAt,
          },
          acp: {
            lastActivityAt,
            mode: "persistent",
          },
        },
      });
      runtimeConfigState.cfg = {
        session: { store: storePath },
        acp: { allowedAgents: ["codex"], delegate: { idleHours: 72, maxAgeHours: 168 } },
      };

      const closeAcpSession = vi.fn(async () => {});
      setTaskRegistryMaintenanceRuntimeForTests({
        listAcpSessionEntries: async () => [],
        readAcpSessionEntry: () => ({
          cfg: runtimeConfigState.cfg as never,
          storePath,
          sessionKey,
          storeSessionKey: sessionKey,
          entry: readSessionStoreForTest(storePath)[sessionKey],
          acp: {
            lastActivityAt,
            mode: "persistent",
          },
          storeReadFailed: false,
        }),
        closeAcpSession,
        loadSessionStore,
        resolveStorePath: () => storePath,
        parseAgentSessionKey: () => ({ agentId: "codex" }) as never,
        isCronJobActive: () => false,
        getAgentRunContext: () => undefined,
        hasActiveAcpTurn: (activeSessionKey) => activeSessionKey === sessionKey,
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
        resolveCronJobsStorePath: () => path.join(home, "cron/jobs.json"),
        loadCronJobsStoreSync: () => ({ version: 1, jobs: [] }),
        readCronRunLogEntriesSync: () => [],
      });

      await runTaskRegistryMaintenance();

      expect(closeAcpSession).not.toHaveBeenCalled();
      expect(readSessionStoreForTest(storePath)[sessionKey]?.hubDelegated).toBeDefined();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
