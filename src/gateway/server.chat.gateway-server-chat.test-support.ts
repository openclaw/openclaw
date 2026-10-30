import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, afterEach, beforeAll, beforeEach, expect } from "vitest";
import type { WebSocket } from "ws";
import { createDeferred } from "../../test/helpers/promise.js";
import { waitForAbortSignal } from "../infra/abort-signal.js";
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
  const request = async (method: string, params: unknown, status?: string, target = socket()) => {
    const res = await rpcReq(target, method, params);
    expect(res.ok).toBe(true);
    if (status !== undefined) {
      expect(res.payload?.status).toBe(status);
    }
    return res;
  };
  return {
    abortChatRun: (runId: string) => request("chat.abort", { sessionKey: "main", runId }),
    expectAgentWaitTimeout: (res: Awaited<ReturnType<typeof rpcReq>>, error?: string) => {
      expect(res).toMatchObject({ ok: true, payload: { status: "timeout" } });
      if (error !== undefined) {
        expect(res.payload).toMatchObject({ error, pendingError: true });
      }
    },
    expectRecordFields,
    get requestExecution() {
      return expectDefined(requestExecution, "request execution observer");
    },
    mockBlockedChatReply: () => {
      const blockedReply = createDeferred();
      mockGetReplyFromConfigOnce(async (_ctx, opts) => {
        await (opts?.abortSignal
          ? Promise.race([blockedReply.promise, waitForAbortSignal(opts.abortSignal)])
          : blockedReply.promise);
      });
      return blockedReply.resolve;
    },
    sendChatAndExpectStarted: (runId: string, message = "/context list") =>
      request("chat.send", { sessionKey: "main", message, idempotencyKey: runId }, "started"),
    settleGatewayFixture,
    waitForAgentRunDrained: async (runId: string, target = socket()) => {
      await expectDefined(requestExecution, "request execution observer").waitForCompletion(runId);
      await waitForConnectWork?.();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      await request("agent.wait", { runId, timeoutMs: 0 }, "ok", target);
    },
    withMainSessionStore: mainSessionStore.run,
  };
}
