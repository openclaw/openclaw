import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { isAgentRunRestartAbortReason } from "../agents/run-termination.js";
import {
  createReplyOperation,
  type ReplyOperation,
} from "../auto-reply/reply/reply-run-registry.js";
import { runGatewayLoop } from "../cli/gateway-cli/run-loop.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { applySessionEntryLifecycleMutation } from "../config/sessions/session-accessor.sqlite-projection.js";
import { runSqliteSessionReclamation } from "../config/sessions/session-accessor.sqlite-reclamation-run.js";
import { createSessionMaintenanceStatisticsOperation } from "../config/sessions/session-accessor.sqlite-reclamation.js";
import { settlePendingFinalDelivery } from "../infra/outbound/delivery-completion.js";
import { writeGatewayRestartIntentSync } from "../infra/restart-intent.js";
import type { SqliteIntegrityDiagnostics } from "../infra/sqlite-integrity.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { SUPERVISOR_HINT_ENV_VARS } from "../infra/supervisor-markers.js";
import * as systemdTimeout from "../infra/systemd-stop-timeout.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { startPluginServices } from "../plugins/services.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { getActiveSecretsRuntimeSnapshotState } from "../secrets/runtime-state.js";
import { createDeferredCore } from "../shared/deferred.js";
import { isPidAlive } from "../shared/pid-alive.js";
import {
  beginAgentDeletionJournal,
  completeAgentDeletionJournalInDatabase,
} from "../state/agent-deletion-journal.js";
import {
  assertNoOpenClawAgentDatabaseLeasesReadOnly,
  OpenClawAgentDatabaseLeaseActiveError,
} from "../state/openclaw-agent-db-lease.js";
import * as schema from "../state/openclaw-agent-db-schema.js";
import {
  closeOpenClawAgentDatabasesForTest,
  listOpenIncognitoAgentDatabases,
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { readOpenClawAgentIntegrityVerification } from "../state/openclaw-quarantine-store.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import * as userProfiles from "../state/user-profile-list.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { readMentionStoreSnapshot } from "./mention-inbox-store.js";
import type { MentionCommittedInput } from "./mention-inbox.types.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";
import type { GatewayServer } from "./server-public.js";

it("persists accepted mentions and involvement before Gateway worker close and rejects records after the close prelude", async ({
  signal,
}) => {
  const fixture = await createGatewayMetadataCloseFixture("gateway-mention-close");
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const parentClosed = createDeferredCore();
  let closing: Promise<void> | undefined;
  let accepted: Promise<void> | undefined;
  try {
    const port = await fixture.reservePort();
    const server = await fixture.start(port);
    const kernel = fixture.kernels.get(port);
    assert(kernel);
    const alice = ensureProfileForEmail("alice@mentions.example.test");
    const bob = ensureProfileForEmail("bob@mentions.example.test");
    const sessionKey = "agent:main:mention-close";
    await replaceSessionEntry(
      { agentId: "main", sessionKey },
      {
        sessionId: "mention-close-session",
        updatedAt: 1,
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: alice.id },
      },
    );
    await kernel.mentionInbox.invalidateAsync();
    const input: MentionCommittedInput = {
      sourceId: "accepted-before-close",
      committedSource: { generation: "mention-close", sequence: 1, timestamp: 1 },
      sessionKey,
      agentId: "main",
      sessionId: "mention-close-session",
      messageId: "accepted-before-close",
      senderProfileId: alice.id,
      recipientProfileIds: [bob.id],
      excerpt: "@Bob review this change",
    };
    const prepareProfiles = userProfiles.prepareUserProfileCatalog;
    vi.spyOn(userProfiles, "prepareUserProfileCatalog").mockImplementationOnce(async (...args) => {
      const profiles = await prepareProfiles(...args);
      entered.resolve();
      await release.promise;
      return profiles;
    });
    accepted = kernel.mentionInbox.recordCommittedInputAsync(input);
    await withinTest(
      awaitGateBeforeSettlement(
        entered.promise,
        accepted,
        "Mention settled without preparing involvement profile aliases",
      ),
      signal,
    );
    const shared = openOpenClawStateDatabase({ env: fixture.state.env }).db;
    const agent = openOpenClawAgentDatabase({ agentId: "main", env: fixture.state.env }).db;
    kernel.scheduler.signal.addEventListener("abort", () => parentClosed.resolve(), { once: true });
    closing = server.close({ reason: "mention close regression" });
    await withinTest(parentClosed.promise, signal);
    await kernel.mentionInbox.recordCommittedInputAsync({
      ...input,
      sourceId: "refused-after-close",
      messageId: "refused-after-close",
    });
    expect(shared.isOpen).toBe(true);
    expect(agent.isOpen).toBe(true);
    release.resolve();
    await accepted;
    await closing;
    expect(shared.isOpen).toBe(false);
    expect(agent.isOpen).toBe(false);

    // Read durable results after the real close; a second Gateway boot adds no settlement proof.
    const stored = withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) => readMentionStoreSnapshot(-1, db),
      { env: fixture.state.env },
    );
    expect(stored?.sources.map((source) => source.message?.content.messageId)).toEqual([
      "accepted-before-close",
    ]);
    expect(stored?.sources[0]?.recipients).toEqual([[bob.id, expect.any(String)]]);
    expect(
      loadSessionEntry({ agentId: "main", sessionKey })?.profileInvolvement?.profiles[bob.id],
    ).toMatchObject({ hidden: false, lastMention: input.committedSource });
  } finally {
    release.resolve();
    await Promise.allSettled([accepted, closing]);
    vi.restoreAllMocks();
    await fixture.cleanup();
  }
});

