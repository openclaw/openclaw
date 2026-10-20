import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, afterEach, beforeAll, beforeEach, expect } from "vitest";
import type { WebSocket } from "ws";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  getActiveGatewayRootWorkCount,
  getActiveGatewayRootWorkHolders,
} from "../process/gateway-work-admission.js";
import { drainOpenClawAgentWriteQueuesForTest } from "../state/openclaw-agent-write-admission.test-support.js";
import { expectObjectFields as expectRecordFields } from "../test-utils/mock-call-assertions.js";
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
  const expectRunStatus = (res: Awaited<ReturnType<typeof rpcReq>>, status: string) =>
    expect(res).toMatchObject({ ok: true, payload: { status } });
  const expectAgentWaitTimeout = (res: Awaited<ReturnType<typeof rpcReq>>, error?: string) => {
    expectRunStatus(res, "timeout");
    if (error !== undefined) {
      expect(res.payload).toMatchObject({ error, pendingError: true });
    }
  };
  const expectAgentWaitStartedAt = (res: Awaited<ReturnType<typeof rpcReq>>, startedAt: number) => {
    expectRunStatus(res, "ok");
    expect(res.payload?.startedAt).toBe(startedAt);
  };
  const sendChatAndExpectStarted = async (runId: string, message = "/context list") => {
    const res = await rpcReq(socket(), "chat.send", {
      sessionKey: "main",
      message,
      idempotencyKey: runId,
    });
    expectRunStatus(res, "started");
    return res;
  };
  const waitForAgentRunOk = async (runId: string, timeoutMs = 1_000, target = socket()) => {
    const res = await rpcReq(target, "agent.wait", { runId, timeoutMs });
    expectRunStatus(res, "ok");
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
        void blockedReply.promise.then(resolve);
        if (opts?.abortSignal?.aborted) {
          resolve();
        } else {
          opts?.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
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
