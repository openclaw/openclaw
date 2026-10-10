import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../agents/embedded-agent-runner/runs.test-support.js";
import { getRuntimeConfig } from "../../config/config.js";
import * as sessionInventory from "../../config/sessions/session-entry-read-runtime.js";
import {
  beginSessionWorkAdmission,
  type SessionWorkAdmissionLease,
} from "../../sessions/session-lifecycle-admission.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  removeChatAbortControllerEntry,
  runWithChatAbortExecution,
} from "../chat-abort-lifecycle-internal.js";
import type { ChatAbortControllerEntry } from "../chat-abort.types.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { drainAgentDeletionRuns } from "./agents-delete-drain.js";
import { deleteGatewayAgent } from "./agents-delete.js";
import { prepareSessionLifecycleDrain } from "./sessions-lifecycle-drain.js";

afterEach(() => vi.restoreAllMocks());

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
