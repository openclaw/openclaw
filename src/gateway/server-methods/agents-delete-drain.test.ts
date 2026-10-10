import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { withAgentDeletion } from "../../agents/agent-lifecycle-registry.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../agents/embedded-agent-runner/runs.test-support.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.sqlite-entry.js";
import * as sessionInventory from "../../config/sessions/session-entry-read-runtime.js";
import {
  beginSessionWorkAdmission,
  type SessionWorkAdmissionLease,
} from "../../sessions/session-lifecycle-admission.js";
import * as deletionJournals from "../../state/agent-deletion-journal.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  removeChatAbortControllerEntry,
  runWithChatAbortExecution,
} from "../chat-abort-lifecycle-internal.js";
import type { ChatAbortControllerEntry } from "../chat-abort.types.js";
import { resumeAgentDeletions } from "../server-agent-deletion-recovery.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
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
import type { WorkerSessionPlacementRecord } from "../worker-environments/placement-record.js";
import { drainAgentDeletionRuns } from "./agents-delete-drain.js";
import { deleteGatewayAgent } from "./agents-delete.js";
import { prepareSessionLifecycleDrain } from "./sessions-lifecycle-drain.js";

afterEach(() => vi.restoreAllMocks());

it.each(["rollback", "rollback during recovery"] as const)(
  "keeps session writes fenced after a draining deletion fails until %s",
  async (rollbackPath) => {
    await withOpenClawTestState({ label: "deletion-pending-write" }, async (state) => {
      await state.writeConfig({
        agents: {
          ownership: "explicit",
          entries: {
            keeper: { workspace: state.workspaceDir },
            doomed: { workspace: state.path("doomed") },
          },
        },
      });
      const scope = { agentId: "doomed", env: state.env, sessionKey: "agent:doomed:pending" };
      await expect(
        replaceSessionEntry(scope, { sessionId: "pending", updatedAt: 1 }),
      ).resolves.toMatchObject({ sessionId: "pending" });
      const inventory = vi
        .spyOn(sessionInventory, "readSessionEntrySummariesInWorker")
        .mockRejectedValueOnce(new Error("inventory failed"));
      await expect(
        deleteGatewayAgent("doomed", false, createDirectChatContext({ getRuntimeConfig })),
      ).rejects.toThrow("inventory failed");
      inventory.mockRestore();
      expect(await deletionJournals.readAgentDeletionJournalAsync("doomed")).toMatchObject({
        phase: "draining",
        cleanupCompleted: false,
      });
      const update = vi.fn(() => ({ label: "must not be written" }));
      await expect(patchSessionEntryCore(scope, update, { skipMaintenance: true })).rejects.toThrow(
        "deletion cleanup is still pending",
      );
      expect(update).not.toHaveBeenCalled();
      const rollback = () =>
        withAgentDeletion("doomed", async (begin) => {
          const deletion = await begin({
            agentId: "doomed",
            agentDir: state.agentDir("doomed"),
            workspaceDir: state.path("doomed"),
            sessionsDir: state.sessionsDir("doomed"),
            phase: "draining",
          });
          await deletion.rollback();
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
        patchSessionEntryCore(scope, () => ({ label: "resumed" }), { skipMaintenance: true }),
      ).resolves.toMatchObject({ label: "resumed" });
    });
  },
);

it("preserves another agent's replacement run and admissions in a shared store during inventory", async () => {
  await withOpenClawTestState({ label: "deletion-run-identity" }, async (state) => {
    const storePath = state.path("agents/keeper/sessions/sessions.json");
    const cfg = {
      agents: { entries: { keeper: {}, doomed: {} } },
      session: { store: storePath },
    };
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
    let active: SessionWorkAdmissionLease | undefined;
    let pending: Promise<SessionWorkAdmissionLease> | undefined;
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
        serializeOwner: true,
        assertAllowed: () => {},
      };
      active = await beginSessionWorkAdmission({ ...admission, onInterrupt: activeInterrupted });
      pending = beginSessionWorkAdmission({ ...admission, onInterrupt: pendingInterrupted });
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
  });
});

