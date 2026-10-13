import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as dispatch from "../../auto-reply/dispatch.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { expectSuccessorWorkspaceRead } from "../workspace-readiness.test-support.js";
import { handleChatSend } from "./chat-send-handler.js";

it("reads an existing chat workspace without inheriting its previous preparation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const sessionKey = "agent:main:resumed-workspace";
    const runId = "chat-workspace-successor";
    setRuntimeConfigSnapshot({ agents: { defaults: { workspace: state.workspaceDir } } });
    await replaceSessionEntry(
      { agentId: "main", sessionKey },
      { sessionId: "readiness-session", updatedAt: Date.now(), status: "done" },
    );
    const finished = createDeferred();
    const context = createDirectChatContext({
      removeChatRun: () => {
        finished.resolve();
        return undefined;
      },
    });
    const respond = vi.fn();
    const request = { sessionKey, message: "Read successor.txt", idempotencyKey: runId };
    await expectSuccessorWorkspaceRead({
      workspaceDir: state.workspaceDir,
      sessionKey,
      run: async (readWorkspace) => {
        const runTurn = vi
          .spyOn(dispatch, "dispatchInboundMessageWithProjectedDispatcher")
          .mockImplementationOnce(async () => {
            await readWorkspace();
            return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
          });
        try {
          await handleChatSend({
            params: request,
            req: { type: "req", id: runId, method: "chat.send", params: request },
            respond,
            context,
            client: null,
            isWebchatConnect: () => false,
          });
          expect(respond).toHaveBeenCalledWith(
            true,
            { runId, status: "started" },
            undefined,
            expect.anything(),
          );
          await finished.promise;
          expect(runTurn).toHaveBeenCalledOnce();
        } finally {
          runTurn.mockRestore();
        }
      },
    });
  });
});