it("joins scheduled plugin work before closing stores while retaining a deleted agent store", async ({
  signal,
}) => {
  const fixture = await createGatewayMetadataCloseFixture("gateway-retained-deleted-agent-close");
  const stopEntered = createDeferredCore();
  const rootJoinEntered = createDeferredCore();
  const releaseRootWork = createDeferredCore();
  let closing: Promise<void> | undefined;
  let heldWriter: ReturnType<typeof patchSessionEntryCore> | undefined;
  let acceptedFinal: ReturnType<typeof settlePendingFinalDelivery> | undefined;
  let acceptedLifecycle: ReturnType<typeof applySessionEntryLifecycleMutation> | undefined;
  try {
    const pluginId = fixture.pluginId;
    const registry = createEmptyPluginRegistry();
    const record = createPluginRecord({ id: pluginId });
    const registered = new PluginInstance(record.id, { record, registry });
    let disposed = false;
    registered.lifecycle.onDispose(() => {
      disposed = true;
    });
    registry.plugins.push(record);
    setActivePluginRegistry(registry);
    const port = await fixture.reservePort();
    const server = await fixture.start(port);
    const kernel = fixture.kernels.get(port);
    assert(kernel);
    expect(fixture.kernels.get(port)?.pluginRuntime.registry.plugins).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: pluginId })]),
    );
    const activeStore = path.join(fixture.state.sessionsDir("main"), "sessions.json");
    const retainedStore = path.join(fixture.state.sessionsDir("retired"), "sessions.json");
    for (const [agentId, storePath] of [
      ["main", activeStore],
      ["retired", retainedStore],
    ] as const) {
      await replaceSessionEntry(
        { agentId, storePath, sessionKey: `agent:${agentId}:main` },
        {
          sessionId: `${agentId}-session`,
          updatedAt: 1,
          pluginExtensions: { [pluginId]: { active: true } },
          ...(agentId === "main"
            ? {
                pendingFinalDelivery: {
                  kind: "replayable" as const,
                  text: "accepted final",
                  createdAt: 1,
                  intentId: "close-intent",
                  deliveries: [{ id: "close-delivery", state: "prepared" as const }],
                },
              }
            : {}),
        },
      );
    }
    const lifecycleKey = "agent:main:lifecycle-close";
    await replaceSessionEntry(
      { agentId: "main", storePath: activeStore, sessionKey: lifecycleKey },
      {
        sessionId: "lifecycle-close-session",
        updatedAt: 1,
        sessionDiffBaseline: {
          version: 1,
          sessionId: "lifecycle-close-session",
          root: "/synthetic",
          files: [],
        },
        skillsSnapshot: { prompt: "before close", skills: [] },
      },
    );
    const retainedDatabase = path.join(fixture.state.agentDir("retired"), "openclaw-agent.sqlite");
    const operationId = randomUUID();
    beginAgentDeletionJournal(
      {
        agentId: "retired",
        operationId,
        agentDir: fixture.state.agentDir("retired"),
        sessionsDir: fixture.state.sessionsDir("retired"),
        workspaceDir: path.join(fixture.state.root, "workspace-retired"),
        databasePaths: [retainedDatabase],
        deleteFiles: false,
      },
      { env: fixture.state.env },
    );
    runOpenClawStateWriteTransaction(
      (database) => completeAgentDeletionJournalInDatabase(database, "retired", operationId),
      { env: fixture.state.env },
    );
    const shared = openOpenClawStateDatabase({ env: fixture.state.env }).db;
    const pluginWorkEntered = createDeferredCore();
    const rootWorkEntered = createDeferredCore();
    const writerEntered = createDeferredCore();
    heldWriter = patchSessionEntryCore(
      { agentId: "main", storePath: activeStore, sessionKey: "agent:main:main" },
      async () => {
        writerEntered.resolve();
        await releaseRootWork.promise;
        return { label: "writer settled before final" };
      },
      { skipMaintenance: true, workerGuard: {} },
    );
    await withinTest(writerEntered.promise, signal);
    const stopService = vi.fn(() => stopEntered.resolve());
    const services = createEmptyPluginRegistry();
    services.services.push({
      pluginId,
      id: "scheduled-close",
      source: "synthetic",
      origin: "workspace",
      service: {
        id: "scheduled-close",
        apiVersion: 2,
        start(context) {
          context.scheduler.schedule({
            id: "held",
            delayMs: 0,
            everyMs: 1,
            async run() {
              pluginWorkEntered.resolve();
              await stopEntered.promise;
            },
          });
        },
        stop: stopService,
      },
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    kernel.runtimeState.pluginServices = await startPluginServices({
      registry: services,
      config: fixture.config,
      scheduler: kernel.scheduler,
    });
    kernel.scheduler.schedule({
      id: "kernel-held-work",
      delayMs: 0,
      async run() {
        acceptedFinal = settlePendingFinalDelivery(
          {
            kind: "pending-final",
            agentId: "main",
            sessionKey: "agent:main:main",
            sessionId: "main-session",
            storePath: activeStore,
            deliveryId: "close-delivery",
            intentId: "close-intent",
          },
          "delivered",
        );
        acceptedLifecycle = applySessionEntryLifecycleMutation({
          agentId: "main",
          storePath: activeStore,
          activeSessionKey: lifecycleKey,
          upserts: [
            {
              sessionKey: lifecycleKey,
              entry: {
                sessionId: "lifecycle-close-session",
                updatedAt: 2,
                skillsSnapshot: { prompt: "accepted before close", skills: [] },
              },
            },
          ],
        });
        rootWorkEntered.resolve();
        await Promise.all([acceptedFinal, acceptedLifecycle]);
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    await withinTest(Promise.all([pluginWorkEntered.promise, rootWorkEntered.promise]), signal);
    vi.useRealTimers();
    const stopScheduler = kernel.scheduler.stop.bind(kernel.scheduler);
    vi.spyOn(kernel.scheduler, "stop").mockImplementation(() => {
      rootJoinEntered.resolve();
      return stopScheduler();
    });
    closing = server.close({ reason: "gateway stopping" });
    await withinTest(Promise.race([stopEntered.promise, rootJoinEntered.promise, closing]), signal);
    expect(stopService).toHaveBeenCalledOnce();
    await withinTest(rootJoinEntered.promise, signal);
    expect(kernel.scheduler.signal.aborted).toBe(true);
    const lateWork = vi.fn();
    await kernel.scheduler.schedule({ id: "after-close", delayMs: 0, run: lateWork }).stop();
    expect(lateWork).not.toHaveBeenCalled();
    expect(disposed).toBe(false);
    expect(shared.isOpen).toBe(true);
    releaseRootWork.resolve();
    await heldWriter;
    await expect(acceptedFinal).resolves.toEqual({ state: "delivered" });
    await expect(acceptedLifecycle).resolves.toMatchObject({ removedEntries: 0 });
    await expect(closing).resolves.toBeUndefined();
    expect(disposed).toBe(true);
    expect(shared.isOpen).toBe(false);
    expect((await fs.stat(retainedDatabase)).isFile()).toBe(true);
    const lifecycleEntry = loadSessionEntry({
      agentId: "main",
      storePath: activeStore,
      sessionKey: lifecycleKey,
    });
    expect(lifecycleEntry?.skillsSnapshot).toEqual({
      prompt: "accepted before close",
      skills: [],
    });
    expect(lifecycleEntry?.sessionDiffBaseline).toBeUndefined();
    expect(
      loadSessionEntry({ agentId: "main", storePath: activeStore, sessionKey: "agent:main:main" })
        ?.pluginExtensions,
    ).toBeUndefined();
    expect(
      loadSessionEntry({ agentId: "main", storePath: activeStore, sessionKey: "agent:main:main" }),
    ).toMatchObject({
      label: "writer settled before final",
      pendingFinalDelivery: {
        deliveries: [{ id: "close-delivery", state: "delivered" }],
      },
    });
  } finally {
    stopEntered.resolve();
    releaseRootWork.resolve();
    await Promise.allSettled([heldWriter, acceptedFinal, acceptedLifecycle, closing]);
    vi.useRealTimers();
    vi.restoreAllMocks();
    await fixture.cleanup();
  }
}, 300_000);

it("releases agent leases for Doctor after the final Gateway stops while its process stays alive", async () => {
  const fixture = await createGatewayMetadataCloseFixture("gateway-agent-leases-stop");
  const ownerPid = process.pid;
  try {
    const first = await fixture.start(await fixture.reservePort());
    const siblingPort = await fixture.reservePort();
    const sibling = await fixture.start(siblingPort);
    const options = { agentId: "main", env: fixture.state.env };
    const agent = openOpenClawAgentDatabase(options);
    const incognito = openOpenClawAgentDatabase({
      ...options,
      path: resolveIncognitoOpenClawAgentSqlitePath(options),
    });
    const shared = openOpenClawStateDatabase({ env: fixture.state.env }).db;
    const inspectForDoctor = () =>
      assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: fixture.state.env });
    expect(inspectForDoctor).toThrow(OpenClawAgentDatabaseLeaseActiveError);
    const closeOptions = { reason: "gateway stopping" };

    await first.close(closeOptions);
    expect(agent.db.isOpen).toBe(true);
    expect(incognito.db.isOpen).toBe(true);
    expect(inspectForDoctor).toThrow(OpenClawAgentDatabaseLeaseActiveError);
    const response = await fetch(`http://127.0.0.1:${siblingPort}/healthz`);
    await response.body?.cancel();
    expect(response.ok).toBe(true);

    await sibling.close(closeOptions);
    expect(process.pid).toBe(ownerPid);
    expect(isPidAlive(ownerPid)).toBe(true);
    expect(inspectForDoctor).not.toThrow();
    expect(agent.db.isOpen).toBe(false);
    expect(shared.isOpen).toBe(false);
    expect(incognito.db.isOpen).toBe(false);
    expect(listOpenIncognitoAgentDatabases()).not.toContainEqual({
      agentId: "main",
      storePath: incognito.path,
    });
  } finally {
    await fixture.cleanup();
  }
});

