// Hub-delegated ACP maintenance clears delegate markers after expiry cleanup.
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  delegateSessionKey,
  hubDelegatedEntry,
} from "../../test/helpers/hub-delegated-fixtures.js";
import { loadSessionStore } from "../config/sessions/store-load.js";
import {
  readSessionStoreForTest,
  writeSessionStoreForTest,
} from "../config/sessions/test-helpers.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  resetTaskRegistryMaintenanceRuntimeForTests,
  runTaskRegistryMaintenance,
  setTaskRegistryMaintenanceRuntimeForTests,
  stopTaskRegistryMaintenanceForTests,
} from "./task-registry.maintenance.js";

const runtimeConfigState = vi.hoisted(() => ({ cfg: {} as OpenClawConfig }));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => runtimeConfigState.cfg,
}));

afterEach(() => {
  stopTaskRegistryMaintenanceForTests();
  resetTaskRegistryMaintenanceRuntimeForTests();
  runtimeConfigState.cfg = {};
});

function setupMaintenance(params: {
  home: string;
  suffix: string;
  ageMs: number;
  acp?: SessionEntry["acp"];
  active?: boolean;
}) {
  const storePath = path.join(params.home, "agents/codex/sessions/sessions.json");
  const sessionKey = delegateSessionKey("codex", params.suffix);
  const timestamp = Date.now() - params.ageMs;
  const entry = hubDelegatedEntry({
    sessionId: `sess-${params.suffix}`,
    ownerSessionKey: "agent:main:main",
    label: params.suffix,
    createdAt: timestamp,
    updatedAt: timestamp,
    acp: params.acp,
  });
  writeSessionStoreForTest(storePath, { [sessionKey]: entry });
  runtimeConfigState.cfg = {
    session: { store: storePath },
    acp: { allowedAgents: ["codex"], delegate: { idleHours: 72, maxAgeHours: 168 } },
  };
  const closeAcpSession = vi.fn(async () => {});
  setTaskRegistryMaintenanceRuntimeForTests({
    listAcpSessionEntries: async () => [],
    readAcpSessionEntry: () => ({
      cfg: runtimeConfigState.cfg,
      storePath,
      sessionKey,
      storeSessionKey: sessionKey,
      entry,
      acp: params.acp,
      storeReadFailed: false,
    }),
    closeAcpSession,
    loadSessionStore,
    resolveStorePath: () => storePath,
    parseAgentSessionKey: () => ({ agentId: "codex" }) as never,
    isCronJobActive: () => false,
    getAgentRunContext: () => undefined,
    hasActiveAcpTurn: (key) => params.active === true && key === sessionKey,
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
  return { closeAcpSession, sessionKey, storePath };
}

describe("task-registry maintenance hub-delegated cleanup", () => {
  it("clears expired delegates", async () => {
    await withTempDir({ prefix: "openclaw-hub-delegate-maint-" }, async (home) => {
      const fixture = setupMaintenance({ home, suffix: "expired", ageMs: 8 * 24 * 60 * 60_000 });

      await runTaskRegistryMaintenance();

      expect(fixture.closeAcpSession).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: fixture.sessionKey,
          reason: "delegate-max-age-expired",
        }),
      );
      expect(
        readSessionStoreForTest(fixture.storePath)[fixture.sessionKey]?.hubDelegated,
      ).toBeUndefined();
    });
  });

  it("keeps idle-expired delegates while an ACP turn is active", async () => {
    await withTempDir({ prefix: "openclaw-hub-delegate-maint-" }, async (home) => {
      const fixture = setupMaintenance({
        home,
        suffix: "active-turn",
        ageMs: 4 * 24 * 60 * 60_000,
        active: true,
        acp: {
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: delegateSessionKey("codex", "active-turn"),
          mode: "persistent",
          state: "running",
          lastActivityAt: Date.now() - 4 * 24 * 60 * 60_000,
        },
      });

      await runTaskRegistryMaintenance();

      expect(fixture.closeAcpSession).not.toHaveBeenCalled();
      expect(
        readSessionStoreForTest(fixture.storePath)[fixture.sessionKey]?.hubDelegated,
      ).toBeDefined();
    });
  });
});
