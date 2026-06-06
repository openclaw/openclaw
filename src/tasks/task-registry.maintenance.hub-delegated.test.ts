// Hub-delegated ACP maintenance clears delegate markers after expiry cleanup.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AcpSessionStoreEntry } from "../acp/runtime/session-meta.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  resetTaskRegistryMaintenanceRuntimeForTests,
  runTaskRegistryMaintenance,
  setTaskRegistryMaintenanceRuntimeForTests,
  stopTaskRegistryMaintenanceForTests,
} from "./task-registry.maintenance.js";

afterEach(() => {
  stopTaskRegistryMaintenanceForTests();
  resetTaskRegistryMaintenanceRuntimeForTests();
});

describe("task-registry maintenance hub-delegated cleanup", () => {
  it("clears hubDelegated after closing expired delegate sessions", async () => {
    await withTempDir({ prefix: "openclaw-hub-delegate-maint-" }, async (home) => {
      const storePath = path.join(home, "agents/codex/sessions/sessions.json");
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      const sessionKey = "agent:codex:acp:expired-delegate";
      const createdAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
      const entry: SessionEntry = {
        sessionId: "sess-expired",
        updatedAt: createdAt,
        label: "refactor",
        hubDelegated: {
          ownerSessionKey: "agent:main:main",
          createdAt,
        },
      };
      fs.writeFileSync(storePath, JSON.stringify({ [sessionKey]: entry }));

      const acpEntry: AcpSessionStoreEntry = {
        cfg: {
          session: { store: storePath },
          acp: { delegate: { idleHours: 72, maxAgeHours: 168 } },
        },
        storePath,
        sessionKey,
        storeSessionKey: sessionKey,
        entry,
        acp: {
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "codex-expired",
          mode: "persistent",
          state: "idle",
          lastActivityAt: createdAt,
        },
      };

      const closeAcpSession = vi.fn(async () => {});

      setTaskRegistryMaintenanceRuntimeForTests({
        listAcpSessionEntries: async () => [acpEntry],
        readAcpSessionEntry: () => acpEntry,
        closeAcpSession,
        loadSessionStore: (targetPath) =>
          JSON.parse(fs.readFileSync(targetPath, "utf8")) as Record<string, SessionEntry>,
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
        maybeDeliverTaskTerminalUpdate: () => {},
        resolveTaskForLookupToken: () => null,
        setTaskCleanupAfterById: () => null,
        isRuntimeAuthoritative: () => true,
        resolveCronJobsStorePath: () => path.join(home, "cron/jobs.json"),
        loadCronJobsStoreSync: () => ({ jobs: [] }),
        readCronRunLogEntriesSync: () => [],
      });

      await runTaskRegistryMaintenance();

      expect(closeAcpSession).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey,
          reason: "delegate-max-age-expired",
        }),
      );
      const persisted = JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<
        string,
        SessionEntry
      >;
      expect(persisted[sessionKey]?.hubDelegated).toBeUndefined();
    });
  });
});
