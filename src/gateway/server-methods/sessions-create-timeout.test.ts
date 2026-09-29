import { afterEach, expect, test, vi } from "vitest";
import type { ChatAbortControllerEntry } from "../chat-abort.js";
import {
  controlUiClient,
  settleWorkspaceRuns,
} from "../server.sessions.create.projects.test-support.js";
import { dispatchInboundMessageMock, testState } from "../test-helpers.js";
import {
  directSessionReq,
  setupGatewaySessionsHandlerTestHarness,
} from "../test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
afterEach(() => {
  dispatchInboundMessageMock.mockReset();
  testState.agentConfig = undefined;
});

test.each([1800000, 0, undefined])(
  "sessions.create forwards initial timeout %s through chat dispatch",
  async (timeoutMs) => {
    testState.agentConfig = { timeoutSeconds: 180 };
    const { storePath } = await createSessionStoreDir();
    const context = {
      chatAbortControllers: new Map<string, ChatAbortControllerEntry>(),
      dedupe: new Map(),
    };
    const received = vi.fn<(request: unknown) => void>();
    dispatchInboundMessageMock.mockImplementation(async (request) => {
      received(request);
      return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
    });
    let key: string | undefined;
    try {
      const created = await directSessionReq<{ key: string; runStarted: boolean }>(
        "sessions.create",
        {
          agentId: "main",
          task: "Review the public documentation",
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        },
        { ...controlUiClient, context },
      );
      expect(created.ok, JSON.stringify(created.error)).toBe(true);
      expect(created.payload?.runStarted).toBe(true);
      key = created.payload!.key;
      await vi.waitFor(() => expect(received).toHaveBeenCalledOnce());
      const request = received.mock.calls[0]![0];
      if (timeoutMs === undefined) {
        expect(request).not.toHaveProperty("replyOptions.timeoutOverrideMs");
      } else {
        expect(request).toHaveProperty("replyOptions.timeoutOverrideMs", timeoutMs);
      }
    } finally {
      await settleWorkspaceRuns(context, storePath, key, true);
    }
  },
);
