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
import { getActiveNativeAttempt } from "../../agents/embedded-agent-runner/run-state.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
  createEmbeddedRunHandle,
} from "../../agents/embedded-agent-runner/runs.test-support.js";
import {
  captureRuntimeConfigAsyncReader,
  getRuntimeConfig,
  resetConfigRuntimeState,
  withConfigMutationExclusive,
} from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
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
import { revokeSqliteDatabaseAdmissionsForPath } from "../../infra/sqlite-database-admission.js";
import { appendSessionTranscriptMessageByIdentity } from "../../plugin-sdk/session-transcript-runtime.js";
import { createPluginRuntimeMock } from "../../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { createPluginStateRuntimeStores } from "../../plugin-state/plugin-state-store.js";
import { registerMemoryCapability } from "../../plugins/memory-state.js";
import { getPluginRegistryState } from "../../plugins/runtime-state.js";
import { disposePluginRegistryInstances } from "../../plugins/runtime.js";
import { withPluginRuntimeGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { closeAgentWorkAdmissions } from "../../sessions/session-controller.lifecycle.js";
import { isSessionRunActive } from "../../sessions/session-controller.queries.js";
import * as agentDatabases from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import * as agentExecutions from "../../state/openclaw-agent-execution.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { repairOpenClawStateDatabaseSchema } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../state/openclaw-state-schema.js";
import {
  addPreCutoverClientCredentialTablesForTest,
  withStateMigrationBackupForTest,
} from "../../state/openclaw-state-schema.test-support.js";
import {
  beginAgentDeletionJournal,
  readAgentDeletionJournal,
} from "../../test-utils/agent-deletion-journal.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock } from "../../test-utils/port-claims.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import * as deletionRecovery from "../server-agent-deletion-recovery.js";
import { createGatewayMemoryCloseRegistryFactory } from "../server-close.memory.test-support.js";
import { startGatewayServer } from "../server.js";
import { connectGatewayClient, disconnectGatewayClient } from "../test-helpers.e2e.js";
import {
  createDeletionCron,
  deletionGatewayEnv,
  expectDeletedStorage,
} from "./agents-delete.fixture.test-support.js";
import type { GatewayContextResolver, GatewayRequestContext } from "./types.js";

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

function deletionClient(
  client: Awaited<ReturnType<typeof connectGatewayClient>>,
  agentId: string,
  workspace: string,
) {
  const rpc: typeof client.request = client.request.bind(client);
  return {
    rpc,
    session: (name: string) =>
      rpc<{ key: string; sessionId: string }>("sessions.create", {
        agentId,
        key: `agent:${agentId}:${name}`,
      }),
    delete: (options?: Parameters<typeof rpc>[2]) =>
      rpc("agents.delete", { agentId, deleteFiles: true }, options),
    async recreate() {
      await expect(rpc("agents.create", { name: agentId, workspace })).resolves.toMatchObject({
        ok: true,
        agentId,
      });
      expect(readAgentDeletionJournal(agentId)).toBeUndefined();
    },
  };
}

function expectDeletionResult(result: unknown, workspace: string) {
  expect(result).toMatchObject({
    ok: true,
    failed: [],
    removed: expect.arrayContaining([{ path: workspace, method: "trash" }]),
  });
  expect(result).not.toHaveProperty("purgeFailed");
}

async function exerciseLateSessionWritesDuringDeletion(params: {
  state: OpenClawTestState;
  client: ReturnType<typeof deletionClient>;
  agentId: string;
  workspace: string;
  signal: AbortSignal;
  resolveGatewayContext: GatewayContextResolver;
}): Promise<void> {
  const { state, client, agentId, workspace, signal, resolveGatewayContext } = params;
  const databasePath = path.join(state.agentDir(agentId), "openclaw-agent.sqlite");
  const storePath = path.join(state.sessionsDir(agentId), "sessions.json");
  let session = await client.session("late-write-0");
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
    const operation = withPluginRuntimeGatewayContextResolver(resolveGatewayContext, () =>
      setActiveEmbeddedRun(session.sessionId, handle, session.key, undefined, agentId),
    );
    let ownerSettled = false;
    void operation.ownerSettlement.then(() => {
      ownerSettled = true;
    });
    // The test owns the deadline while deliberately holding all three deletion phases.
    const deleting = client.delete({ signal, timeoutMs: null });
    const reach = (gate: Promise<void>, message: string) =>
      withinTest(awaitGateBeforeSettlement(gate, deleting, message), signal);
    void deleting.catch(() => {});
    try {
      await reach(aborted.promise, "deletion did not abort its run");
      expect(readAgentDeletionJournal(agentId)?.phase).toBe("draining");
      expect(operation.result).toMatchObject({ kind: "aborted" });
      expect(getActiveNativeAttempt(session.sessionId)).toBe(handle);
      expect(ownerSettled).toBe(false);
      await refuseLatePatch("before-run-settlement");
      clearActiveEmbeddedRun(session.sessionId, handle, session.key);

      await reach(closed.promise, "deletion did not close its database");
      expect(readAgentDeletionJournal(agentId)?.phase).toBe("retiring");
      expect(getRuntimeConfig().agents?.entries).toHaveProperty(agentId);
      await refuseLatePatch("after-clean-close-before-config-reload");
      releaseClosed.resolve();

      await reach(purgeCaptured.promise, "deletion did not capture its purge executor");
      expect(readAgentDeletionJournal(agentId)?.phase).toBe("retiring");
      await refuseLatePatch("during-purge");
      releasePurge.resolve();
      expectDeletionResult(await withinTest(deleting, signal), workspace);
      expect(ownerSettled).toBe(true);
      expect(readAgentDeletionJournal(agentId)?.cleanupCompleted).toBe(true);
      await expectDeletedStorage(state, agentId, workspace, databasePath);
    } finally {
      clearActiveEmbeddedRun(session.sessionId, handle, session.key);
      releaseClosed.resolve();
      releasePurge.resolve();
      await Promise.allSettled([deleting]);
      captureOrdinary.mockRestore();
      captureCleanup.mockRestore();
      closeDatabase.mockRestore();
    }
    await client.recreate();
    session = await client.session(`late-write-${iteration + 1}`);
    expect(session.sessionId).toBeTruthy();
  }
}