it.each([false, true])(
  "coalesces physical session aliases while draining every terminal (placement: %s)",
  async (placed) => {
    await withOpenClawTestState({ label: "deletion-session-aliases" }, async (state) => {
      const cfg = { agents: { entries: { doomed: {}, keeper: {} } } };
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
      const placement: WorkerSessionPlacementRecord = {
        agentId: "doomed",
        sessionId,
        sessionKey: baseKey,
        state: "local",
        executionMode: "worker-turn",
        generation: 1,
        turnClaim: null,
        createdAtMs: 1,
        updatedAtMs: 1,
        stateChangedAtMs: 1,
        environmentId: null,
        activeOwnerEpoch: null,
        workspaceBaseManifestRef: null,
        remoteWorkspaceDir: null,
        workerBundleHash: null,
        lastTranscriptAckCursor: null,
        lastLiveEventAckCursor: null,
        terminalReason: null,
        terminalAtMs: null,
        recoveryError: null,
      };
      const admission = await beginSessionWorkAdmission({
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
          expectTerminalOpen(
            await terminals.open(
              baseOpenRequest({
                agentId: "doomed",
                owner: agentTerminalOwner(key, sessionId, "doomed"),
                createBackend: async () => ptys[index]!,
              }),
            ),
          );
        }
        const context = createDirectChatContext({
          workerEnvironmentService,
          terminalSessions: terminals,
          ...(placed
            ? {
                workerSessionPlacementService: {
                  getMany: () => new Map([[sessionId, placement]]),
                },
              }
            : {}),
        });
        await expect(
          drainAgentDeletionRuns("doomed", cfg, context, () => {}),
        ).resolves.toBeUndefined();
        expect(admission.isActive()).toBe(false);
        expect(ptys.map((pty) => pty.killed)).toEqual([true, true]);
        expect(terminals.size).toBe(0);
        const released = controls.reserveSessionDrain(sessionId).accept();
        released.start();
        await released.drained;
        released.release();
      } finally {
        terminals.disposeAll();
        vi.useRealTimers();
        admission.release();
        await controls.stop();
      }
    });
  },
);

it("joins already cancelled unkeyed work after a later journal check refuses", async () => {
  await withOpenClawTestState({ label: "deletion-partial-drain" }, async () => {
    const cfg = { agents: { entries: { doomed: {}, keeper: {} } } };
    const aborted = createDeferred();
    let current = true;
    const first = createEmbeddedRunHandle({
      runId: "first-unkeyed",
      abort: () => {
        current = false;
        aborted.resolve();
      },
    });
    const laterAbort = vi.fn();
    const later = createEmbeddedRunHandle({ runId: "later-unkeyed", abort: laterAbort });
    vi.spyOn(sessionInventory, "readSessionEntrySummariesInWorker").mockResolvedValue([]);
    setActiveEmbeddedRun("first", first, undefined, undefined, "doomed");
    setActiveEmbeddedRun("later", later, undefined, undefined, "doomed");
    const draining = drainAgentDeletionRuns("doomed", cfg, createDirectChatContext(), () => {
      if (!current) {
        throw new Error("deletion journal replaced");
      }
    });
    const settled = vi.fn();
    void draining.then(settled, settled);
    try {
      await awaitGateBeforeSettlement(
        aborted.promise,
        draining,
        "unkeyed cancellation never began",
      );
      expect(settled).not.toHaveBeenCalled();
      expect(laterAbort).not.toHaveBeenCalled();
      clearActiveEmbeddedRun("first", first);
      await expect(draining).rejects.toThrow("deletion is still draining");
    } finally {
      clearActiveEmbeddedRun("first", first);
      clearActiveEmbeddedRun("later", later);
      await Promise.allSettled([draining]);
    }
  });
});

