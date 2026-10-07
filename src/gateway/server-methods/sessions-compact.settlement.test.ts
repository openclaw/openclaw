import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { registerChatAbortController } from "../chat-abort.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import * as settlementOwner from "./session-run-settlement.js";
import { sessionCompactHandlers } from "./sessions-compact.js";
import { sessionRewindHandlers } from "./sessions-rewind.js";

afterEach(() => vi.restoreAllMocks());

it.each(["committed", "failed"] as const)(
  "waits for a %s reply owner to finish its transcript write before compacting",
  async (outcome) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = { agents: { entries: { main: {} } } };
      await state.writeConfig(cfg);
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:dashboard:terminal-compact",
        sessionId: "terminal-compact",
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
      };
      await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      for (const content of ["First question", "Second question", "Third question"]) {
        await appendTranscriptMessage(scope, {
          cwd: state.workspaceDir,
          message: { role: "user", content, timestamp: 1 },
        });
      }
      const operation = createReplyOperation({ ...scope, resetTriggered: false });
      if (outcome === "failed") {
        operation.retainFailureUntilComplete();
        operation.fail("run_failed");
      } else {
        operation.freezeAbort();
      }
      const waiting = createDeferredCore();
      const settle = settlementOwner.waitForTerminalSessionRunSettlement;
      vi.spyOn(settlementOwner, "waitForTerminalSessionRunSettlement").mockImplementation(
        (params) => {
          const settled = settle(params);
          waiting.resolve();
          return settled;
        },
      );
      const respond = vi.fn();
      const compact = sessionCompactHandlers["sessions.compact"]!({
        req: { type: "req", id: "compact", method: "sessions.compact" },
        params: { key: scope.sessionKey, maxLines: 2 },
        client: null,
        isWebchatConnect: () => false,
        respond,
        context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
      });
      try {
        await awaitGateBeforeSettlement(
          waiting.promise,
          Promise.resolve(compact),
          "Compaction returned before joining the terminal reply owner",
        );
        await appendTranscriptMessage(scope, {
          cwd: state.workspaceDir,
          message: { role: "assistant", content: "Final answer", timestamp: 2 },
        });
        expect(respond).not.toHaveBeenCalled();
        operation.complete();
        await compact;
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ compacted: true, kept: 2 }),
          undefined,
        );
        expect(await loadTranscriptEvents(scope)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              message: expect.objectContaining({ content: "Final answer" }),
            }),
          ]),
        );
      } finally {
        operation.complete();
        await compact;
      }
    });
  },
);

it.each(["compact", "rewind"] as const)(
  "refuses %s immediately when a newer live admission coexists with an older terminal writer",
  async (action) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = { agents: { entries: { main: {} } } };
      await state.writeConfig(cfg);
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:dashboard:live-settlement",
        sessionId: "live-settlement",
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
      };
      await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      for (const content of ["First question", "Second question", "Third question"]) {
        await appendTranscriptMessage(scope, {
          cwd: state.workspaceDir,
          message: { role: "user", content, timestamp: 1 },
        });
      }
      const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
      const terminal = registerChatAbortController({
        chatAbortControllers: context.chatAbortControllers,
        runId: "older-terminal",
        ...scope,
        timeoutMs: 60_000,
      });
      if (!terminal.entry) {
        throw new Error("Missing terminal registration");
      }
      terminal.entry.projectSessionTerminalObservedAt = Date.now();
      terminal.entry.projectSessionActive = false;
      const live = await beginSessionWorkAdmission({
        scope: scope.storePath,
        identities: [scope.sessionKey, scope.sessionId],
        assertAllowed: () => {},
      });
      const entered = createDeferredCore();
      const settle = settlementOwner.waitForTerminalSessionRunSettlement;
      let settled: boolean | undefined;
      vi.spyOn(settlementOwner, "waitForTerminalSessionRunSettlement").mockImplementation(
        (params) => {
          vi.useFakeTimers();
          const result = settle(params).then((value) => {
            settled = value;
            return value;
          });
          entered.resolve();
          return result;
        },
      );
      const respond = vi.fn();
      const method = `sessions.${action}`;
      const mutation = (action === "compact" ? sessionCompactHandlers : sessionRewindHandlers)[
        method
      ]!({
        req: { type: "req", id: action, method },
        params:
          action === "compact"
            ? { key: scope.sessionKey, maxLines: 2 }
            : { sessionKey: scope.sessionKey, entryId: "unused-while-busy" },
        client: null,
        isWebchatConnect: () => false,
        respond,
        context,
      });
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          Promise.resolve(mutation),
          "Mutation skipped settlement",
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);
        vi.useRealTimers();
        await mutation;
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            message: expect.stringContaining(
              action === "compact" ? "has an active run" : "while the agent is working",
            ),
          }),
        );
        expect(live.isActive()).toBe(true);
        expect(context.chatAbortControllers.get("older-terminal")).toBe(terminal.entry);
      } finally {
        terminal.cleanup();
        live.release();
        if (vi.isFakeTimers()) {
          await vi.advanceTimersByTimeAsync(0);
        }
        vi.useRealTimers();
        await mutation;
      }
    });
  },
);
