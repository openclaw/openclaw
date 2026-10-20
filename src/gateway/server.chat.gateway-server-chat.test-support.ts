import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, afterEach, beforeAll, beforeEach, expect } from "vitest";
import type { WebSocket } from "ws";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  getActiveGatewayRootWorkCount,
  getActiveGatewayRootWorkHolders,
} from "../process/gateway-work-admission.js";
import { drainOpenClawAgentWriteQueuesForTest } from "../state/openclaw-agent-write-admission.test-support.js";
import { observeGatewayRunExecution } from "./agent-command.test-helpers.js";
import { flushPendingSessionsChangedEvents } from "./server-methods/session-change-event.js";
import { createMainChatSessionStoreFixture } from "./server.chat-session-store.test-support.js";
import {
  dispatchInboundMessageMock,
  installGatewayTestHooks,
  mockGetReplyFromConfigOnce,
  rpcReq,
} from "./test-helpers.js";
import { installConnectedControlUiServerSuite } from "./test-with-server.js";

type ConnectedServerReady = Parameters<typeof installConnectedControlUiServerSuite>[0];

/** Install one isolated connected Gateway and session-store lifecycle for a chat test file. */
export function installGatewayServerChatTestSuite(
  onReady: ConnectedServerReady,
  waitForConnectWork?: () => Promise<void>,
) {
  installGatewayTestHooks({ scope: "suite" });
  let ws: WebSocket | undefined;
  installConnectedControlUiServerSuite((started) => {
    ws = started.ws;
    onReady(started);
  });

  let requestExecution: Awaited<ReturnType<typeof observeGatewayRunExecution>> | undefined;
  const settleGatewayFixture = async () => {
    await expectDefined(requestExecution, "request execution observer").waitForCompletion();
    await waitForConnectWork?.();
    await drainOpenClawAgentWriteQueuesForTest();
    await flushPendingSessionsChangedEvents();
    expect(getActiveGatewayRootWorkCount(), getActiveGatewayRootWorkHolders().join(", ")).toBe(0);
  };

  beforeEach(async () => {
    dispatchInboundMessageMock.mockReset();
    requestExecution = await observeGatewayRunExecution();
  });
  afterEach(async () => {
    try {
      await settleGatewayFixture();
    } finally {
      await requestExecution?.restore();
      requestExecution = undefined;
    }
  });

  const mainSessionStore = createMainChatSessionStoreFixture(settleGatewayFixture);
  beforeAll(mainSessionStore.prepare);
  afterAll(mainSessionStore.dispose);

  const socket = () => expectDefined(ws, "connected Gateway socket");
  const expectRecordFields = (value: unknown, expected: Record<string, unknown>) => {
    if (!value || typeof value !== "object") {
      throw new Error("Expected record");
    }
    const actual = value as Record<string, unknown>;
    for (const [key, expectedValue] of Object.entries(expected)) {
      expect(actual[key]).toEqual(expectedValue);
    }
    return actual;
  };
  const expectAgentWaitTimeout = (res: Awaited<ReturnType<typeof rpcReq>>, error?: string) => {
    expect(res.ok).toBe(true);
    expect(res.payload?.status).toBe("timeout");
    if (error !== undefined) {
      expect(res.payload?.error).toBe(error);
      expect(res.payload?.pendingError).toBe(true);
    }
  };
  const expectAgentWaitStartedAt = (res: Awaited<ReturnType<typeof rpcReq>>, startedAt: number) => {
    expect(res.ok).toBe(true);
    expect(res.payload?.status).toBe("ok");
    expect(res.payload?.startedAt).toBe(startedAt);
  };
  const sendChatAndExpectStarted = async (runId: string, message = "/context list") => {
    const res = await rpcReq(socket(), "chat.send", {
      sessionKey: "main",
      message,
      idempotencyKey: runId,
    });
    expect(res.ok).toBe(true);
    expect(res.payload?.status).toBe("started");
    return res;
  };
  const waitForAgentRunOk = async (runId: string, timeoutMs = 1_000, target = socket()) => {
    const res = await rpcReq(target, "agent.wait", { runId, timeoutMs });
    expect(res.ok).toBe(true);
    expect(res.payload?.status, JSON.stringify(res.payload)).toBe("ok");
    return res;
  };
  const waitForAgentRunDrained = async (runId: string, target = socket()) => {
    await expectDefined(requestExecution, "request execution observer").waitForCompletion(runId);
    await waitForConnectWork?.();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    await waitForAgentRunOk(runId, 0, target);
  };
  const abortChatRun = async (runId: string) => {
    const res = await rpcReq(socket(), "chat.abort", { sessionKey: "main", runId });
    expect(res.ok).toBe(true);
    return res;
  };
  const mockBlockedChatReply = () => {
    const blockedReply = createDeferred();
    mockGetReplyFromConfigOnce(async (_ctx, opts) => {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        };
        void blockedReply.promise.then(finish);
        if (opts?.abortSignal?.aborted) {
          finish();
        } else {
          opts?.abortSignal?.addEventListener("abort", finish, { once: true });
        }
      });
      return undefined;
    });
    return blockedReply.resolve;
  };

  return {
    abortChatRun,
    expectAgentWaitStartedAt,
    expectAgentWaitTimeout,
    expectRecordFields,
    get requestExecution() {
      return expectDefined(requestExecution, "request execution observer");
    },
    mockBlockedChatReply,
    sendChatAndExpectStarted,
    settleGatewayFixture,
    waitForAgentRunDrained,
    withMainSessionStore: mainSessionStore.run,
  };
}
