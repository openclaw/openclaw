// @vitest-environment node
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { GatewayRequestError } from "../../api/gateway.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { handleAbortChat } from "./run-lifecycle.ts";

it.each([false, true])(
  "keeps certified Stop contention with its captured run (replaced=%s)",
  async (replaced) => {
    const pending = createDeferred<unknown>();
    const request = vi.fn(() => pending.promise);
    const host: Parameters<typeof handleAbortChat>[0] = {
      client: createTestGatewayClient(request),
      connected: true,
      sessionKey: "agent:main:main",
      chatRunId: "run-1",
      chatLoading: false,
      chatMessage: "Unsent draft",
      chatMessages: [],
      chatLocalInputHistoryBySession: {},
      chatInputHistorySessionKey: null,
      chatInputHistoryItems: null,
      chatInputHistoryIndex: -1,
      chatDraftBeforeHistory: null,
      hello: sessionMutationGatewayHello(),
    };
    const operation = handleAbortChat(host, { preserveDraft: true });
    if (replaced) {
      host.chatRunId = "run-2";
    }
    pending.reject(
      new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "Check the turn's status.\n\nStopping may already have taken effect.",
        details: { errorKind: "state_contention" },
      }),
    );
    await operation;
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("chat.abort", {
      sessionKey: "agent:main:main",
      runId: "run-1",
    });
    expect(host.chatMessage).toBe("Unsent draft");
    expect(host.chatRunId).toBe(replaced ? "run-2" : "run-1");
    expect(host.chatError).toBeFalsy();
    expect(host.lastError).toBeFalsy();
    if (replaced) {
      expect(host.chatRunError).toBeFalsy();
    } else {
      expect(host.chatRunError).toEqual({
        kind: "state_contention",
        runId: "run-1",
        summary: "Check the turn's status.\n\nStopping may already have taken effect.",
      });
    }
  },
);
