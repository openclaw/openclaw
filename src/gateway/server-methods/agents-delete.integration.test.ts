// Prepare Gateway workers during collection, outside test deadlines.
import "../server-start.js";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { createAgent } from "../../agents/agent-create.js";
import {
  clearActiveEmbeddedRun,
  isEmbeddedAgentRunInProgress,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../agents/embedded-agent-runner/runs.test-support.js";
import {
  getRuntimeConfig,
  resetConfigRuntimeState,
  withConfigMutationExclusive,
} from "../../config/config.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import {
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.sqlite-entry.js";
import * as sessionInventory from "../../config/sessions/session-entry-read-runtime.js";
import type {
  NativeBindingTestApi,
  NativeBindingClientTestApi,
} from "../../config/sessions/session-native-binding.test-support.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { CronService } from "../../cron/service.js";
import { appendSessionTranscriptMessageByIdentity } from "../../plugin-sdk/session-transcript-runtime.js";
import { createPluginRuntimeMock } from "../../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { createPluginStateRuntimeStores } from "../../plugin-state/plugin-state-store.js";
import { registerMemoryCapability } from "../../plugins/memory-state.js";
import { getPluginRegistryState } from "../../plugins/runtime-state.js";
import { disposePluginRegistryInstances } from "../../plugins/runtime.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { readAgentDeletionJournal } from "../../state/agent-deletion-journal.js";
import * as agentDatabases from "../../state/openclaw-agent-db.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import * as agentExecutions from "../../state/openclaw-agent-execution.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../state/openclaw-state-schema.js";
import { beginAgentDeletionJournal } from "../../test-utils/agent-deletion-journal.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock } from "../../test-utils/port-claims.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import * as deletionRecovery from "../server-agent-deletion-recovery.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createGatewayMemoryCloseRegistryFactory } from "../server-close.memory.test-support.js";
import { startGatewayServer } from "../server.js";
import { connectGatewayClient, disconnectGatewayClient } from "../test-helpers.e2e.js";

const nativeApi = await loadBundledPluginFacade<NativeBindingTestApi & NativeBindingClientTestApi>({
  pluginId: "codex",
  artifactBasename: "native-session-binding.test-api.js",
});

let scenarioWork: Promise<void> | undefined;
afterEach(async () => {
  // Vitest deadlines do not join the timed-out body before the next fixture changes process.env.
  await scenarioWork;
  scenarioWork = undefined;
});

async function exerciseLateSessionWritesDuringDeletion(params: {
  state: OpenClawTestState;
  client: Awaited<ReturnType<typeof connectGatewayClient>>;
  agentId: string;
  workspace: string;
  signal: AbortSignal;
}): Promise<void> {
  const { state, client, agentId, workspace, signal } = params;
  const databasePath = path.join(state.agentDir(agentId), "openclaw-agent.sqlite");
  const storePath = path.join(state.sessionsDir(agentId), "sessions.json");
  let session = await client.request<{ key: string; sessionId: string }>("sessions.create", {
    agentId,
    key: `agent:${agentId}:late-write-0`,
  });
  // Two cycles cover every held phase before and after same-agent recreation.
  for (let iteration = 0; iteration < 2; iteration += 1) {
    signal.throwIfAborted();
    const aborted = createDeferred();
    const closed = createDeferred();
    const releaseClosed = createDeferred();
    const purgeCaptured = createDeferred();
    const releasePurge = createDeferred();
    const handle = createEmbeddedRunHandle({
      runId: `deletion-late-write-${iteration}`,
      abort: () => aborted.resolve(),
    });
    const realCloseDatabase = agentDatabases.closeOpenClawAgentDatabaseByPathAsync;
    let closeHeld = false;
    const closeDatabase = vi
      .spyOn(agentDatabases, "closeOpenClawAgentDatabaseByPathAsync")
      .mockImplementation(async (...args) => {
        const result = await realCloseDatabase(...args);
        if (!closeHeld && args[0] === databasePath) {
          closeHeld = true;
          closed.resolve();
          await releaseClosed.promise;
        }
        return result;
      });
    const realCaptureCleanup = agentExecutions.captureAgentDeletionDatabaseExecution;
    let purgeHeld = false;
    const captureCleanup = vi
      .spyOn(agentExecutions, "captureAgentDeletionDatabaseExecution")
      .mockImplementation(async (...args) => {
        const execution = await realCaptureCleanup(...args);
        if (!purgeHeld && args[0].agentId === agentId && args[0].path === databasePath) {
          purgeHeld = true;
          purgeCaptured.resolve();
          await releasePurge.promise;
        }
        return execution;
      });
    const captureOrdinary = vi.spyOn(agentExecutions, "captureOpenClawAgentDatabaseExecution");
    const refuseLatePatch = async (checkpoint: string) => {
      const capturesBefore = captureOrdinary.mock.calls.filter(
        ([options]) => options.agentId === agentId,
      ).length;
      const update = vi.fn(() => ({ label: `late-${iteration}-${checkpoint}` }));
      await expect(
        patchSessionEntryCore(
          { agentId, env: state.env, sessionKey: session.key, storePath },
          update,
          { skipMaintenance: true },
        ),
        `iteration ${iteration}, ${checkpoint}`,
      ).rejects.toThrow(/deletion is draining active work/);
      expect(update).not.toHaveBeenCalled();
      expect(
        captureOrdinary.mock.calls.filter(([options]) => options.agentId === agentId),
        `iteration ${iteration}, ${checkpoint} must not acquire an executor`,
      ).toHaveLength(capturesBefore);
    };
    setActiveEmbeddedRun(session.sessionId, handle, session.key, undefined, agentId);
    // The test owns the deadline while deliberately holding all three deletion phases.
    const deleting = client.request(
      "agents.delete",
      { agentId, deleteFiles: true },
      { signal, timeoutMs: null },
    );
    void deleting.catch(() => {});
    try {
      await withinTest(
        awaitGateBeforeSettlement(aborted.promise, deleting, "deletion did not abort its run"),
        signal,
      );
      expect(readAgentDeletionJournal(agentId)?.phase).toBe("draining");
      expect(isEmbeddedAgentRunInProgress(session.sessionId)).toBe(true);
      await refuseLatePatch("before-run-settlement");
      clearActiveEmbeddedRun(session.sessionId, handle, session.key);

      await withinTest(
        awaitGateBeforeSettlement(closed.promise, deleting, "deletion did not close its database"),
        signal,
      );
      expect(readAgentDeletionJournal(agentId)?.phase).toBe("retiring");
      expect(getRuntimeConfig().agents?.entries).toHaveProperty(agentId);
      await refuseLatePatch("after-clean-close-before-config-reload");
      releaseClosed.resolve();

      await withinTest(
        awaitGateBeforeSettlement(
          purgeCaptured.promise,
          deleting,
          "deletion did not capture its purge executor",
        ),
        signal,
      );
      expect(readAgentDeletionJournal(agentId)?.phase).toBe("retiring");
      await refuseLatePatch("during-purge");
      releasePurge.resolve();
      await expect(
        withinTest(deleting, signal),
        `deletion iteration ${iteration}`,
      ).resolves.toMatchObject({
        ok: true,
        failed: [],
        removed: expect.arrayContaining([{ path: workspace, method: "trash" }]),
      });
      expect(await deleting).not.toHaveProperty("purgeFailed");
      expect(readAgentDeletionJournal(agentId)?.cleanupCompleted).toBe(true);
      for (const pathname of [
        workspace,
        state.agentDir(agentId),
        state.sessionsDir(agentId),
        databasePath,
      ]) {
        await expect(fs.stat(pathname)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      clearActiveEmbeddedRun(session.sessionId, handle, session.key);
      releaseClosed.resolve();
      releasePurge.resolve();
      await Promise.allSettled([deleting]);
      captureOrdinary.mockRestore();
      captureCleanup.mockRestore();
      closeDatabase.mockRestore();
    }
    await expect(
      client.request("agents.create", { name: agentId, workspace }),
    ).resolves.toMatchObject({
      ok: true,
      agentId,
    });
    expect(readAgentDeletionJournal(agentId)).toBeUndefined();
    session = await client.request<{ key: string; sessionId: string }>("sessions.create", {
      agentId,
      key: `agent:${agentId}:late-write-${iteration + 1}`,
    });
    expect(session.sessionId).toBeTruthy();
  }
}

it.for(["active", "restart-draining", "legacy-retiring"] as const)(
  "deletes real agent storage and permits recreation after %s",
  async (scenario, { signal }) => {
    await (scenarioWork = withOpenClawTestState(
      {
        label: `agent-delete-${scenario}`,
        env: {
          OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        },
      },
      async (state) => {
        const sharedDatabasePath = resolveOpenClawStateSqlitePath(state.env);
        if (scenario === "legacy-retiring") {
          await fs.mkdir(path.dirname(sharedDatabasePath), { recursive: true });
          const legacy = new DatabaseSync(sharedDatabasePath);
          try {
            // Main's v20 journal predates the nullable deletion phase.
            legacy.exec(`CREATE TABLE agent_deletion_journal (
              agent_id TEXT PRIMARY KEY,
              operation_id TEXT NOT NULL DEFAULT '',
              agent_dir TEXT NOT NULL,
              workspace_dir TEXT NOT NULL,
              sessions_dir TEXT NOT NULL,
              database_paths_json TEXT NOT NULL DEFAULT '[]',
              cleanup_paths_json TEXT NOT NULL DEFAULT '[]',
              created_at INTEGER NOT NULL,
              cleanup_completed INTEGER NOT NULL DEFAULT 0,
              delete_files INTEGER NOT NULL DEFAULT 1
            ) STRICT;`);
            legacy.exec(OPENCLAW_STATE_SCHEMA_SQL);
            legacy.exec(`PRAGMA user_version = 20;
              INSERT INTO schema_meta (meta_key, role, schema_version, created_at, updated_at)
                VALUES ('primary', 'global', 20, 1, 1);
              INSERT INTO config_machine_state (state_key, value_json, updated_at_ms)
                VALUES ('state.schema.contentVersion', '20', 1);`);
          } finally {
            legacy.close();
          }
        }
        await state.writeConfig({
          gateway: { mode: "local", auth: { mode: "token", token: "agent-delete-test-token" } },
          agents: {
            ownership: "explicit",
            defaults: {
              model: "openai/gpt-4.1",
              skipBootstrap: true,
              heartbeat: { every: "0m" },
            },
            entries: { keeper: { workspace: state.workspaceDir } },
          },
          plugins: { slots: { memory: "none" } },
        });
        const workspace = state.path("workspace-doomed");
        const created = await createAgent({ name: "doomed", workspace, skipBootstrap: true });
        signal.throwIfAborted();
        expect(created.status).toBe("created");
        const agentId = "doomed";
        const sessionId = "deletion-active-session";
        const sessionKey = `agent:${agentId}:active`;
        const databasePath = path.join(state.agentDir(agentId), "openclaw-agent.sqlite");
        const session = {
          sessionId,
          updatedAt: 1,
          ...(scenario === "active"
            ? { agentHarnessId: "codex", lifecycleRevision: "native-binding-generation" }
            : {}),
        };
        runOpenClawAgentWriteTransaction(
          (database) => writeSessionEntry(database, sessionKey, session, { previousEntry: null }),
          { agentId, path: databasePath, env: state.env },
        );
        await fs.mkdir(state.sessionsDir(agentId), { recursive: true });
        await fs.writeFile(
          path.join(state.sessionsDir(agentId), "owned-attachment.txt"),
          "synthetic",
        );
        await fs.writeFile(path.join(workspace, "owned-work.txt"), "synthetic");
        const scheduler = createTestGatewayScheduler();
        const cron = new CronService({
          scheduler,
          storePath: state.statePath("cron/jobs.json"),
          cronEnabled: false,
          log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          enqueueSystemEvent: vi.fn(),
          requestHeartbeat: vi.fn(),
          runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
        });
        const context = createDirectChatContext({ cron, getRuntimeConfig });
        try {
          if (scenario === "active") {
            const claim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
            const hotReloadRecovery = vi.fn(() => {
              throw new Error("Synthetic Gateway hot reload unexpectedly required recovery");
            });
            const startupRecovery = createDeferred();
            const resumeDeletions = deletionRecovery.resumeAgentDeletions;
            const recovery = vi
              .spyOn(deletionRecovery, "resumeAgentDeletions")
              .mockImplementation(async (...args) => {
                const recovering = resumeDeletions(...args);
                void recovering.then(startupRecovery.resolve, startupRecovery.reject);
                await recovering;
              });
            const server = await startGatewayServer(claim.port, {
              bind: "loopback",
              auth: { mode: "token", token: "agent-delete-test-token" },
              controlUiEnabled: false,
              hotReloadRecovery,
            });
            try {
              await server.startupSettled;
              // Recovery starts after sidecar readiness; join it before creating a pending journal.
              await withinTest(startupRecovery.promise, signal);
              recovery.mockRestore();
              signal.throwIfAborted();
              const client = await connectGatewayClient({
                url: `ws://127.0.0.1:${claim.port}`,
                token: "agent-delete-test-token",
                scopes: ["operator.admin", "operator.read", "operator.write"],
              });
              const native = nativeApi.createNativeBindingDeletionFixture(
                createPluginRuntimeMock({
                  state: createPluginStateRuntimeStores("codex", () => signal.throwIfAborted()),
                }),
                { agentId, sessionId, sessionKey },
              );
              const finishedKey = `agent:${agentId}:finished`;
              const finishedId = "deletion-finished-session";
              runOpenClawAgentWriteTransaction(
                (database) =>
                  writeSessionEntry(
                    database,
                    finishedKey,
                    { ...session, sessionId: finishedId },
                    { previousEntry: null },
                  ),
                { agentId, path: databasePath, env: state.env },
              );
              const finishedNative = nativeApi.createNativeBindingDeletionFixture(
                createPluginRuntimeMock({
                  state: createPluginStateRuntimeStores("codex", () => signal.throwIfAborted()),
                }),
                { agentId, sessionId: finishedId, sessionKey: finishedKey },
              );
              const nativeClient = await nativeApi.attachNativeBindingDeletionClient(
                native.store,
                native.key,
              );
              const registry = getPluginRegistryState()?.activeRegistry;
              if (!registry) {
                throw new Error("Gateway did not publish its plugin registry");
              }
              const plugin = createPluginRecord({ id: "codex" });
              const registration = {
                pluginId: "codex",
                source: "runtime",
                harness: native.harness,
              };
              registry.plugins.push(plugin);
              registry.agentHarnesses.push(registration);
              try {
                const readSummaries = sessionInventory.readSessionEntrySummariesInWorker;
                const inventory = vi
                  .spyOn(sessionInventory, "readSessionEntrySummariesInWorker")
                  .mockImplementation(async (scope) => {
                    if (scope.agentId === agentId) {
                      throw new Error("synthetic inventory failure");
                    }
                    return readSummaries(scope);
                  });
                await expect(
                  client.request("agents.delete", { agentId, deleteFiles: true }),
                ).rejects.toThrow("synthetic inventory failure");
                inventory.mockRestore();
                expect(readAgentDeletionJournal(agentId)).toMatchObject({
                  phase: "draining",
                  cleanupCompleted: false,
                });
                for (const [method, params] of [
                  ["sessions.patch", { key: sessionKey, label: "refused" }],
                  ["sessions.create", { agentId, key: `agent:${agentId}:refused` }],
                  [
                    "chat.send",
                    { sessionKey, message: "refused", idempotencyKey: "pending-deletion" },
                  ],
                ] as const) {
                  await expect(client.request(method, params)).rejects.toThrow(
                    "deletion cleanup is still pending",
                  );
                }
                const aborted = createDeferred();
                const handle = createEmbeddedRunHandle({
                  runId: "deletion-active-run",
                  abort: () => aborted.resolve(),
                });
                setActiveEmbeddedRun(sessionId, handle, sessionKey, undefined, agentId);
                const deleting = client.request(
                  "agents.delete",
                  { agentId, deleteFiles: true },
                  { timeoutMs: 10_000 },
                );
                try {
                  await withinTest(
                    awaitGateBeforeSettlement(
                      aborted.promise,
                      deleting,
                      "deletion completed before aborting the active run",
                    ),
                    signal,
                  );
                  expect(readAgentDeletionJournal(agentId)?.phase).toBe("draining");
                  expect(isEmbeddedAgentRunInProgress(sessionId)).toBe(true);
                  const relocatedWorkspace = state.path("workspace-relocated");
                  await expect(
                    client.request("agents.update", { agentId, workspace: relocatedWorkspace }),
                  ).rejects.toThrow(/deletion cleanup is still pending/);
                  expect(getRuntimeConfig().agents?.entries?.[agentId]?.workspace).toBe(workspace);
                  await expect(fs.stat(relocatedWorkspace)).rejects.toMatchObject({
                    code: "ENOENT",
                  });
                  // Cancellation checkpoints remain writable until the retained run settles.
                  await withinTest(
                    withConfigMutationExclusive(async () => {
                      runOpenClawAgentWriteTransaction(
                        (database) =>
                          writeSessionEntry(
                            database,
                            sessionKey,
                            { ...session, updatedAt: 2, label: "aborted" },
                            { previousEntry: session },
                          ),
                        { agentId, path: databasePath, env: state.env },
                      );
                    }),
                    signal,
                  );
                } finally {
                  const started = performance.now();
                  clearActiveEmbeddedRun(sessionId, handle, sessionKey);
                  await deleting;
                  expect(performance.now() - started).toBeLessThan(10_000);
                }
                expect(await deleting).toMatchObject({
                  ok: true,
                  failed: [],
                  removed: expect.arrayContaining([{ path: workspace, method: "trash" }]),
                });
                expect(await deleting).not.toHaveProperty("purgeFailed");
                expect(native.store.lookup(native.key)).toBeUndefined();
                expect(finishedNative.store.lookup(finishedNative.key)).toBeUndefined();
                expect(nativeClient.subscribed()).toBe(false);
                expect(isEmbeddedAgentRunInProgress(sessionId)).toBe(false);
                expect(readAgentDeletionJournal(agentId)?.cleanupCompleted).toBe(true);
                await expect(
                  client.request("sessions.create", { agentId, key: `agent:${agentId}:gone` }),
                ).rejects.toThrow();
                for (const pathname of [
                  workspace,
                  state.agentDir(agentId),
                  state.sessionsDir(agentId),
                  databasePath,
                ]) {
                  await expect(fs.stat(pathname)).rejects.toMatchObject({ code: "ENOENT" });
                }
                await expect(
                  client.request("agents.create", { name: agentId, workspace }),
                ).resolves.toMatchObject({ ok: true, agentId });
                expect(readAgentDeletionJournal(agentId)).toBeUndefined();

                const recreatedSession = await client.request<{ key: string; sessionId: string }>(
                  "sessions.create",
                  { agentId, key: `agent:${agentId}:recreated` },
                );
                for (const message of [
                  { role: "user", content: "Remember the synthetic blue preference." },
                  { role: "assistant", content: "The completed turn recorded blue." },
                ]) {
                  await appendSessionTranscriptMessageByIdentity({
                    agentId,
                    sessionId: recreatedSession.sessionId,
                    sessionKey: recreatedSession.key,
                    storePath: path.join(state.sessionsDir(agentId), "sessions.json"),
                    cwd: workspace,
                    message,
                  });
                }
                expect(isEmbeddedAgentRunInProgress(recreatedSession.sessionId)).toBe(false);
                const memoryConfig: OpenClawConfig = {
                  ...getRuntimeConfig(),
                  memory: {
                    search: {
                      provider: "none",
                      sources: ["sessions"],
                      rememberAcrossConversations: true,
                      store: { vector: { enabled: false } },
                    },
                  },
                };
                const createMemory = createGatewayMemoryCloseRegistryFactory(memoryConfig);
                const memory = createMemory(async () => {});
                const priorMemoryCapabilities = [...registry.memoryCapabilities];
                const scanStarted = createDeferred();
                const releaseScan = createDeferred();
                const memoryCloseStarted = createDeferred();
                const databaseRetirementStarted = createDeferred();
                const realCloseDatabase = agentDatabases.closeOpenClawAgentDatabaseByPathAsync;
                const closeDatabase = vi
                  .spyOn(agentDatabases, "closeOpenClawAgentDatabaseByPathAsync")
                  .mockImplementation(async (...args) => {
                    if (args[0] === databasePath) {
                      databaseRetirementStarted.resolve();
                    }
                    return await realCloseDatabase(...args);
                  });
                const realReaddir = fs.readdir;
                let scanHeld = false;
                const readdir = vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
                  if (!scanHeld && path.resolve(String(args[0])) === state.sessionsDir(agentId)) {
                    scanHeld = true;
                    scanStarted.resolve();
                    await releaseScan.promise;
                  }
                  return await realReaddir(...args);
                });
                registerMemoryCapability("memory-fixture", {
                  runtime: {
                    ...memory.runtime,
                    async closeMemorySearchManager(params) {
                      memoryCloseStarted.resolve();
                      await memory.runtime.closeMemorySearchManager?.(params);
                    },
                  },
                });
                let deletingRecreated: Promise<unknown> | undefined;
                try {
                  const opened = await memory.runtime.getMemorySearchManager({
                    cfg: memoryConfig,
                    agentId,
                  });
                  expect(opened.manager, opened.error).not.toBeNull();
                  await withinTest(scanStarted.promise, signal);
                  const database = getOpenClawAgentDatabaseIfOpen({
                    agentId,
                    path: databasePath,
                    env: state.env,
                  });
                  expect(database?.db.isOpen).toBe(true);
                  deletingRecreated = client.request("agents.delete", {
                    agentId,
                    deleteFiles: true,
                  });
                  void deletingRecreated.catch(() => {});
                  await withinTest(
                    awaitGateBeforeSettlement(
                      awaitGateBeforeSettlement(
                        memoryCloseStarted.promise,
                        databaseRetirementStarted.promise,
                        "agent database retirement began before its memory manager drained",
                      ),
                      deletingRecreated,
                      "agent deletion completed without draining its memory manager",
                    ),
                    signal,
                  );
                  // Accepted transcript discovery still owns its database until it settles.
                  expect(readAgentDeletionJournal(agentId)?.phase).toBe("draining");
                  expect(database?.db.isOpen).toBe(true);
                  releaseScan.resolve();
                  await expect(deletingRecreated).resolves.toMatchObject({
                    ok: true,
                    failed: [],
                    removed: expect.arrayContaining([{ path: workspace, method: "trash" }]),
                  });
                  expect(await deletingRecreated).not.toHaveProperty("purgeFailed");
                  expect(readAgentDeletionJournal(agentId)?.cleanupCompleted).toBe(true);
                  for (const pathname of [
                    workspace,
                    state.agentDir(agentId),
                    state.sessionsDir(agentId),
                    databasePath,
                  ]) {
                    await expect(fs.stat(pathname)).rejects.toMatchObject({ code: "ENOENT" });
                  }
                  await expect(
                    client.request("agents.create", { name: agentId, workspace }),
                  ).resolves.toMatchObject({ ok: true, agentId });
                  expect(readAgentDeletionJournal(agentId)).toBeUndefined();
                } finally {
                  releaseScan.resolve();
                  await Promise.allSettled([deletingRecreated]);
                  readdir.mockRestore();
                  closeDatabase.mockRestore();
                  registry.memoryCapabilities = priorMemoryCapabilities;
                  await memory.runtime.closeAllMemorySearchManagers?.();
                  await disposePluginRegistryInstances(memory.registry);
                }
                await exerciseLateSessionWritesDuringDeletion({
                  state,
                  client,
                  agentId,
                  workspace,
                  signal,
                });
                expect(hotReloadRecovery).not.toHaveBeenCalled();
              } finally {
                registry.agentHarnesses.splice(registry.agentHarnesses.indexOf(registration), 1);
                registry.plugins.splice(registry.plugins.indexOf(plugin), 1);
                await native.harness.dispose?.();
                await finishedNative.harness.dispose?.();
                nativeClient.close();
                vi.restoreAllMocks();
                await disconnectGatewayClient(client);
              }
            } finally {
              await server.close();
              await claim.release();
            }
            return;
          }
          const pending = {
            agentId,
            operationId: "interrupted-deletion",
            agentDir: state.agentDir(agentId),
            workspaceDir: workspace,
            sessionsDir: state.sessionsDir(agentId),
            deleteFiles: true,
            ...(scenario === "restart-draining" ? { phase: "draining" as const } : {}),
          };
          if (scenario === "restart-draining") {
            beginAgentDeletionJournal(pending);
          }
          await cleanupSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
          if (scenario === "legacy-retiring") {
            const legacy = new DatabaseSync(sharedDatabasePath);
            try {
              expect(legacy.prepare("PRAGMA table_info(agent_deletion_journal)").all()).not.toEqual(
                expect.arrayContaining([expect.objectContaining({ name: "phase" })]),
              );
              legacy
                .prepare(`INSERT INTO agent_deletion_journal
                (agent_id, agent_dir, workspace_dir, sessions_dir, created_at)
                VALUES (?, ?, ?, ?, 1)`)
                .run(pending.agentId, pending.agentDir, pending.workspaceDir, pending.sessionsDir);
            } finally {
              legacy.close();
            }
          }
          resetConfigRuntimeState();
          if (scenario === "restart-draining") {
            await deletionRecovery.resumeAgentDeletions(context, AbortSignal.abort());
            const scope = { agentId, env: state.env, sessionKey };
            await expect(
              patchSessionEntryCore(scope, () => ({ label: "refused before recovery" })),
            ).rejects.toThrow("deletion cleanup is still pending");
            const inventory = vi
              .spyOn(sessionInventory, "readSessionEntrySummariesInWorker")
              .mockRejectedValueOnce(new Error("synthetic recovery failure"));
            await deletionRecovery.resumeAgentDeletions(context);
            inventory.mockRestore();
            expect(context.logGateway.warn).toHaveBeenCalledWith(
              expect.stringContaining("synthetic recovery failure"),
            );
            vi.mocked(context.logGateway.warn).mockClear();
            await expect(
              patchSessionEntryCore(scope, () => ({ label: "refused after recovery failure" })),
            ).rejects.toThrow("deletion cleanup is still pending");
          }
          await deletionRecovery.resumeAgentDeletions(context);
          expect(context.logGateway.warn).not.toHaveBeenCalled();
          expect(readAgentDeletionJournal(agentId)?.cleanupCompleted).toBe(true);
          for (const pathname of [
            workspace,
            state.agentDir(agentId),
            state.sessionsDir(agentId),
            databasePath,
          ]) {
            await expect(fs.stat(pathname)).rejects.toMatchObject({ code: "ENOENT" });
          }
          expect(getRuntimeConfig().agents?.entries).not.toHaveProperty(agentId);
          expect(
            await createAgent({ name: agentId, workspace, skipBootstrap: true }),
          ).toMatchObject({
            status: "created",
            agentId,
          });
          expect(readAgentDeletionJournal(agentId)).toBeUndefined();
          await expect(
            replaceSessionEntry(
              { agentId, env: state.env, sessionKey },
              { sessionId: "recreated-after-recovery", updatedAt: 2 },
            ),
          ).resolves.toMatchObject({ sessionId: "recreated-after-recovery" });
          if (scenario === "legacy-retiring") {
            await cleanupSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
            const upgraded = new DatabaseSync(sharedDatabasePath);
            try {
              expect(upgraded.prepare("PRAGMA user_version").get()).toEqual({ user_version: 20 });
              expect(upgraded.prepare("PRAGMA table_info(agent_deletion_journal)").all()).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({ name: "phase", type: "TEXT", notnull: 0 }),
                ]),
              );
            } finally {
              upgraded.close();
            }
          }
        } finally {
          cron.stop();
          await cron.waitForIdle();
          await scheduler.stop();
        }
      },
    ));
  },
);