it("joins a cancelled session producer when the next protected cancellation loses authority", async () => {
  await withOpenClawTestState({ label: "deletion-partial-session-drain" }, async (state) => {
    const cfg = { agents: { entries: { doomed: {}, keeper: {} } } };
    const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
    const sessionKey = "agent:doomed:shared";
    const entry = (): ChatAbortControllerEntry => ({
      agentId: "doomed",
      sessionKey,
      sessionId: "shared",
      controller: new AbortController(),
      controlUiVisible: false,
      startedAtMs: 1,
      expiresAtMs: Infinity,
    });
    const first = entry();
    const later = entry();
    context.chatAbortControllers.set("first", first);
    context.chatAbortControllers.set("later", later);
    const completion = createDeferred();
    const execution = runWithChatAbortExecution(
      first,
      () => completion.promise,
      () => removeChatAbortControllerEntry(context.chatAbortControllers, "first", first),
    );
    const aborted = createDeferred();
    let current = true;
    first.controller.signal.addEventListener("abort", () => {
      current = false;
      aborted.resolve();
    });
    const draining = prepareSessionLifecycleDrain({
      action: "delete",
      timeoutMs: null,
      context,
      agentId: "doomed",
      storePath: state.path("sessions.json"),
      sessionKey,
      sessionKeys: [sessionKey],
      sessionId: "shared",
      lifecycleIdentities: [sessionKey, "shared"],
      authorize: () => {
        if (!current) {
          throw new Error("deletion journal replaced");
        }
      },
    });
    const settled = vi.fn();
    void draining.then(settled, settled);
    try {
      await awaitGateBeforeSettlement(
        aborted.promise,
        draining,
        "protected cancellation never began",
      );
      expect(settled).not.toHaveBeenCalled();
      expect(later.controller.signal.aborted).toBe(false);
      completion.resolve();
      await expect(draining).rejects.toThrow("deletion journal replaced");
    } finally {
      completion.resolve();
      await execution;
      await Promise.allSettled([draining]);
      context.chatAbortControllers.clear();
    }
  });
});

it.each(["replaced", "completed"] as const)(
  "does not cancel protected or unkeyed work after its deletion journal is %s",
  async (transition) => {
    await withOpenClawTestState({ label: `deletion-journal-${transition}` }, async (state) => {
      await state.writeConfig({
        agents: {
          ownership: "explicit",
          defaults: { skipBootstrap: true },
          entries: {
            keeper: { workspace: state.workspaceDir },
            doomed: { workspace: state.path("doomed") },
          },
        },
      });
      const context = createDirectChatContext({ getRuntimeConfig });
      const protectedController = new AbortController();
      context.chatAbortControllers.set("protected", {
        agentId: "doomed",
        sessionId: "protected-session",
        sessionKey: "agent:doomed:protected",
        controller: protectedController,
        controlUiVisible: false,
        startedAtMs: 1,
        expiresAtMs: Infinity,
      });
      protectedController.signal.addEventListener("abort", () =>
        removeChatAbortControllerEntry(context.chatAbortControllers, "protected"),
      );
      const unkeyedAbort = vi.fn(() => clearActiveEmbeddedRun("unkeyed", unkeyed));
      const unkeyed = createEmbeddedRunHandle({ runId: "unkeyed-run", abort: unkeyedAbort });
      setActiveEmbeddedRun("unkeyed", unkeyed, undefined, undefined, "doomed");
      const entered = createDeferred();
      const inventory =
        createDeferred<
          Awaited<ReturnType<typeof sessionInventory.readSessionEntrySummariesInWorker>>
        >();
      vi.spyOn(sessionInventory, "readSessionEntrySummariesInWorker").mockImplementation(() => {
        entered.resolve();
        return inventory.promise;
      });
      const deleting = deleteGatewayAgent("doomed", false, context);
      void deleting.catch(() => {});
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          deleting,
          "deletion skipped session inventory",
        );
        using foreign = new DatabaseSync(resolveOpenClawStateSqlitePath(state.env));
        foreign
          .prepare(
            transition === "replaced"
              ? "UPDATE agent_deletion_journal SET operation_id = 'replacement' WHERE agent_id = 'doomed'"
              : "UPDATE agent_deletion_journal SET cleanup_completed = 1 WHERE agent_id = 'doomed'",
          )
          .run();
        inventory.resolve([]);
        await expect(deleting).rejects.toThrow();
        expect(unkeyedAbort).not.toHaveBeenCalled();
        expect(protectedController.signal.aborted).toBe(false);
      } finally {
        inventory.resolve([]);
        clearActiveEmbeddedRun("unkeyed", unkeyed);
        context.chatAbortControllers.clear();
        await Promise.allSettled([deleting]);
      }
    });
  },
);
