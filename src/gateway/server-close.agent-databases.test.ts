import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { openContextEngineTurnOutboxWorkerStore } from "../agents/harness/context-engine-turn-outbox-store.js";
import { isAgentRunRestartAbortReason } from "../agents/run-termination.js";
import { admitReplyTurn } from "../auto-reply/reply/reply-turn-admission.js";
import { runGatewayLoop } from "../cli/gateway-cli/run-loop.js";
import { readSessionGoalOperationInDatabase } from "../config/sessions/goals-operation-receipts.js";
import { mutateSessionGoal } from "../config/sessions/goals-operations.js";
import { createSessionGoal } from "../config/sessions/goals.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { applySessionEntryLifecycleMutation } from "../config/sessions/session-accessor.sqlite-projection.js";
import { runSqliteSessionReclamation } from "../config/sessions/session-accessor.sqlite-reclamation-run.js";
import { createSessionMaintenanceStatisticsOperation } from "../config/sessions/session-accessor.sqlite-reclamation.js";
import type { SessionActor } from "../config/sessions/session-actor-contract.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { waitForAbortSignal } from "../infra/abort-signal.js";
import {
  completeGatewayBootLifecycle,
  type GatewayBootLifecycleCompletion,
  readGatewayLastShutdownAsync,
  beginGatewayBootLifecycle,
} from "../infra/gateway-boot-lifecycle.js";
import { settlePendingFinalDelivery } from "../infra/outbound/delivery-completion.js";
import { writeGatewayRestartIntentSync } from "../infra/restart-intent.js";
import { readSqliteDatabaseCleanClose } from "../infra/sqlite-database-admission.js";
import type { SqliteIntegrityDiagnostics } from "../infra/sqlite-integrity.js";
import { SqliteWorkerBroker } from "../infra/sqlite-worker-broker.js";
import { SUPERVISOR_HINT_ENV_VARS } from "../infra/supervisor-markers.js";
import * as systemdTimeout from "../infra/systemd-stop-timeout.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { startPluginServices } from "../plugins/services.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import {
  getGatewayRestartDrainSignal,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { getActiveSecretsRuntimeSnapshotState } from "../secrets/runtime-state.js";
import type { ReplyOperation } from "../sessions/session-controller.contracts.js";
import { createDeferredCore } from "../shared/deferred.js";
import { completeAgentDeletionJournalInDatabase } from "../state/agent-deletion-journal.js";
import {
  assertNoOpenClawAgentDatabaseLeasesReadOnly,
  OpenClawAgentDatabaseLeaseActiveError,
} from "../state/openclaw-agent-db-lease.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import * as schema from "../state/openclaw-agent-db-schema.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
  withOpenClawAgentDatabaseRuntime,
} from "../state/openclaw-agent-db.js";
import { runOpenClawAgentWorkerWrite } from "../state/openclaw-agent-write-admission.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { beginAgentDeletionJournal } from "../test-utils/agent-deletion-journal.js";
import {
  createGatewayMetadataCloseFixture,
  createIncognitoCloseSession,
} from "./server-close.metadata.test-support.js";
import type { GatewayServer } from "./server-public.js";
import * as lifecyclePersistence from "./session-lifecycle-persistence-owner.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";

async function closeFixture(name: string) {
  const fixture = await createGatewayMetadataCloseFixture(name);
  const options = { agentId: "main", env: fixture.state.env };
  const target = (sessionKey = "agent:main:main", agentId = "main") => ({
    agentId,
    storePath: path.join(fixture.state.sessionsDir(agentId), "sessions.json"),
    sessionKey,
  });
  return {
    ...fixture,
    options,
    target,
    read: (sessionKey?: string) => loadSessionEntry(target(sessionKey)),
    write: (sessionKey: string, entry: Parameters<typeof replaceSessionEntry>[1]) =>
      replaceSessionEntry(target(sessionKey), entry),
    inspectLeases: () => assertNoOpenClawAgentDatabaseLeasesReadOnly(options),
  };
}

function fakeClock() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
}

