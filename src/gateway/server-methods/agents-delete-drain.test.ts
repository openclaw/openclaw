import "../../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { startCatalogRecoveryMcpServer } from "../../agents/agent-bundle-mcp-catalog-recovery.test-support.js";
import {
  acquireSessionMcpRuntime,
  disposeAllSessionMcpRuntimes,
  peekSessionMcpRuntime,
  setSessionMcpRuntimeScheduler,
} from "../../agents/agent-bundle-mcp-manager-api.js";
import { releaseSessionMcpRuntime } from "../../agents/agent-bundle-mcp-manager-cleanup.js";
import { withAgentDeletion } from "../../agents/agent-lifecycle-registry.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
  createEmbeddedRunHandle,
} from "../../agents/embedded-agent-runner/runs.test-support.js";
import { getRuntimeConfig } from "../../config/config.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.entry.js";
import * as sessionPatches from "../../config/sessions/session-accessor.sqlite-entry.js";
import * as sessionInventory from "../../config/sessions/session-entry-read-runtime.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { heartbeatNotifications } from "../../infra/heartbeat-events.js";
import { getGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import {
  beginSessionEffect,
  captureSessionTarget,
  type SessionEffectRef,
} from "../../sessions/session-controller.lifecycle.js";
import { trackSessionControllerSourceWork } from "../../sessions/session-controller.mailbox.js";
import {
  getRpcSourceForGateway,
  isRpcSourceRegistered,
} from "../../sessions/session-controller.rpc-sources.js";
import type { AgentDeletionInput } from "../../state/agent-deletion-journal-transport.js";
import * as deletionJournals from "../../state/agent-deletion-journal.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { registerChatAbortController } from "../chat-abort.js";
import { resumeAgentDeletions } from "../server-agent-deletion-recovery.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { startGatewayEventSubscriptions } from "../server-runtime-subscriptions.js";
import { createSubscriptionTestFixture } from "../server-runtime-subscriptions.test-support.js";
import { withAgentTerminalOpenAdmission } from "../terminal/open-admission.js";
import { TerminalSessionManager } from "../terminal/session-manager.js";
import {
  agentTerminalOwner,
  baseOpenRequest,
  expectTerminalOpen,
  makeFakePty,
} from "../terminal/session-manager.test-helpers.js";
import {
  createWorkerInferenceSessionControls,
  registerWorkerInferenceSessionControl,
} from "../worker-environments/inference-control-internal.js";
import { createWorkerInferenceServiceStub } from "../worker-environments/inference-control.test-helpers.js";
import { localPlacement } from "../worker-environments/placement-suite.test-support.js";
import { drainAgentDeletionRuns } from "./agents-delete-drain.js";
import {
  configureDeletionAgents,
  createDeletionCron,
} from "./agents-delete.fixture.test-support.js";
import { deleteGatewayAgent } from "./agents-delete.js";

afterEach(() => vi.restoreAllMocks());

async function rollbackDeletion(journal: AgentDeletionInput) {
  await withAgentDeletion("doomed", async (begin) => (await begin(journal)).rollback());
}

it.each(["commits", "rolls back", "retries failed rollback persistence"] as const)(
  "%s deletion after its refused terminal projection and raw execution have settled",
  async (outcome) =>
    withOpenClawTestState({ label: "deletion-terminal-drain" }, async (state) => {
      await configureDeletionAgents(state);
      const cleanupError = Object.assign(new Error("unreadable"), { code: "EACCES" });
      const sessionKey = "agent:doomed:dashboard:ending";
      const sessionId = "ending-session";
      const runId = "ending-run";
      const scope = { agentId: "doomed", sessionKey };
      const patchLabel = (label: string) =>
        sessionPatches.patchSessionEntryCore(scope, () => ({ label }));
      await sessionPatches.replaceSessionEntry(scope, {
        sessionId,
        lifecycleRunId: runId,
        updatedAt: 1,
      });
      const { scheduler, context } = createDeletionCron(state);
      const subscriptions = startGatewayEventSubscriptions({
        ...createSubscriptionTestFixture().createParams(),
        ...context,
        scheduler,
        log: context.logGateway,
        toolEventRecipients: context.chatRunState.toolEventRecipients,
      });
      const target = captureSessionTarget({
        ...scope,
        storeScope: resolveSessionStorePathCore(getRuntimeConfig().session?.store, {
          agentId: "doomed",
        }),
        incarnation: sessionId,
      });
      const registration = registerChatAbortController({
        ...scope,
        target,
        sessionId,
        runId,
        kind: "agent",
        timeoutMs: 60_000,
      });
      assert(registration.entry, "Expected an active run registration");
      const entry = registration.entry;
      registration.initializeTiming();
      expect(registration.markExecutionStarted()).toBe(true);
      const aborted = createDeferred();
      const terminalSettled = createDeferred();
      const finishExecution = createDeferred();
      let terminalPersistence: Promise<void> | undefined;
      registration.controller.signal.addEventListener("abort", () => aborted.resolve(), {
        once: true,
      });
      const execution = (async () => {
        await aborted.promise;
        emitAgentEvent({
          ...scope,
          runId,
          sessionId,
          stream: "lifecycle",
          data: { phase: "error", aborted: true, stopReason: "aborted", endedAt: 2_000 },
        });
        registration.cleanup();
        terminalPersistence = entry.adapter.projectSessionTerminalPersistence;
        await terminalPersistence?.catch(() => {});
        terminalSettled.resolve();
        await finishExecution.promise;
      })();
      trackSessionControllerSourceWork(entry.input, execution);
      const deleting = deleteGatewayAgent("doomed", true, context);
      const deletionResult = Promise.allSettled([deleting]);
      try {
        await awaitGateBeforeSettlement(terminalSettled.promise, deleting, "cancellation skipped");
        expect(terminalPersistence).toBeInstanceOf(Promise);
        expect(getRpcSourceForGateway(runId, getGatewayContextResolver(entry.input), target)).toBe(
          entry,
        );
        expect(getRuntimeConfig().agents?.entries?.doomed).toBeDefined();
        await expect(patchLabel("late write")).rejects.toThrow("deletion is draining active work");
        if (outcome !== "commits") {
          const lstat = fs.lstat;
          vi.spyOn(fs, "lstat").mockImplementation((...args) => {
            if (args[0] === state.path("doomed")) {
              return Promise.reject(cleanupError);
            }
            return lstat(...args);
          });
        }
        const persistenceError = new Error("terminal persistence failed");
        const failedReplay =
          outcome === "retries failed rollback persistence"
            ? vi
                .spyOn(sessionPatches, "applySessionEntryTargetOperation")
                .mockRejectedValueOnce(persistenceError)
            : undefined;
        finishExecution.resolve();
        await execution;
        if (outcome !== "commits") {
          await expect(deleting).rejects.toBe(failedReplay ? persistenceError : cleanupError);
          expect(getRuntimeConfig().agents?.entries?.doomed).toBeDefined();
          if (failedReplay) {
            failedReplay.mockRestore();
            await expect(patchLabel("blocked")).rejects.toThrow(
              "deletion cleanup is still pending",
            );
            const journal = await deletionJournals.readAgentDeletionJournalAsync("doomed");
            assert(journal, "Failed replay must retain deletion custody");
            await rollbackDeletion(journal);
          }
          expect(await deletionJournals.readAgentDeletionJournalAsync("doomed")).toBeUndefined();
          const restored = loadSessionEntry(scope);
          expect(restored).toMatchObject({ status: "killed", endedAt: 2_000, lastRunId: runId });
          expect(restored?.lifecycleRunId).toBeUndefined();
          await expect(patchLabel("reopened")).resolves.toMatchObject({ label: "reopened" });
        } else {
          await expect(deleting).resolves.toMatchObject({ ok: true, agentId: "doomed" });
          expect(getRuntimeConfig().agents?.entries?.doomed).toBeUndefined();
        }
        expect(isRpcSourceRegistered(entry)).toBe(false);
      } finally {
        aborted.resolve();
        finishExecution.resolve();
        await execution;
        await deletionResult;
        registration.cleanup();
        await subscriptions.agentUnsub();
        heartbeatNotifications.onEvent = () => {};
        subscriptions.transcriptUnsub();
        subscriptions.lifecycleUnsub();
      }
    }),
);

it.each(["rollback", "rollback during recovery"] as const)(
  "keeps session writes fenced after a draining deletion fails until %s",
  async (rollbackPath) =>
    withOpenClawTestState({ label: "deletion-pending-write" }, async (state) => {
      await configureDeletionAgents(state);
      const scope = { agentId: "doomed", env: state.env, sessionKey: "agent:doomed:pending" };
      await expect(
        sessionPatches.replaceSessionEntry(scope, { sessionId: "pending", updatedAt: 1 }),
      ).resolves.toMatchObject({ sessionId: "pending" });
      const inventoryError = new Error("inventory failed");
      const inventory = vi
        .spyOn(sessionInventory, "readSessionEntrySummariesInWorker")
        .mockRejectedValueOnce(inventoryError);
      const handle = createEmbeddedRunHandle({ abort: vi.fn() });
      setActiveEmbeddedRun("pending", handle, scope.sessionKey, undefined, "doomed");
      try {
        await expect(
          deleteGatewayAgent("doomed", false, createDirectChatContext({ getRuntimeConfig })),
        ).rejects.toBe(inventoryError);
        expect(handle.abort).not.toHaveBeenCalled();
      } finally {
        clearActiveEmbeddedRun("pending", handle, scope.sessionKey);
      }
      inventory.mockRestore();
      expect(await deletionJournals.readAgentDeletionJournalAsync("doomed")).toMatchObject({
        phase: "draining",
        cleanupCompleted: false,
      });
      const update = vi.fn(() => ({ label: "must not be written" }));
      await expect(
        sessionPatches.patchSessionEntryCore(scope, update, { skipMaintenance: true }),
      ).rejects.toThrow("deletion cleanup is still pending");
      expect(update).not.toHaveBeenCalled();
      const rollback = () =>
        rollbackDeletion({
          agentId: "doomed",
          agentDir: state.agentDir("doomed"),
          workspaceDir: state.path("doomed"),
          sessionsDir: state.sessionsDir("doomed"),
          phase: "draining",
        });
      if (rollbackPath === "rollback during recovery") {
        const listPending = deletionJournals.listPendingAgentDeletionJournalsAsync;
        vi.spyOn(deletionJournals, "listPendingAgentDeletionJournalsAsync").mockImplementationOnce(
          async () => {
            const pending = await listPending();
            await rollback();
            return pending;
          },
        );
        await resumeAgentDeletions(createDirectChatContext({ getRuntimeConfig }));
      } else {
        await rollback();
      }
      expect(await deletionJournals.readAgentDeletionJournalAsync("doomed")).toBeUndefined();
      await expect(
        sessionPatches.patchSessionEntryCore(scope, () => ({ label: "resumed" }), {
          skipMaintenance: true,
        }),
      ).resolves.toMatchObject({ label: "resumed" });
    }),
);

it("preserves another agent's replacement run and admissions in a shared store during inventory", async () =>
  withOpenClawTestState({ label: "deletion-run-identity" }, async (state) => {
    const storePath = state.path("shared-sessions.sqlite");
    const cfg = {
      agents: { entries: { keeper: {}, doomed: {} } },
      session: { store: storePath },
    };
    setRuntimeConfigSnapshot(cfg);
    const sessionId = "reused-session";
    const original = createEmbeddedRunHandle({ runId: "original" });
    const replacementAbort = vi.fn(() => clearActiveEmbeddedRun(sessionId, replacement));
    const replacement = createEmbeddedRunHandle({ runId: "replacement", abort: replacementAbort });
    const entered = createDeferred();
    const inventory =
      createDeferred<
        Awaited<ReturnType<typeof sessionInventory.readSessionEntrySummariesInWorker>>
      >();
    vi.spyOn(sessionInventory, "readSessionEntrySummariesInWorker").mockImplementation(() => {
      entered.resolve();
      return inventory.promise;
    });
    setActiveEmbeddedRun(sessionId, original, "agent:doomed:active", undefined, "doomed");
    const draining = drainAgentDeletionRuns("doomed", cfg, createDirectChatContext(), () => {});
    let active: SessionEffectRef | undefined;
    let pending: Promise<SessionEffectRef> | undefined;
    const activeInterrupted = vi.fn(() => active?.release());
    const pendingInterrupted = vi.fn();
    try {
      await awaitGateBeforeSettlement(entered.promise, draining, "drain skipped session inventory");
      clearActiveEmbeddedRun(sessionId, original);
      setActiveEmbeddedRun(sessionId, replacement, "agent:keeper:active", undefined, "keeper");
      const admission = {
        agentId: "keeper",
        scope: storePath,
        identities: ["agent:keeper:active", sessionId],
        owner: Symbol("keeper-turn"),
        assertAllowed: () => {},
      };
      active = await beginSessionEffect({ ...admission, onInterrupt: activeInterrupted });
      pending = beginSessionEffect({ ...admission, onInterrupt: pendingInterrupted });
      void pending.catch(() => {});
      inventory.resolve([]);
      await expect(draining).resolves.toBeUndefined();
      expect(replacementAbort).not.toHaveBeenCalled();
      expect(activeInterrupted).not.toHaveBeenCalled();
      expect(pendingInterrupted).not.toHaveBeenCalled();
      expect(active.isActive()).toBe(true);
      active.release();
      const successor = await pending;
      expect(successor.isActive()).toBe(true);
      successor.release();
    } finally {
      inventory.resolve([]);
      clearActiveEmbeddedRun(sessionId, original);
      clearActiveEmbeddedRun(sessionId, replacement);
      active?.release();
      await pending?.then(
        (successor) => successor.release(),
        () => {},
      );
      await Promise.allSettled([draining]);
    }
  }));

it.each([false, true])(
  "coalesces physical session aliases while draining every terminal (placement: %s)",
  async (placed) =>
    withOpenClawTestState({ label: "deletion-session-aliases" }, async (state) => {
      const cfg = { agents: { entries: { doomed: {}, keeper: {} } } };
      setRuntimeConfigSnapshot(cfg);
      const sessionId = "cron-shared-session";
      const baseKey = "agent:doomed:cron:job";
      const runKey = `${baseKey}:run:run-id`;
      const keys = placed ? [runKey, baseKey] : [baseKey, runKey];
      vi.spyOn(sessionInventory, "readSessionEntrySummariesInWorker").mockResolvedValue(
        keys.map((sessionKey) => ({ sessionKey, entry: { sessionId, updatedAt: 1 } })),
      );
      const controls = createWorkerInferenceSessionControls({
        active: new Map(),
        operations: new Map(),
        unknownSettlements: new Map(),
        recovered: Promise.resolve(),
        settleAbort: async () => {},
      });
      const workerEnvironmentService = createWorkerInferenceServiceStub();
      registerWorkerInferenceSessionControl(workerEnvironmentService, controls);
      const placement = { ...localPlacement(sessionId), agentId: "doomed", sessionKey: baseKey };
      const admission = await beginSessionEffect({
        agentId: "doomed",
        scope: state.path("agents/doomed/sessions/sessions.json"),
        identities: [baseKey, sessionId],
        assertAllowed: () => {},
        onInterrupt: () => admission.release(),
      });
      const terminals = new TerminalSessionManager({ emit: () => {} });
      const ptys = keys.map(() => {
        const pty = makeFakePty();
        const kill = pty.kill.bind(pty);
        pty.kill = () => {
          kill();
          pty.emitExit(0);
        };
        return pty;
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        for (const [index, key] of keys.entries()) {
          await openTerminal(terminals, ptys[index]!, {
            agentId: "doomed",
            owner: agentTerminalOwner(key, sessionId, "doomed"),
          });
        }
        const context = createDirectChatContext({
          workerEnvironmentService,
          terminalSessions: terminals,
          workerSessionPlacementService: placed
            ? { getMany: () => new Map([[sessionId, placement]]) }
            : undefined,
        });
        await expect(
          drainAgentDeletionRuns("doomed", cfg, context, () => {}),
        ).resolves.toBeUndefined();
        expect(admission.isActive()).toBe(false);
        expect(ptys.map((pty) => pty.killed)).toEqual([true, true]);
        expect(terminals.size).toBe(0);
        const released = controls.reserveSessionDrain(sessionId);
        released.start();
        await released.drained;
        released.release();
      } finally {
        terminals.disposeAll();
        vi.useRealTimers();
        admission.release();
        await controls.stop();
      }
    }),
);

async function openTerminal(
  terminals: TerminalSessionManager,
  pty: ReturnType<typeof makeFakePty>,
  options: Parameters<typeof baseOpenRequest>[0],
) {
  return expectTerminalOpen(
    await terminals.open(baseOpenRequest({ ...options, createBackend: async () => pty })),
  );
}

it("keeps deletion draining until every connection terminal exits, without touching a survivor", () =>
  withOpenClawTestState({ label: "agent-delete-terminals" }, async (state) => {
    const workspace = state.path("workspace-doomed");
    const witness = "still owned by terminal work";
    await fs.mkdir(workspace);
    await fs.writeFile(`${workspace}/witness.txt`, witness);
    await configureDeletionAgents(state, workspace, { skipBootstrap: true });
    expect(
      await sessionInventory.readSessionEntrySummariesInWorker({
        agentId: "doomed",
        storePath: `${state.sessionsDir("doomed")}/sessions.json`,
      }),
    ).toEqual([]);
    const { context, stop } = createDeletionCron(state);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const terminals = new TerminalSessionManager({
      emit: () => {},
      withOpenAdmission: withAgentTerminalOpenAdmission,
      detachGraceMs: 60_000,
    });
    context.terminalSessions = terminals;
    const ptys = [makeFakePty(), makeFakePty(), makeFakePty()];
    const pendingPty = makeFakePty();
    const backend = createDeferred<typeof pendingPty>();
    const request = baseOpenRequest({ agentId: "doomed", createBackend: () => backend.promise });
    const opening = terminals.open(request);
    const keeper = makeFakePty();
    const killed = createDeferred();
    const kill = ptys[0]!.kill.bind(ptys[0]);
    ptys[0]!.kill = () => {
      kill();
      killed.resolve();
    };
    let deleting: ReturnType<typeof deleteGatewayAgent> | undefined;
    try {
      for (const [index, pty] of ptys.entries()) {
        const opened = await openTerminal(terminals, pty, {
          agentId: "doomed",
          owner: { kind: "conn", connId: `doomed-${index}` },
          cwd: workspace,
        });
        if (index === 1) {
          terminals.handleDisconnect("doomed-1");
        } else if (index === 2) {
          expect(terminals.close("doomed-2", opened.sessionId)).toBe(true);
        }
      }
      const survivor = await openTerminal(terminals, keeper, {
        agentId: "keeper",
        owner: { kind: "conn", connId: "keeper" },
      });
      deleting = deleteGatewayAgent("doomed", true, context);
      const settled = vi.fn();
      void deleting.then(settled, settled);
      await awaitGateBeforeSettlement(
        killed.promise,
        deleting,
        "deletion skipped connection terminals",
      );
      backend.resolve(pendingPty);
      await expect(opening).resolves.toMatchObject({ ok: false, code: "closed" });
      expect(pendingPty.killed).toBe(true);
      await expect(terminals.open(baseOpenRequest({ agentId: "doomed" }))).resolves.toMatchObject({
        ok: false,
        code: "closed",
      });
      expect(ptys[1]!.killed).toBe(true);
      expect(keeper.killed).toBe(false);
      for (const index of [0, 1]) {
        ptys[index]!.emitExit(0);
      }
      expect(settled).not.toHaveBeenCalled();
      expect(await fs.readFile(`${workspace}/witness.txt`, "utf8")).toBe(witness);
      expect(terminals.write("keeper", survivor.sessionId, "still usable")).toBe(true);
      ptys[2]!.emitExit(0);
      expect(await deletionJournals.readAgentDeletionJournalAsync("doomed")).toMatchObject({
        phase: "draining",
        cleanupCompleted: false,
      });
      expect(settled).not.toHaveBeenCalled();
      pendingPty.emitExit(0);
      await expect(deleting).resolves.toMatchObject({ ok: true, failed: [] });
      expect(await deletionJournals.readAgentDeletionJournalAsync("doomed")).toMatchObject({
        cleanupCompleted: true,
      });
      await expect(fs.stat(workspace)).rejects.toMatchObject({ code: "ENOENT" });
      expect(keeper.killed).toBe(false);
      expect(terminals.write("keeper", survivor.sessionId, "survived deletion")).toBe(true);
    } finally {
      backend.resolve(pendingPty);
      await opening;
      pendingPty.emitExit(0);
      for (const pty of ptys) {
        pty.emitExit(0);
      }
      await Promise.allSettled([deleting]);
      terminals.disposeAll();
      keeper.emitExit(0);
      vi.useRealTimers();
      await stop();
    }
  }));

it.each(["keyed", "unkeyed"])(
  "joins an idle %s MCP transport without a session row, preserving a surviving agent",
  (kind) =>
    withOpenClawTestState({ label: "agent-delete-mcp" }, async (state) => {
      const termination = createDeferred();
      const doomed = await startCatalogRecoveryMcpServer("doomed", {
        holdTermination: termination.promise,
      });
      const keeper = await startCatalogRecoveryMcpServer("keeper");
      keeper.allowCalls();
      const scheduler = createTestGatewayScheduler();
      let draining: Promise<void> | undefined;
      try {
        await disposeAllSessionMcpRuntimes();
        await setSessionMcpRuntimeScheduler(scheduler);
        const cfg = {
          agents: {
            ownership: "explicit" as const,
            entries: {
              keeper: { workspace: state.workspaceDir },
              doomed: { workspace: state.path("doomed") },
            },
          },
        };
        await state.writeConfig(cfg);
        setRuntimeConfigSnapshot(cfg);
        const runtimes = [];
        for (const [agentId, server] of [
          ["doomed", doomed],
          ["keeper", keeper],
        ] as const) {
          const sessionKey = `agent:${agentId}:idle`;
          if (agentId === "keeper") {
            await sessionPatches.replaceSessionEntry(
              { agentId, env: state.env, sessionKey },
              { sessionId: agentId, updatedAt: 1 },
            );
          }
          const lease = await acquireSessionMcpRuntime({
            sessionId: agentId,
            sessionKey: kind === "unkeyed" && agentId === "doomed" ? undefined : sessionKey,
            agentId,
            workspaceDir: state.path(agentId),
            cfg: {
              plugins: { enabled: false },
              mcp: { servers: { fixture: { url: server.url, transport: "streamable-http" } } },
            },
            manifestRegistry: { plugins: [] },
          });
          await lease.runtime.getCatalog();
          await releaseSessionMcpRuntime(lease);
          runtimes.push(lease.runtime);
        }
        const settled = vi.fn();
        draining = drainAgentDeletionRuns("doomed", cfg, createDirectChatContext(), () => {});
        void draining.then(settled, settled);
        await awaitGateBeforeSettlement(
          doomed.terminationStarted,
          draining,
          "agent deletion skipped the idle MCP runtime",
        );
        expect(settled).not.toHaveBeenCalled();
        expect(keeper.terminationCount()).toBe(0);
        await expect(runtimes[1]!.callTool("fixture", "probe", {})).resolves.toMatchObject({
          structuredContent: { revision: "keeper-1" },
        });
        termination.resolve();
        await draining;
        expect(doomed.terminationCount()).toBe(1);
        expect(peekSessionMcpRuntime({ sessionId: "doomed" })).toBeUndefined();
        expect(peekSessionMcpRuntime({ sessionId: "keeper" })).toBe(runtimes[1]);
        expect(keeper.terminationCount()).toBe(0);
      } finally {
        termination.resolve();
        await Promise.allSettled([draining]);
        await disposeAllSessionMcpRuntimes();
        await scheduler.stop();
        await Promise.all([doomed.close(), keeper.close()]);
      }
    }),
);
