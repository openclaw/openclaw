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
// Compile the real router before injecting the scheduler clock.
import "../../server-methods.js";

const reads = ["board.get", "sessions.resolve", "sessions.describe", "users.list", "agents.list"];
const preparations = ["sessions.subscribe", "sessions.messages.subscribe", "models.list"];
const operators = 16;

async function reconnectWave(expire: boolean) {
  const coldRead = createDeferredCore();
  const full = createDeferredCore();
  let active = 0;
  let peak = 0;
  let now = 0;
  const starts: string[] = [];
  const startedAt = new Map<string, number>();
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const handler: GatewayRequestHandler = async ({ req, respond }) => {
    starts.push(req.id);
    startedAt.set(req.id, now);
    // Only the snapshot variant has cold roster work. Event enrollment is cheap.
    if (
      req.method === "models.list" ||
      req.method === "sessions.messages.subscribe" ||
      (req.method === "sessions.subscribe" && asOptionalRecord(req.params)?.limit !== undefined)
    ) {
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
  const events: { method: string; phase: string; queueWaitMs?: number }[] = [];
  const source = channel("openclaw.gateway.rpc");
  const listener = (event: unknown) => events.push(event as (typeof events)[number]);
  source.subscribe(listener);
  const handlers = Object.fromEntries(
    [...reads, ...preparations, "sessions.create", "health"].map((method) => [method, handler]),
  );
  const registry = createGatewayMethodRegistry(createCoreGatewayMethodDescriptors(handlers));
  const calls: Promise<void>[] = [];
  const waveCalls: Promise<void>[] = [];
  const fixtures = Array.from({ length: operators + 4 }, (_, index) => {
    const connId = `reconnect-${index}`;
    const harness = createDispatchTestHarness({ connId, getMethodRegistry: () => registry });
    const client = createOperatorWsClient({ connId });
    return {
      ...harness,
      sendRequest: (id: string, method: string, params = {}) => {
        const call = harness.dispatcher.dispatch(requestFrame(id, method, params), client);
        calls.push(call);
        return call;
      },
    };
  });
  try {
    fixtures.slice(0, 4).forEach((fixture, index) => {
      void fixture.sendRequest(`held-${index}`, "models.list");
    });
    await awaitGateBeforeSettlement(
      full.promise,
      Promise.all(calls),
      "cold preparations settled before filling four slots",
    );
    for (const [index, fixture] of fixtures.slice(4).entries()) {
      const send = (label: string, method: string, params = {}) => {
        waveCalls.push(fixture.sendRequest(`${index}:${label}`, method, params));
      };
      send("events", "sessions.subscribe");
      send("snapshot", "sessions.subscribe", { limit: 60 });
      send("approvals", "sessions.messages.subscribe", { includeApprovals: true });
      send("models.list", "models.list");
      for (const method of reads) {
        send(method, method);
      }
      send("mutation-first", "sessions.create");
      send("mutation-second", "sessions.create");
    }
    await fixtures[0]!.sendRequest("queue-drained", "health");
    await nextTurn();
    const early = Object.fromEntries(
      ["events", "models.list", ...reads, "mutation-first", "mutation-second"].map((label) => [
        label,
        Array.from({ length: operators }, (_, index) => startedAt.get(`${index}:${label}`)).filter(
          (time) => time === 0,
        ).length,
      ]),
    );
    expect(active).toBe(4);
    expect(early["mutation-first"]).toBe(0);
    expect(early["mutation-second"]).toBe(0);
    now = expire ? 30_000 : 1_000;
    if (expire) {
      await vi.advanceTimersByTimeAsync(30_000);
      // Settle wave timeouts before releasing holders, so their model timings stay separate.
      await Promise.all(waveCalls);
    } else {
      coldRead.resolve();
      await Promise.all(calls);
    }
    const queue = Object.fromEntries(
      ["models.list", ...reads].map((method) => {
        const waits = events
          .filter((event) => event.phase === "dispatch" && event.method === method)
          .flatMap((event) => (event.queueWaitMs === undefined ? [] : [event.queueWaitMs]))
          .toSorted((a, b) => a - b);
        return [
          method,
          {
            count: waits.length,
            min: waits[0],
            median: waits[Math.floor(waits.length / 2)],
            max: waits.at(-1),
          },
        ];
      }),
    );
    const responses = fixtures
      .slice(4)
      .flatMap((fixture) =>
        fixture.send.mock.calls.map(([frame]) => frame as GatewayTestResponseFrame),
      );
    const timeouts = responses.filter(
      (frame) => asOptionalRecord(frame.error?.details)?.reason === "request-start-timeout",
    ).length;
    const errors = responses.filter(
      (frame) =>
        !frame.ok && asOptionalRecord(frame.error?.details)?.reason !== "request-start-timeout",
    );
    const mutationOrder = Array.from({ length: operators }, (_, index) => {
      const first = starts.indexOf(`${index}:mutation-first`);
      const second = starts.indexOf(`${index}:mutation-second`);
      const snapshot = starts.indexOf(`${index}:snapshot`);
      const approvals = starts.indexOf(`${index}:approvals`);
      return (
        first >= 0 &&
        second > first &&
        snapshot >= 0 &&
        snapshot < first &&
        approvals >= 0 &&
        approvals < first
      );
    });
    return { early, queue, peak, timeouts, errors, mutationOrder };
  } finally {
    coldRead.resolve();
    vi.useRealTimers();
    await Promise.all(calls);
    source.unsubscribe(listener);
    clock.mockRestore();
  }
}

it("starts independent boot reads past parked snapshot preparations", async () => {
  const result = await reconnectWave(true);
  console.info("L192_WAVE " + JSON.stringify(result));
  expect(result.errors).toEqual([]);
  expect(result.peak).toBeLessThanOrEqual(4);
  expect(result.early["models.list"]).toBe(0);
  expect(result.queue["models.list"]).toEqual({
    count: 16,
    min: 30_000,
    median: 30_000,
    max: 30_000,
  });
  expect
    .soft(result.early.events, "event-only subscription starts without preparation capacity")
    .toBe(16);
  expect.soft(result.timeouts, "only preparations and ordered mutations time out").toBe(80);
  for (const method of reads) {
    expect
      .soft(result.queue[method]?.median, `${method} queue wait behind parked preparation`)
      .toBe(0);
  }
});

it("preserves mutation start order when the cold preparation is released", async () => {
  const result = await reconnectWave(false);
  console.info("L192_ORDERING " + JSON.stringify(result));
  expect(result.errors).toEqual([]);
  expect(result.peak).toBeLessThanOrEqual(4);
  expect(result.timeouts).toBe(0);
  expect(result.mutationOrder).toEqual(Array.from({ length: operators }, () => true));
});