it("settles accepted incognito outbox work after the close prelude and before actor retirement", async ({
  signal,
}) => {
  const fixture = await closeFixture("gateway-incognito-outbox-close");
  const release = createDeferredCore();
  const accepted = createDeferredCore();
  const joining = createDeferredCore();
  let actor: SessionActor | undefined;
  let writing: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let persisted: unknown;
  try {
    const { server, kernel } = await fixture.startServer();
    const session = await createIncognitoCloseSession(
      fixture,
      "agent:main:dashboard:incognito-outbox-close",
      "outbox-close",
    );
    const { owner: memoryOwner, authority, target, created } = session;
    actor = session.actor;
    expect(created.kind).toBe("committed");
    const message = await actor.appendToolResult(
      {
        commandId: "outbox-close-message",
        phaseId: "outbox-close-turn",
        turn: {
          agentId: "main",
          sessionKey: target.sessionKey,
          options: {
            expectedSessionId: target.sessionId,
            sessionFile: formatSqliteSessionFileMarker({
              agentId: memoryOwner.agentId,
              storePath: memoryOwner.path,
              sessionId: target.sessionId,
            }),
            messages: [
              {
                eventId: "accepted-question",
                message: { role: "user", content: "accepted question" },
              },
            ],
          },
        },
      },
      authority,
    );
    assert(message.kind === "committed");
    const anchor = message.receipt.transcript.appendedMessages[0]?.anchor;
    assert(anchor);
    const admission = {
      ...anchor,
      logicalTurnId: "accepted-close-turn",
      role: "user" as const,
    };
    const outbox = openContextEngineTurnOutboxWorkerStore({
      path: memoryOwner.path,
      ...target,
      sessionActor: { actor, authority, agentId: memoryOwner.agentId, path: memoryOwner.path },
    });
    const filter = { engineId: "close-fixture", sessionId: target.sessionId };
    fakeClock();
    kernel.scheduler.schedule({
      id: "accepted-incognito-outbox",
      delayMs: 0,
      async run() {
        accepted.resolve();
        await release.promise;
        writing = outbox.enqueueIntent({ ...filter, admission });
        await writing;
        persisted = await outbox.readNextPending(filter);
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    await withinTest(accepted.promise, signal);
    vi.useRealTimers();
    const stop = kernel.scheduler.stop.bind(kernel.scheduler);
    vi.spyOn(kernel.scheduler, "stop").mockImplementation(() => {
      joining.resolve();
      return stop();
    });
    closing = server.close({ reason: "incognito outbox close regression" });
    await withinTest(
      awaitGateBeforeSettlement(joining.promise, closing, "Gateway skipped scheduler settlement"),
      signal,
    );
    expect(kernel.scheduler.signal.aborted).toBe(true);
    expect(() => actor?.assertReadable()).not.toThrow();
    expect(persisted).toBeUndefined();
    const late = vi.fn();
    await kernel.scheduler
      .schedule({ id: "refused-incognito-outbox", delayMs: 0, run: late })
      .stop();
    expect(late).not.toHaveBeenCalled();
    release.resolve();
    await withinTest(Promise.all([writing, closing]), signal);
    expect(persisted).toMatchObject({
      advancement_key: admission.logicalTurnId,
      session_id: target.sessionId,
    });
    expect(() => actor?.assertReadable()).toThrow("closed");
  } finally {
    release.resolve();
    await Promise.allSettled([writing, closing]);
    vi.useRealTimers();
    vi.restoreAllMocks();
    await actor?.release();
    await fixture.cleanup();
  }
});

it("joins scheduled plugin work before closing stores while retaining a deleted agent store", async ({
  signal,
}) => {
  const fixture = await closeFixture("gateway-retained-deleted-agent-close");
  const stopEntered = createDeferredCore();
  const rootJoinEntered = createDeferredCore();
  const lifecycleDrainEntered = createDeferredCore();
  const releaseRootWork = createDeferredCore();
  let closing: Promise<void> | undefined;
  let heldWriter: ReturnType<typeof patchSessionEntryCore> | undefined;
  let heldColdWriter: Promise<void> | undefined;
  let acceptedColdAdmission: Promise<void> | undefined;
  let coldDatabase: ReturnType<typeof openOpenClawAgentDatabase> | undefined;
  let acceptedFinal: ReturnType<typeof settlePendingFinalDelivery> | undefined;
  let acceptedLifecycle: ReturnType<typeof applySessionEntryLifecycleMutation> | undefined;
  let acceptedTerminal: Promise<void> | undefined;
  let acceptedGoal: ReturnType<typeof mutateSessionGoal> | undefined;
  try {
    let persistenceOwner:
      | ReturnType<typeof lifecyclePersistence.createSessionLifecyclePersistenceOwner>
      | undefined;
    const createPersistenceOwner = lifecyclePersistence.createSessionLifecyclePersistenceOwner;
    vi.spyOn(lifecyclePersistence, "createSessionLifecyclePersistenceOwner").mockImplementation(
      () => {
        persistenceOwner = createPersistenceOwner();
        return persistenceOwner;
      },
    );
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
    const { server, kernel } = await fixture.startServer();
    const terminalOwner = persistenceOwner;
    assert(terminalOwner);
    const drainTerminal = terminalOwner.drain.bind(terminalOwner);
    vi.spyOn(terminalOwner, "drain").mockImplementation(() => {
      const draining = drainTerminal();
      lifecycleDrainEntered.resolve();
      return draining;
    });
    expect(kernel.pluginRuntime.registry.plugins).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: pluginId })]),
    );
    const activeStore = fixture.target().storePath;
    const coldOptions = { agentId: "cold-close", env: fixture.state.env };
    const coldStore = path.join(fixture.state.sessionsDir(coldOptions.agentId), "sessions.json");
    const coldPath = resolveOpenClawAgentSqlitePath(coldOptions);
    const coldSessionKey = "agent:cold-close:main";
    const pluginExtensions = { [pluginId]: { active: true } };
    await fixture.write("agent:main:main", {
      sessionId: "main-session",
      updatedAt: 1,
      pluginExtensions,
      pendingFinalDelivery: {
        kind: "replayable",
        text: "accepted final",
        createdAt: 1,
        intentId: "close-intent",
        deliveries: [{ id: "close-delivery", state: "prepared" }],
      },
    });
    await replaceSessionEntry(fixture.target("agent:retired:main", "retired"), {
      sessionId: "retired-session",
      updatedAt: 1,
      pluginExtensions,
    });
    const goalTarget = fixture.target();
    const goal = await createSessionGoal({ ...goalTarget, objective: "before close" });
    const goalOperation = {
      operationId: "close-goal-edit",
      issuedAtMs: Date.now(),
      requestFingerprint: "close-goal-edit",
      action: "edit" as const,
      goalId: goal.id,
      objective: "accepted before close",
    };
    const lifecycleKey = "agent:main:lifecycle-close";
    await fixture.write(lifecycleKey, {
      sessionId: "lifecycle-close-session",
      updatedAt: 1,
      sessionDiffBaseline: {
        version: 1,
        sessionId: "lifecycle-close-session",
        root: "/synthetic",
        files: [],
      },
      skillsSnapshot: { prompt: "before close", skills: [] },
    });
    const terminalKey = "agent:main:terminal-close";
    const terminalEvent = {
      runId: "terminal-close-run",
      sessionId: "terminal-close-session",
      seq: 1,
      stream: "lifecycle",
      ts: 2_000,
      data: { phase: "end", startedAt: 1_000, endedAt: 2_000 },
    };
    await fixture.write(terminalKey, {
      sessionId: terminalEvent.sessionId,
      lifecycleRunId: terminalEvent.runId,
      startedAt: 1_000,
      updatedAt: 1_000,
    });
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
    const shared = openOpenClawStateDatabase(fixture.options).db;
    const agent = openOpenClawAgentDatabase(fixture.options).db;
    const incognito = memorySessionActorOwners.get({
      agentId: "main",
      path: resolveIncognitoOpenClawAgentSqlitePath(fixture.options),
    });
    expect(fixture.inspectLeases).toThrow(OpenClawAgentDatabaseLeaseActiveError);
    const pluginWorkEntered = createDeferredCore();
    const rootWorkEntered = createDeferredCore();
    const writerEntered = createDeferredCore();
    heldWriter = patchSessionEntryCore(
      goalTarget,
      async () => {
        writerEntered.resolve();
        await releaseRootWork.promise;
        return { label: "writer settled before final" };
      },
      { skipMaintenance: true, workerGuard: {} },
    );
    await withinTest(writerEntered.promise, signal);
    const coldWriterEntered = createDeferredCore();
    heldColdWriter = runOpenClawAgentWorkerWrite(coldOptions, async () => {
      coldWriterEntered.resolve();
      await releaseRootWork.promise;
    });
    await withinTest(coldWriterEntered.promise, signal);
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
    fakeClock();
    kernel.runtimeState.pluginServices = await startPluginServices({
      registry: services,
      config: fixture.config,
      scheduler: kernel.scheduler,
    });
    kernel.scheduler.schedule({
      id: "kernel-held-work",
      delayMs: 0,
      async run() {
        acceptedColdAdmission = withOpenClawAgentDatabaseRuntime(coldOptions, async (database) => {
          coldDatabase = database;
          await replaceSessionEntry(
            { agentId: coldOptions.agentId, storePath: coldStore, sessionKey: coldSessionKey },
            { sessionId: "cold-close-session", updatedAt: 1, label: "accepted before close" },
          );
        });
        acceptedFinal = settlePendingFinalDelivery(
          {
            kind: "pending-final",
            ...goalTarget,
            sessionId: "main-session",
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
        acceptedTerminal = terminalOwner.observe({
          sessionKey: terminalKey,
          agentId: "main",
          event: terminalEvent,
        });
        acceptedGoal = mutateSessionGoal({
          ...goalTarget,
          expectedSessionId: "main-session",
          operation: goalOperation,
        });
        rootWorkEntered.resolve();
        await Promise.all([
          acceptedColdAdmission,
          acceptedFinal,
          acceptedLifecycle,
          acceptedTerminal,
          acceptedGoal,
        ]);
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
    await withinTest(
      awaitGateBeforeSettlement(
        lifecycleDrainEntered.promise,
        closing,
        "Gateway closed before joining its accepted terminal lifecycle write",
      ),
      signal,
    );
    expect(stopService).toHaveBeenCalledOnce();
    expect(kernel.scheduler.signal.aborted).toBe(true);
    await expect(
      terminalOwner.observe({
        sessionKey: terminalKey,
        agentId: "main",
        event: { ...terminalEvent, seq: 2 },
      }),
    ).rejects.toMatchObject({ name: "AbortError", code: "ERR_STALE_GATEWAY_LIFECYCLE" });
    const lateWork = vi.fn();
    await kernel.scheduler.schedule({ id: "after-close", delayMs: 0, run: lateWork }).stop();
    expect(lateWork).not.toHaveBeenCalled();
    expect([disposed, shared.isOpen, agent.isOpen]).toEqual([false, true, true]);
    expect(coldDatabase).toBeUndefined();
    await expect(fs.stat(coldPath)).rejects.toMatchObject({ code: "ENOENT" });
    releaseRootWork.resolve();
    await Promise.all([heldWriter, heldColdWriter]);
    await expect(acceptedColdAdmission).resolves.toBeUndefined();
    await expect(acceptedFinal).resolves.toEqual({ state: "delivered" });
    await expect(acceptedLifecycle).resolves.toMatchObject({ removedEntries: 0 });
    await expect(acceptedTerminal).resolves.toBeUndefined();
    const goalResult = await acceptedGoal;
    assert(goalResult);
    expect(goalResult).toMatchObject({
      replayed: false,
      result: { action: "edit", goal: { objective: "accepted before close" } },
    });
    await withinTest(rootJoinEntered.promise, signal);
    await expect(closing).resolves.toBeUndefined();
    expect([disposed, shared.isOpen, agent.isOpen]).toEqual([true, false, false]);
    expect(fixture.inspectLeases).not.toThrow();
    expect(memorySessionActorOwners.read(incognito)).toBeUndefined();
    expect(() => incognito.assertCurrent()).toThrow("closed");
    expect(coldDatabase?.db.isOpen).toBe(false);
    expect(
      loadSessionEntry({
        agentId: coldOptions.agentId,
        storePath: coldStore,
        sessionKey: coldSessionKey,
      }),
    ).toMatchObject({ sessionId: "cold-close-session", label: "accepted before close" });
    const goalReceipt = withOpenClawAgentDatabaseReadOnly(
      (database) =>
        readSessionGoalOperationInDatabase(database, {
          sessionKey: goalTarget.sessionKey,
          expectedSessionId: "main-session",
          operation: goalOperation,
        }),
      fixture.options,
    );
    expect(goalReceipt).toEqual({ found: true, value: goalResult.result });
    expect(fixture.read(terminalKey)).toMatchObject({
      status: "done",
      startedAt: 1_000,
      endedAt: 2_000,
    });
    expect((await fs.stat(retainedDatabase)).isFile()).toBe(true);
    const lifecycleEntry = fixture.read(lifecycleKey);
    expect(lifecycleEntry?.skillsSnapshot).toEqual({
      prompt: "accepted before close",
      skills: [],
    });
    expect(lifecycleEntry?.sessionDiffBaseline).toBeUndefined();
    const main = fixture.read();
    expect(main?.pluginExtensions).toEqual({ [pluginId]: { active: true } });
    expect(main).toMatchObject({
      label: "writer settled before final",
      goal: { id: goal.id, objective: "accepted before close" },
      pendingFinalDelivery: {
        deliveries: [{ id: "close-delivery", state: "delivered" }],
      },
    });
  } finally {
    stopEntered.resolve();
    releaseRootWork.resolve();
    await Promise.allSettled([
      heldWriter,
      heldColdWriter,
      acceptedColdAdmission,
      acceptedFinal,
      acceptedLifecycle,
      acceptedTerminal,
      acceptedGoal,
      closing,
    ]);
    vi.useRealTimers();
    vi.restoreAllMocks();
    await fixture.cleanup();
  }
}, 300_000);

it.skipIf(process.platform === "win32")(
  "releases restart-aborted run leases before sidecar settlement and completes managed SIGTERM cleanup",
  async ({ signal }) => {
    const fixture = await closeFixture("gateway-agent-resource-close");
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const started = createDeferredCore<GatewayServer>();
    const exit = vi.fn();
    let running: Promise<number> | undefined;
    const closeBroker = vi.spyOn(SqliteWorkerBroker.prototype, "close");
    let bootId: string | undefined;
    let shared: ReturnType<typeof openOpenClawStateDatabase>["db"] | undefined;
    let completedAtMs: number | undefined;
    const completeBoot = vi.fn(async (completion: GatewayBootLifecycleCompletion) => {
      assert(shared);
      expect(shared.isOpen).toBe(true);
      expect(closeBroker).not.toHaveBeenCalled();
      const prepare = vi.spyOn(shared, "prepare");
      const exec = vi.spyOn(shared, "exec");
      try {
        completedAtMs = Date.now();
        await completeGatewayBootLifecycle(bootId, completion, fixture.state.env, completedAtMs);
        expect(closeBroker).not.toHaveBeenCalled();
        expect(prepare).not.toHaveBeenCalled();
        expect(exec).not.toHaveBeenCalled();
      } finally {
        prepare.mockRestore();
        exec.mockRestore();
      }
    });
    const previousStops = new Set(process.listeners("SIGTERM"));
    let closing: Promise<void> | undefined;
    let unregister: (() => void) | undefined;
    let stop: ((signal: "SIGTERM") => void) | undefined;
    let operation: ReplyOperation | undefined;
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
      running = runGatewayLoop({
        lockPort: port,
        beginBoot: async (startedAtMs) => {
          bootId = (await beginGatewayBootLifecycle(fixture.state.env, startedAtMs)).id;
        },
        completeBoot,
        start: async (options) => {
          const server = await fixture.start(port, {
            hostLifecycle: options?.hostLifecycle,
            startupOperation: options?.startupOperation,
          });
          started.resolve(server);
          return server;
        },
      });
      void running.then(exit, started.reject);
      const server = await started.promise;
      await nextTurn();
      stop = process.listeners("SIGTERM").find((listener) => !previousStops.has(listener));
      assert(stop);
      const kernel = fixture.kernels.get(port);
      assert(kernel);
      const options = fixture.options;
      const agent = openOpenClawAgentDatabase(options);
      agent.db.exec("INSERT INTO auth_profile_state VALUES ('restart-proof', '{}', 1)");
      shared = openOpenClawStateDatabase(options).db;
      const sessionKey = "agent:main:managed-restart";
      await replaceSessionEntry(
        { ...options, storePath: agent.path, sessionKey },
        { sessionId: "managed-restart", updatedAt: 1 },
      );
      const admitted = await admitReplyTurn({
        storePath: agent.path,
        sessionKey,
        sessionId: "managed-restart",
        kind: "visible",
        resetTriggered: false,
        resolveGatewayContext: kernel.resolvePluginGatewayContext,
      });
      assert(admitted.status === "owned" && admitted.databaseClaim);
      operation = admitted.operation;
      operation.setPhase("running");
      const releaseClaim = admitted.databaseClaim.release;
      vi.spyOn(admitted.databaseClaim, "release").mockImplementation(() => {
        const released = Promise.resolve(releaseClaim());
        void released.then(writerReleased.resolve, writerReleased.reject);
        return released;
      });
      const agentLeases = shared.prepare(
        "SELECT lease_id FROM agent_database_leases WHERE path = ? ORDER BY lease_id",
      );
      const writerLeases = agentLeases.all(agent.path);
      expect(writerLeases).toHaveLength(2);
      await runSqliteSessionReclamation({
        plan: createSessionMaintenanceStatisticsOperation({ ...options, path: agent.path }),
      });
      expect(agentLeases.all(agent.path)).toEqual(writerLeases);
      await getSessionRowProjection(kernel.gatewayRequestContext)?.ensureMaterialized();
      // Abort releases the run claim before independent sidecar cleanup completes.
      unregister = kernel.registerConnectionDependentSidecars({
        async stop() {
          entered.resolve();
          await release.promise;
        },
      });
      expect(
        writeGatewayRestartIntentSync({
          env: fixture.state.env,
          targetPid: process.pid,
          intent: { reason: "gateway.restart", force: true, waitMs: 30_000 },
        }),
      ).toBe(true);
      const close = vi.spyOn(server, "close");
      fakeClock();
      vi.spyOn(performance, "now").mockImplementation(() => Date.now());
      stop("SIGTERM");
      await withinTest(waitForAbortSignal(getGatewayRestartDrainSignal()), signal);
      await vi.advanceTimersByTimeAsync(0);
      await withinTest(entered.promise, signal);
      expect(close).toHaveBeenCalledWith({
        reason: "gateway restarting",
        restartExpectedMs: 1_500,
        exitAfterClose: false,
        retainSharedState: true,
      });
      closing = close.mock.results[0]?.value;
      assert(closing);
      expect(isAgentRunRestartAbortReason(operation.abortSignal.reason)).toBe(true);
      expect(admitted.databaseClaim.isCurrent()).toBe(false);
      await writerReleased.promise;
      // Ordered reader retirement is asynchronous but must finish while this sidecar is held.
      await vi.waitFor(() => expect(agentLeases.all(agent.path)).toEqual([]), { timeout: 5_000 });
      expect(exit).not.toHaveBeenCalled();
      expect(completeBoot).not.toHaveBeenCalled();
      expect(shared.isOpen).toBe(true);
      operation.complete();
      release.resolve();
      await closing;
      await expect(running).resolves.toBe(0);
      expect(completeBoot).toHaveBeenCalledExactlyOnceWith({
        outcome: "planned_restart",
        reason: expect.stringMatching(/restart \(SIGTERM: gateway\.restart\)$/),
      });
      expect([agent.db.isOpen, shared.isOpen]).toEqual([false, false]);
      expect(closeBroker).toHaveBeenCalled();
      expect(await readGatewayLastShutdownAsync(fixture.state.env)).toEqual({
        reason: expect.stringMatching(/restart \(SIGTERM: gateway\.restart\)$/),
        completedAtMs,
      });
      expect(fixture.inspectLeases).not.toThrow();
      expect(readSqliteDatabaseCleanClose(agent.path)).toBe(true);
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
      await Promise.allSettled([closing]);
      vi.useRealTimers();
      if (!exit.mock.calls.length && stop) {
        stop("SIGTERM");
      }
      await Promise.allSettled([running]);
      unregister?.();
      await fixture.cleanup();
      resetGatewayWorkAdmission();
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    }
  },
);

it("rejects Gateway closure when an agent handle cannot close and retains its lease", async () => {
  const fixture = await closeFixture("gateway-agent-close-failure");
  let restoreClose: (() => void) | undefined;
  try {
    const { server } = await fixture.startServer();
    const agent = openOpenClawAgentDatabase(fixture.options);
    const shared = openOpenClawStateDatabase(fixture.options).db;
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
    expect([agent.db.isOpen, shared.isOpen]).toEqual([true, true]);
    expect(getActiveSecretsRuntimeSnapshotState()).not.toBeNull();
    expect(fixture.inspectLeases).toThrow(OpenClawAgentDatabaseLeaseActiveError);
  } finally {
    restoreClose?.();
    await fixture.cleanup();
  }
});
