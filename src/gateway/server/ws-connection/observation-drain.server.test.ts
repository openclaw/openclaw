import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForGatewayActiveWork } from "../../../infra/gateway-active-work.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { agentWaitHandler } from "../../server-methods/agent-wait.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "./authenticated-request-dispatch.test-support.js";

afterEach(() => {
  resetGatewayWorkAdmission();
  vi.useRealTimers();
});

describe("Gateway observation drain", () => {
  it.each(["disconnect", "shutdown"] as const)(
    "settles agent.wait and releases root admission on %s without its timeout",
    async (event) => {
      const entered = createDeferredCore();
      const lifetime = new AsyncWorkScope();
      const socket = new EventEmitter();
      const connection = new AbortController();
      socket.once("close", () => connection.abort());
      const client = createOperatorWsClient({ socket });
      client.connectionSignal = connection.signal;
      const fixture = createDispatchTestHarness({
        extraHandlers: {
          "agent.wait": (options) => {
            const result = agentWaitHandler(options);
            entered.resolve();
            return result;
          },
        },
        buildRequestContext: () => ({
          dedupe: new Map(),
          chatAbortControllers: new Map(),
          chatQueuedTurns: new Map(),
          getRuntimeConfig: () => ({}),
        }),
      });
      vi.useFakeTimers();
      let settled = false;
      const dispatch = lifetime
        .track(() =>
          fixture.dispatcher.dispatch(
            {
              type: "req",
              id: "wait",
              method: "agent.wait",
              params: { runId: `missing-${event}`, timeoutMs: 1_500_000 },
            },
            client,
          ),
        )
        .finally(() => {
          settled = true;
        });
      try {
        await entered.promise;
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        expect(settled).toBe(false);
        if (event === "disconnect") {
          socket.emit("close");
        } else {
          markGatewayRestartDraining("stop (SIGTERM)");
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(getActiveGatewayRootWorkCount()).toBe(0);
        expect(settled).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
        if (event === "shutdown") {
          expect(await waitForGatewayActiveWork(315_000)).toMatchObject({ drained: true });
          expect(fixture.send).toHaveBeenCalledWith(
            expect.objectContaining({
              id: "wait",
              ok: false,
              error: expect.objectContaining({
                code: "UNAVAILABLE",
                message: "agent.wait unavailable during gateway restart",
                retryable: true,
                retryAfterMs: 1_000,
                details: expect.objectContaining({ reason: "gateway-restarting" }),
              }),
            }),
          );
        } else {
          expect(fixture.send).not.toHaveBeenCalled();
        }
      } finally {
        lifetime.beginClose();
        await dispatch;
        await lifetime.drain();
      }
    },
  );

  it("does not send a second response when shutdown follows a completed observation", async () => {
    const fixture = createDispatchTestHarness({
      extraHandlers: { "agent.wait": agentWaitHandler },
      buildRequestContext: () => ({
        dedupe: new Map(),
        chatAbortControllers: new Map(),
        chatQueuedTurns: new Map(),
        getRuntimeConfig: () => ({}),
      }),
    });
    const shutdown = fixture.awaitResponseFrame("completed").then(() => {
      markGatewayRestartDraining("stop (SIGTERM)");
    });
    await fixture.dispatcher.dispatch(
      {
        type: "req",
        id: "completed",
        method: "agent.wait",
        params: { runId: "missing-completed", timeoutMs: 0 },
      },
      createOperatorWsClient(),
    );
    await shutdown;
    expect(fixture.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ok: true }));
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("keeps a mutating request admitted through disconnect and shutdown until settlement", async () => {
    const entered = createDeferredCore();
    const finish = createDeferredCore();
    const connection = new AbortController();
    const client = createOperatorWsClient();
    client.connectionSignal = connection.signal;
    const fixture = createDispatchTestHarness({
      extraHandlers: {
        "test.write": async ({ respond }) => {
          entered.resolve();
          await finish.promise;
          respond(true, {});
        },
      },
    });
    vi.useFakeTimers();
    const dispatch = fixture.dispatcher.dispatch(
      { type: "req", id: "write", method: "test.write", params: {} },
      client,
    );
    try {
      await entered.promise;
      connection.abort();
      markGatewayRestartDraining("stop (SIGTERM)");
      await vi.advanceTimersByTimeAsync(0);
      expect(getActiveGatewayRootWorkCount()).toBe(1);
    } finally {
      finish.resolve();
      await dispatch;
    }
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });
});
