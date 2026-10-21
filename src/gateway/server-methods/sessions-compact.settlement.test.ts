import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { bindInProcessRequestMutationAuthority } from "./session-mutation-guards.js";
import * as settlementOwner from "./session-run-settlement.js";
import { sessionCompactHandlers } from "./sessions-compact.js";

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

function observeSettlement() {
  const entered = createDeferredCore();
  const settle = settlementOwner.waitForTerminalSessionRunSettlement;
  vi.spyOn(settlementOwner, "waitForTerminalSessionRunSettlement").mockImplementation((params) => {
    const result = settle(params);
    entered.resolve();
    return result;
  });
  return entered.promise;
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
      const respond = vi.fn();
      const compact = sessionCompactHandlers["sessions.compact"]!(
        bindInProcessRequestMutationAuthority(
          {
            req: { type: "req", id: "compact", method: "sessions.compact" },
            params: { key: scope.sessionKey, maxLines: 2 },
            client: null,
            isWebchatConnect: () => false,
            respond,
            context,
          },
          undefined,
          undefined,
        ),
      );
      try {
        await awaitGateBeforeSettlement(
          waiting,
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
