import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import {
  beginSessionEffect,
  captureSessionTarget,
} from "../../sessions/session-controller.lifecycle.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import { getRpcSource } from "../../sessions/session-controller.rpc-sources.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { registerChatAbortController } from "../chat-abort.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { bindInProcessRequestMutationAuthority } from "./session-mutation-guards.js";
import * as settlementOwner from "./session-run-settlement.js";
import { sessionCompactHandlers } from "./sessions-compact.js";
import { sessionRewindHandlers } from "./sessions-rewind.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions } from "./types.js";

afterEach(() => vi.restoreAllMocks());

async function prepareTranscript(state: OpenClawTestState, sessionId: string) {
  const cfg = { agents: { entries: { main: {} } } };
  await state.writeConfig(cfg);
  const scope = {
    agentId: "main",
    sessionKey: `agent:main:dashboard:${sessionId}`,
    sessionId,
    storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
  };
  await replaceSessionEntry(scope, { sessionId, updatedAt: Date.now() });
  for (const content of ["First question", "Second question", "Third question"]) {
    await appendTranscriptMessage(scope, {
      cwd: state.workspaceDir,
      message: { role: "user", content, timestamp: 1 },
    });
  }
  return {
    scope,
    context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
    target: captureSessionTarget({
      storeScope: scope.storePath,
      sessionKey: scope.sessionKey,
      incarnation: sessionId,
      agentId: scope.agentId,
    }),
  };
}

function mutate(
  action: "compact" | "rewind",
  key: string,
  context: GatewayRequestContext,
  admitted = false,
) {
  const respond = vi.fn();
  const method = `sessions.${action}`;
  const options: GatewayRequestHandlerOptions = {
    req: { type: "req", id: action, method },
    params:
      action === "compact"
        ? { key, maxLines: 2 }
        : { sessionKey: key, entryId: "unused-while-busy" },
    client: null,
    isWebchatConnect: () => false,
    respond,
    context,
  };
  const pending = (action === "compact" ? sessionCompactHandlers : sessionRewindHandlers)[method]!(
    admitted ? bindInProcessRequestMutationAuthority(options, undefined, undefined) : options,
  );
  return { respond, pending };
}

function observeSettlement(fakeTime = false) {
  const entered = createDeferredCore();
  const settle = settlementOwner.waitForTerminalSessionRunSettlement;
  let settled: boolean | undefined;
  vi.spyOn(settlementOwner, "waitForTerminalSessionRunSettlement").mockImplementation((params) => {
    if (fakeTime) {
      vi.useFakeTimers();
    }
    const result = settle(params).then((value) => {
      settled = value;
      return value;
    });
    entered.resolve();
    return result;
  });
  return { entered: entered.promise, result: () => settled };
}

it.each(["committed", "failed"] as const)(
  "waits for a %s reply owner to finish its transcript write before compacting",
  (outcome) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { scope, context, target } = await prepareTranscript(state, "terminal-compact");
      const operation = createReplyOperation({
        ...scope,
        target,
        resetTriggered: false,
      });
      if (outcome === "failed") {
        operation.fail("run_failed");
      } else {
        operation.freezeAbort();
      }
      const waiting = observeSettlement();
      const { respond, pending: compact } = mutate("compact", scope.sessionKey, context, true);
      try {
        await awaitGateBeforeSettlement(
          waiting.entered,
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
        expect(await loadTranscriptEvents(scope)).toContainEqual(
          expect.objectContaining({
            message: expect.objectContaining({ content: "Final answer" }),
          }),
        );
      } finally {
        operation.complete();
        await compact;
      }
    }),
);

it.each(["compact", "rewind"] as const)(
  "refuses %s immediately when a newer live admission coexists with an older terminal writer",
  (action) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { scope, context, target } = await prepareTranscript(state, "live-settlement");
      const terminal = registerChatAbortController({
        runId: "older-terminal",
        ...scope,
        target,
        timeoutMs: 60_000,
        projectSessionActive: false,
      });
      if (!terminal.entry) {
        throw new Error("Missing terminal registration");
      }
      terminal.entry.adapter.projectSessionTerminalObservedAt = Date.now();
      const live = await beginSessionEffect({
        scope: scope.storePath,
        identities: [scope.sessionKey, scope.sessionId],
        assertAllowed: () => {},
      });
      const settlement = observeSettlement(true);
      const { respond, pending: mutation } = mutate(action, scope.sessionKey, context);
      try {
        await awaitGateBeforeSettlement(
          settlement.entered,
          Promise.resolve(mutation),
          "Mutation skipped settlement",
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(settlement.result()).toBe(false);
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
        expect(getRpcSource("older-terminal")).toBe(terminal.entry);
      } finally {
        terminal.cleanup();
        live.release();
        if (vi.isFakeTimers()) {
          await vi.advanceTimersByTimeAsync(0);
        }
        vi.useRealTimers();
        await mutation;
      }
    }),
);
