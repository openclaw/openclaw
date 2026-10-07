import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import * as admissionOwner from "../../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { sessionCompactHandlers } from "./sessions-compact.js";

afterEach(() => vi.restoreAllMocks());

it.each(["committed", "failed"] as const)(
  "waits for a %s reply and its outer transcript writer before compacting",
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
      const admission = await admissionOwner.beginSessionWorkAdmission({
        scope: scope.storePath,
        identities: [scope.sessionKey, scope.sessionId],
        assertAllowed: () => {},
      });
      const operation = createReplyOperation({ ...scope, resetTriggered: false });
      if (outcome === "failed") {
        operation.retainFailureUntilComplete();
        operation.fail("run_failed");
      } else {
        operation.freezeAbort();
      }
      const waiting = createDeferredCore();
      const readRelease = admissionOwner.getSessionWorkAdmissionRelease;
      vi.spyOn(admissionOwner, "getSessionWorkAdmissionRelease").mockImplementation((params) => {
        const released = readRelease(params);
        waiting.resolve();
        return released;
      });
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
          "Compaction returned before joining the terminal reply's admission",
        );
        operation.complete();
        await appendTranscriptMessage(scope, {
          cwd: state.workspaceDir,
          message: { role: "assistant", content: "Final answer", timestamp: 2 },
        });
        expect(respond).not.toHaveBeenCalled();
        admission.release();
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
        admission.release();
        await compact;
      }
    });
  },
);