it.skipIf(process.platform !== "linux")(
  "releases idle agent leases before sidecar settlement and joins managed SIGTERM cleanup",
  async () => {
    const fixture = await createGatewayMetadataCloseFixture("gateway-agent-resource-close");
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const started = createDeferredCore<GatewayServer>();
    const exited = createDeferredCore<number>();
    const exit = vi.fn((code: number) => exited.resolve(code));
    const completeBoot = vi.fn();
    const previousStops = new Set(process.listeners("SIGTERM"));
    let closing: Promise<void> | undefined;
    let unregister: (() => void) | undefined;
    let stop: ((signal: "SIGTERM") => void) | undefined;
    let operation: ReplyOperation | undefined;
    let execution: ReturnType<typeof captureOpenClawAgentDatabaseExecution> | undefined;
    const writerReleased = createDeferredCore();
    try {
      for (const name of SUPERVISOR_HINT_ENV_VARS) {
        vi.stubEnv(name, undefined);
      }
      vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", "external");
      vi.spyOn(systemdTimeout, "readSystemdStopTimeout").mockResolvedValue({
        timeoutMs: 90_000,
        source: "systemd fixture TimeoutStopUSec",
      });
      const port = await fixture.reservePort();
      void runGatewayLoop({
        lockPort: port,
        completeBoot,
        start: async (options) => {
          const server = await fixture.start(port, {
            hostLifecycle: options?.hostLifecycle,
            startupOperation: options?.startupOperation,
          });
          started.resolve(server);
          return server;
        },
        runtime: { log() {}, error() {}, exit },
      }).catch(started.reject);
      const server = await started.promise;
      await nextTurn();
      stop = process.listeners("SIGTERM").find((listener) => !previousStops.has(listener));
      assert(stop);
      const kernel = fixture.kernels.get(port);
      assert(kernel);
      operation = createReplyOperation({
        sessionKey: "agent:main:managed-restart",
        sessionId: "managed-restart",
        resetTriggered: false,
      });
      operation.setPhase("running");
      bindGatewayContextResolver(operation, kernel.resolvePluginGatewayContext);
      operation.abortSignal.addEventListener(
        "abort",
        () => {
          void execution?.release().then(() => {
            operation?.complete();
            writerReleased.resolve();
          }, writerReleased.reject);
        },
        { once: true },
      );
      const options = { agentId: "main", env: fixture.state.env };
      const agent = openOpenClawAgentDatabase(options);
      agent.db.exec("INSERT INTO auth_profile_state VALUES ('restart-proof', '{}', 1)");
      const shared = openOpenClawStateDatabase({ env: fixture.state.env }).db;
      execution = captureOpenClawAgentDatabaseExecution(options);
      const writer = execution;
      await writer.runExisting(
        {
          assertCurrent: () => writer.assertCurrent(),
          createAdmission: (binding) => () => ({
            nativeLocations: binding.nativeLocations,
            admission: createSqliteWorkerOperationAdmission((request, grant) => {
              binding.authorize(request);
              writer.assertCurrent();
              assert(grant());
            }, binding.attachment),
          }),
        },
        (scope) =>
          scope.execute({
            type: "session.entries.replace",
            input: {
              expectedRows: new Map(),
              validationKeys: ["agent:main:managed-restart"],
              labelOwnerKeys: [],
              replacements: [
                {
                  sessionKey: "agent:main:managed-restart",
                  entry: { sessionId: "managed-restart", updatedAt: 1 },
                },
              ],
            },
          }),
      );
      const agentLeases = shared.prepare(
        "SELECT lease_id FROM agent_database_leases WHERE path = ? ORDER BY lease_id",
      );
      const writerLeases = agentLeases.all(agent.path);
      expect(writerLeases).toHaveLength(2);
      await runSqliteSessionReclamation({
        forceInProcess: false,
        plan: createSessionMaintenanceStatisticsOperation({ ...options, path: agent.path }),
      });
      expect(agentLeases.all(agent.path)).toEqual(writerLeases);
      // External cleanup can outlive the stop budget; idle writers must not wait for it.
      const removeSidecar = kernel.registerConnectionDependentSidecars({
        async stop() {
          entered.resolve();
          await release.promise;
        },
      });
      unregister = () => {
        removeSidecar();
      };
      expect(
        writeGatewayRestartIntentSync({
          env: fixture.state.env,
          targetPid: process.pid,
          intent: { reason: "gateway.restart", force: true, waitMs: 30_000 },
        }),
      ).toBe(true);
      const close = vi.spyOn(server, "close");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      vi.spyOn(performance, "now").mockImplementation(() => Date.now());
      stop("SIGTERM");
      await vi.advanceTimersByTimeAsync(29_999);
      expect(operation.abortSignal.aborted).toBe(false);
      expect(close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(close).toHaveBeenCalledWith({
        reason: "gateway restarting",
        restartExpectedMs: 1_500,
        drainTimeoutMs: 0,
      });
      closing = close.mock.results[0]?.value;
      assert(closing);
      await Promise.race([
        entered.promise,
        closing.then(() => {
          throw new Error("Gateway acknowledged closure before its agent resource joined");
        }),
      ]);
      expect(isAgentRunRestartAbortReason(operation.abortSignal.reason)).toBe(true);
      await writerReleased.promise;
      expect(agentLeases.all(agent.path)).toEqual([]);
      await vi.advanceTimersByTimeAsync(10_001);
      expect(exit).not.toHaveBeenCalled();
      expect(agent.db.isOpen).toBe(false);
      expect(shared.isOpen).toBe(true);
      expect(() =>
        assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: fixture.state.env }),
      ).not.toThrow();
      expect(
        readOpenClawAgentIntegrityVerification(agent.path, fixture.state.env)?.clean_close,
      ).toBe(1);
      await vi.advanceTimersByTimeAsync(4_999);
      release.resolve();
      await closing;
      await expect(exited.promise).resolves.toBe(0);
      expect(completeBoot).toHaveBeenCalledExactlyOnceWith({
        outcome: "planned_restart",
        reason: expect.stringMatching(/restart \(SIGTERM: gateway\.restart\)$/),
      });
      expect(agent.db.isOpen).toBe(false);
      expect(shared.isOpen).toBe(false);
      expect(() =>
        assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: fixture.state.env }),
      ).not.toThrow();
      expect(
        readOpenClawAgentIntegrityVerification(agent.path, fixture.state.env)?.clean_close,
      ).toBe(1);
      closeOpenClawAgentDatabasesForTest(fixture.state.stateDir);
      resetGatewayWorkAdmission();
      const gate = schema.agentDatabaseIntegrityBeforeMutationSteps;
      let diagnostics: SqliteIntegrityDiagnostics | undefined;
      vi.spyOn(schema, "agentDatabaseIntegrityBeforeMutationSteps").mockImplementation(function* (
        ...args
      ) {
        const result = yield* gate(...args);
        diagnostics = args[3];
        return result;
      });
      const reopened = openOpenClawAgentDatabase(options);
      expect(diagnostics?.integrityGateOutcome).toBe("cached");
      expect(
        reopened.db
          .prepare("SELECT state_json FROM auth_profile_state WHERE state_key='restart-proof'")
          .get(),
      ).toEqual({ state_json: "{}" });
    } finally {
      release.resolve();
      operation?.complete();
      await execution?.release();
      await Promise.allSettled([closing]);
      vi.useRealTimers();
      if (!exit.mock.calls.length && stop) {
        stop("SIGTERM");
        await exited.promise;
      }
      unregister?.();
      await fixture.cleanup();
      resetGatewayWorkAdmission();
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    }
  },
);

it("rejects Gateway closure when an agent handle cannot close and retains its lease", async () => {
  const fixture = await createGatewayMetadataCloseFixture("gateway-agent-close-failure");
  let restoreClose: (() => void) | undefined;
  try {
    const server = await fixture.start(await fixture.reservePort());
    const agent = openOpenClawAgentDatabase({ agentId: "main", env: fixture.state.env });
    const shared = openOpenClawStateDatabase({ env: fixture.state.env }).db;
    const failure = new Error("native agent database close failed");
    const blockedClose = vi.spyOn(agent.db, "close").mockImplementation(() => {
      throw failure;
    });
    restoreClose = () => blockedClose.mockRestore();

    const outcome = await server
      .close({ reason: "gateway restarting", restartExpectedMs: 1_500 })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(collectNestedErrorCandidates(outcome)).toContain(failure);
    expect(agent.db.isOpen).toBe(true);
    expect(shared.isOpen).toBe(true);
    expect(getActiveSecretsRuntimeSnapshotState()).not.toBeNull();
    expect(() => assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: fixture.state.env })).toThrow(
      OpenClawAgentDatabaseLeaseActiveError,
    );
  } finally {
    restoreClose?.();
    await fixture.cleanup();
  }
});
