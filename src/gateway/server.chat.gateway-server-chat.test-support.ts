import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
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
  waitForAdditionalWork?: () => Promise<void>,
) {
  const connectWork: Promise<unknown>[] = [];
  let restoreConnectWork: (() => void) | undefined;
  const waitForConnectWork = async () => {
    // A producer can register catalog tails before releasing its own root.
    while (connectWork.length > 0) {
      await Promise.allSettled(connectWork.splice(0));
    }
  };

  // Install before this suite opens either socket; delegate admission to its real owner.
  beforeAll(async () => {
    const admission = await import("../process/gateway-work-admission.js");
    const beginRoot = admission.tryBeginGatewayRootWorkAdmission;
    const runIndependent = admission.runWithGatewayIndependentRootWorkAdmission;
    const producers = vi
      .spyOn(admission, "tryBeginGatewayRootWorkAdmission")
      .mockImplementation((origin) => {
        const lease = beginRoot(origin);
        // Handler completion can precede release of retained request work.
        return lease && (origin === "ws:connect" || origin === "ws:chat.send")
          ? {
              ...lease,
              run: (run) =>
                lease.run(() => {
                  const released = createDeferred<"settled" | "reset">();
                  const observeRelease = admission.captureGatewayRootWorkReleaseObserver();
                  if (!observeRelease) {
                    throw new Error("connect producer must retain its admitted root");
                  }
                  observeRelease(released.resolve);
                  connectWork.push(released.promise);
                  return run();
                }),
            }
          : lease;
      });
    const tails = vi
      .spyOn(admission, "runWithGatewayIndependentRootWorkAdmission")
      .mockImplementation((run, origin, signal) => {
        const pending = runIndependent(run, origin, signal);
        if (origin === "ws:preauth") {
          connectWork.push(pending);
        }
        return pending;
      });
    restoreConnectWork = () => {
      tails.mockRestore();
      producers.mockRestore();
    };
  });
  beforeEach(waitForConnectWork);
  afterAll(async () => {
    try {
      await waitForConnectWork();
    } finally {
      restoreConnectWork?.();
    }
  });

  installGatewayTestHooks({ scope: "suite" });
  let ws: WebSocket | undefined;
  installConnectedControlUiServerSuite((started) => {
    ws = started.ws;
    onReady(started);
  });

  let requestExecution: Awaited<ReturnType<typeof observeGatewayRunExecution>> | undefined;
  const settleGatewayFixture = async () => {
    await expectDefined(requestExecution, "request execution observer").waitForCompletion();
    await waitForConnectWork();
    await waitForAdditionalWork?.();
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
    waitForConnectWork,
    waitForAgentRunDrained: async (runId: string, target = socket()) => {
      await expectDefined(requestExecution, "request execution observer").waitForCompletion(runId);
      await waitForConnectWork();
      await waitForAdditionalWork?.();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      await request("agent.wait", { runId, timeoutMs: 0 }, "ok", target);
    },
    withMainSessionStore: mainSessionStore.run,
  };
}
