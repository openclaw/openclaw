import { channel } from "node:diagnostics_channel";
import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../../test/helpers/promise.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  createCoreGatewayMethodDescriptors,
  createGatewayMethodRegistry,
} from "../../methods/registry.js";
import type { GatewayRequestHandler } from "../../server-methods/types.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
  requestFrame,
  type GatewayTestResponseFrame,
} from "./authenticated-request-dispatch.test-support.js";
// Compile the production router before holding the synthetic cold-read boundary.
import "../../server-methods.js";

it("starts boot reads during a reconnect wave without releasing parked preparation or mutation order", async () => {
  const reads = [
    "board.get",
    "sessions.resolve",
    "sessions.describe",
    "users.list",
    "agents.list",
    "example.lookup",
  ];
  const preparations = ["sessions.subscribe", "sessions.messages.subscribe", "models.list"];
  const coldRead = createDeferredCore();
  const full = createDeferredCore();
  let active = 0;
  let peak = 0;
  let now = 0;
  const started = new Map<string, number>();
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const handler: GatewayRequestHandler = async ({ req, respond }) => {
    started.set(req.id, now);
    if (preparations.includes(req.method)) {
      peak = Math.max(peak, ++active);
      if (active === 4) {
        full.resolve();
      }
      try {
        await coldRead.promise;
      } finally {
        active--;
      }
    }
    respond(true, {});
  };
  const events: { method: string; queueWaitMs?: number; phase: string }[] = [];
  const source = channel("openclaw.gateway.rpc");
  const listener = (event: unknown) => {
    events.push(event as (typeof events)[number]);
  };
  source.subscribe(listener);
  const handlers = Object.fromEntries(
    [...reads, ...preparations, "sessions.create", "health"].map((method) => [method, handler]),
  );
  const { "example.lookup": pluginHandler, ...coreHandlers } = handlers;
  const registry = createGatewayMethodRegistry([
    ...createCoreGatewayMethodDescriptors(coreHandlers),
    {
      name: "example.lookup",
      handler: pluginHandler!,
      owner: { kind: "plugin", pluginId: "request-start-test" },
      scope: "operator.read",
    },
  ]);
  const calls: Promise<void>[] = [];
  const fixtures = Array.from({ length: 20 }, (_, index) => {
    const connId = `reconnect-${index}`;
    const harness = createDispatchTestHarness({ connId, getMethodRegistry: () => registry });
    const client = createOperatorWsClient({ connId });
    return {
      ...harness,
      sendRequest: (id: string, method: string) => {
        const call = harness.dispatcher.dispatch(
          requestFrame(
            id,
            method,
            method === "sessions.messages.subscribe" ? { includeApprovals: true } : {},
          ),
          client,
        );
        calls.push(call);
        return call;
      },
    };
  });
  try {
    fixtures
      .slice(0, 4)
      .forEach((fixture, index) => void fixture.sendRequest(`held-${index}`, "models.list"));
    await awaitGateBeforeSettlement(
      full.promise,
      Promise.all(calls),
      "cold preparations settled before occupying all four slots",
    );
    for (const [index, fixture] of fixtures.slice(4).entries()) {
      for (const method of [...preparations, ...reads, "sessions.create"]) {
        void fixture.sendRequest(`${index}:${method}`, method);
      }
    }
    // An unrelated connection's final request witnesses the runnable queue drain.
    await fixtures[0]!.sendRequest("queue-drained", "health");
    await nextTurn();
    const earlyReads = reads.map(
      (method) =>
        fixtures.slice(4).filter((_fixture, index) => started.get(`${index}:${method}`) === 0)
          .length,
    );
    expect(active).toBe(4);
    expect(started.has("0:sessions.create")).toBe(false);
    now = 30_000;
    await vi.advanceTimersByTimeAsync(30_000);
    coldRead.resolve();
    await Promise.all(calls);
    const timeouts = fixtures.reduce(
      (count, fixture) =>
        count +
        fixture.send.mock.calls.filter(
          ([frame]) =>
            asOptionalRecord((frame as GatewayTestResponseFrame).error?.details)?.reason ===
            "request-start-timeout",
        ).length,
      0,
    );
    const queue = Object.fromEntries(
      [...preparations, ...reads, "sessions.create"].map((method) => {
        const waits = events
          .filter((event) => event.phase === "dispatch" && event.method === method)
          .map((event) => event.queueWaitMs);
        return [
          method,
          {
            count: waits.length,
            min: Math.min(...waits.filter((wait): wait is number => wait !== undefined)),
            max: Math.max(...waits.filter((wait): wait is number => wait !== undefined)),
          },
        ];
      }),
    );
    console.info(JSON.stringify({ earlyReads, peak, queue, timeouts }));
    expect(earlyReads).toEqual(reads.map(() => 16));
    expect(peak).toBe(4);
    expect(timeouts).toBe(64);
    for (const method of reads) {
      expect(queue[method]).toEqual({ count: 16, min: 0, max: 0 });
    }
  } finally {
    coldRead.resolve();
    vi.useRealTimers();
    await Promise.all(calls);
    source.unsubscribe(listener);
    clock.mockRestore();
  }
});