it.for(["active", "restart-draining", "legacy-retiring"] as const)(
  "deletes real agent storage and permits recreation after %s",
  async (scenario, { signal }) => {
    await (scenarioWork = withOpenClawTestState(
      {
        label: `agent-delete-${scenario}`,
        env: deletionGatewayEnv,
      },
      async (state) => {
        const sharedDatabasePath = resolveOpenClawStateSqlitePath(state.env);
        if (scenario === "legacy-retiring") {
          await fs.mkdir(path.dirname(sharedDatabasePath), { recursive: true });
          using legacy = new DatabaseSync(sharedDatabasePath);
          legacy.exec(OPENCLAW_STATE_SCHEMA_SQL);
          addPreCutoverClientCredentialTablesForTest(legacy);
          // v20 used the same journal fields, without the nullable phase.
          legacy.exec("ALTER TABLE agent_deletion_journal DROP COLUMN phase");
          legacy.exec(`PRAGMA user_version = 20;
              INSERT INTO schema_meta (meta_key, role, schema_version, created_at, updated_at)
                VALUES ('primary', 'global', 20, 1, 1);
              INSERT INTO config_machine_state (state_key, value_json, updated_at_ms)
                VALUES ('state.schema.contentVersion', '20', 1);`);
        }
        await state.writeConfig({
          gateway: { mode: "local", auth: { mode: "token", token: "agent-delete-test-token" } },
          agents: {
            ownership: "explicit",
            defaults: {
              model: "openai/gpt-4.1",
              skipBootstrap: true,
            },
            entries: { keeper: { workspace: state.workspaceDir } },
          },
          plugins: { slots: { memory: "none" } },
        });
        if (scenario === "legacy-retiring") {
          // Version-only repair leaves the deletion journal's first-use phase column absent.
          const migrated = await withStateMigrationBackupForTest({ env: state.env }, () =>
            repairOpenClawStateDatabaseSchema({ env: state.env, versionMigrationOnly: true }),
          );
          expect(migrated.warnings).toEqual([]);
        }
        await captureRuntimeConfigAsyncReader()();
        const workspace = state.path("workspace-doomed");
        const created = await createAgent({ name: "doomed", workspace, skipBootstrap: true });
        signal.throwIfAborted();
        expect(created.status).toBe("created");
        const agentId = "doomed";
        const sessionId = "deletion-active-session";
        const sessionKey = `agent:${agentId}:active`;
        const databasePath = path.join(state.agentDir(agentId), "openclaw-agent.sqlite");
        const writeEntry = (
          key: string,
          entry: SessionEntry,
          previousEntry: SessionEntry | null = null,
        ) =>
          runOpenClawAgentWriteTransaction(
            (database) => writeSessionEntry(database, key, entry, { previousEntry }),
            { agentId, path: databasePath, env: state.env },
          );
        const session = {
          sessionId,
          updatedAt: 1,
          ...(scenario === "active"
            ? { agentHarnessId: "codex", lifecycleRevision: "native-binding-generation" }
            : {}),
        };
        writeEntry(sessionKey, session);
        await fs.mkdir(state.sessionsDir(agentId), { recursive: true });
        await fs.writeFile(
          path.join(state.sessionsDir(agentId), "owned-attachment.txt"),
          "synthetic",
        );
        await fs.writeFile(path.join(workspace, "owned-work.txt"), "synthetic");
        const { context, stop } = createDeletionCron(state);
        try {
          if (scenario === "active") {
            const claim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
            const hotReloadRecovery = vi.fn(() => {
              throw new Error("Synthetic Gateway hot reload unexpectedly required recovery");
            });
            const startupRecovery = createDeferred<GatewayRequestContext>();
            const resumeDeletions = deletionRecovery.resumeAgentDeletions;
            const recovery = vi
              .spyOn(deletionRecovery, "resumeAgentDeletions")
              .mockImplementation(async (...args) => {
                const recovering = resumeDeletions(...args);
                void recovering.then(
                  () => startupRecovery.resolve(args[0]),
                  startupRecovery.reject,
                );
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
              const { resolveGatewayContext } = await withinTest(startupRecovery.promise, signal);
              if (!resolveGatewayContext) {
                throw new Error("Gateway did not publish its runtime context resolver");
              }
              recovery.mockRestore();
              signal.throwIfAborted();
              const client = await connectGatewayClient({
                url: `ws://127.0.0.1:${claim.port}`,
                token: "agent-delete-test-token",
                scopes: ["operator.admin", "operator.read", "operator.write"],
              });
              const operations = deletionClient(client, agentId, workspace);
              const { rpc } = operations;
              const binding = (boundId: string, boundKey: string) =>
                nativeApi.createNativeBindingDeletionFixture(
                  createPluginRuntimeMock({
                    state: createPluginStateRuntimeStores("codex", () => signal.throwIfAborted()),
                  }),
                  { agentId, sessionId: boundId, sessionKey: boundKey },
                );
              const native = binding(sessionId, sessionKey);
              const finishedKey = `agent:${agentId}:finished`;
              const finishedId = "deletion-finished-session";
              writeEntry(finishedKey, { ...session, sessionId: finishedId });
              const finishedNative = binding(finishedId, finishedKey);
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
                const history = async (key: string) =>
                  (
                    await rpc<{ messages: unknown[] }>("chat.history", {
                      sessionKey: key,
                    })
                  ).messages;
                const inject = async (key: string, message: string) => {
                  await expect(
                    rpc("chat.inject", { sessionKey: key, message }),
                  ).resolves.toMatchObject({ ok: true, messageId: expect.any(String) });
                  const messages = await history(key);
                  expect(messages).toContainEqual(
                    expect.objectContaining({
                      role: "assistant",
                      content: [{ type: "text", text: message }],
                    }),
                  );
                  return messages;
                };
                const keeperSession = await rpc<{ key: string }>("sessions.create", {
                  agentId: "keeper",
                  key: "agent:keeper:injection-isolation",
                });
                const selectedMessages = await inject(
                  sessionKey,
                  "Accepted before agent deletion.",
                );
                const assertInjectionRefused = async (phase: string, reason: string) => {
                  await expect(
                    rpc("chat.inject", {
                      sessionKey,
                      message: `Refused during ${phase}.`,
                    }),
                  ).rejects.toThrow(reason);
                  await inject(keeperSession.key, `Keeper accepts injection during ${phase}.`);
                };
                expect(readAgentDeletionJournal(agentId)).toBeUndefined();
                const reopen = closeAgentWorkAdmissions({
                  agentId,
                  env: state.env,
                  reason: new Error("Selected agent admission is closed."),
                });
                try {
                  await assertInjectionRefused(
                    "closed admission",
                    "Selected agent admission is closed.",
                  );
                  expect(await history(sessionKey)).toEqual(selectedMessages);
                } finally {
                  reopen();
                }
                const readSummaries = sessionInventory.readSessionEntrySummariesInWorker;
                const inventory = vi
                  .spyOn(sessionInventory, "readSessionEntrySummariesInWorker")
                  .mockImplementation(async (scope) => {
                    if (scope.agentId === agentId) {
                      throw new Error("synthetic inventory failure");
                    }
                    return readSummaries(scope);
                  });
                await expect(operations.delete()).rejects.toThrow("synthetic inventory failure");
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
                  await expect(rpc(method, params)).rejects.toThrow(
                    "deletion cleanup is still pending",
                  );
                }
                await assertInjectionRefused(
                  "pending deletion",
                  "deletion cleanup is still pending",
                );
                // Deleting agents leave the discovery roster while their owners settle.
                await expect(rpc("chat.history", { sessionKey })).rejects.toThrow(
                  `Session "${sessionKey}" was not found.`,
                );
                const aborted = createDeferred();
                const handle = createEmbeddedRunHandle({
                  runId: "deletion-active-run",
                  abort: () => aborted.resolve(),
                });
                const operation = withPluginRuntimeGatewayContextResolver(
                  resolveGatewayContext,
                  () => setActiveEmbeddedRun(sessionId, handle, sessionKey, undefined, agentId),
                );
                let ownerSettled = false;
                void operation.ownerSettlement.then(() => {
                  ownerSettled = true;
                });
                const deleting = operations.delete({ timeoutMs: 10_000 });
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
                  expect(operation.result).toMatchObject({ kind: "aborted" });
                  expect(getActiveNativeAttempt(sessionId)).toBe(handle);
                  expect(ownerSettled).toBe(false);
                  const relocatedWorkspace = state.path("workspace-relocated");
                  await expect(
                    rpc("agents.update", { agentId, workspace: relocatedWorkspace }),
                  ).rejects.toThrow(/deletion cleanup is still pending/);
                  expect(getRuntimeConfig().agents?.entries?.[agentId]?.workspace).toBe(workspace);
                  await expect(fs.stat(relocatedWorkspace)).rejects.toMatchObject({
                    code: "ENOENT",
                  });
                  // Cancellation checkpoints remain writable until the retained run settles.
                  await withinTest(
                    withConfigMutationExclusive(async () => {
                      writeEntry(
                        sessionKey,
                        { ...session, updatedAt: 2, label: "aborted" },
                        session,
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
                expectDeletionResult(await deleting, workspace);
                expect(ownerSettled).toBe(true);
                expect(native.store.lookup(native.key)).toBeUndefined();
                expect(finishedNative.store.lookup(finishedNative.key)).toBeUndefined();
                expect(nativeClient.subscribed()).toBe(false);
                expect(isSessionRunActive(sessionId)).toBe(false);
                expect(readAgentDeletionJournal(agentId)?.cleanupCompleted).toBe(true);
                await expect(operations.session("gone")).rejects.toThrow();
                await expectDeletedStorage(state, agentId, workspace, databasePath);
                await operations.recreate();
                const recreatedSession = await operations.session("recreated");
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
                expect(isSessionRunActive(recreatedSession.sessionId)).toBe(false);
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
                  const readMemoryLeases = () => {
                    using shared = new DatabaseSync(sharedDatabasePath, { readOnly: true });
                    return shared
                      .prepare(
                        "SELECT lease_id FROM agent_database_leases WHERE path = ? ORDER BY lease_id",
                      )
                      .all(databasePath);
                  };
                  const memoryLeases = readMemoryLeases();
                  expect(memoryLeases.length).toBeGreaterThan(0);
                  deletingRecreated = operations.delete();
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
                  expect(readMemoryLeases()).toEqual(memoryLeases);
                  releaseScan.resolve();
                  expectDeletionResult(await deletingRecreated, workspace);
                  expect(readAgentDeletionJournal(agentId)?.cleanupCompleted).toBe(true);
                  expect(readMemoryLeases()).toEqual([]);
                  await expectDeletedStorage(state, agentId, workspace, databasePath);
                  await operations.recreate();
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
                  client: operations,
                  agentId,
                  workspace,
                  signal,
                  resolveGatewayContext,
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
            {
              using legacy = new DatabaseSync(sharedDatabasePath);
              expect(legacy.prepare("PRAGMA table_info(agent_deletion_journal)").all()).not.toEqual(
                expect.arrayContaining([expect.objectContaining({ name: "phase" })]),
              );
              legacy
                .prepare(`INSERT INTO agent_deletion_journal
                (agent_id, agent_dir, workspace_dir, sessions_dir, created_at)
                VALUES (?, ?, ?, ?, 1)`)
                .run(pending.agentId, pending.agentDir, pending.workspaceDir, pending.sessionsDir);
            }
            revokeSqliteDatabaseAdmissionsForPath(sharedDatabasePath);
          }
          resetConfigRuntimeState();
          await captureRuntimeConfigAsyncReader()();
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
          await expectDeletedStorage(state, agentId, workspace, databasePath);
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
            using upgraded = new DatabaseSync(sharedDatabasePath);
            expect(upgraded.prepare("PRAGMA user_version").get()).toEqual({
              user_version: OPENCLAW_STATE_SCHEMA_VERSION,
            });
            expect(upgraded.prepare("PRAGMA table_info(agent_deletion_journal)").all()).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ name: "phase", type: "TEXT", notnull: 0 }),
              ]),
            );
          }
        } finally {
          await stop();
        }
      },
    ));
  },
);
