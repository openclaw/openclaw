import { setImmediate } from "node:timers/promises";
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import {
  clearPluginHostRuntimeState,
  dispatchPluginAgentEventSubscriptions,
} from "../host-hook-runtime.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import { setActivePluginRegistry } from "../runtime.js";
import { createPluginRecord } from "../status.test-helpers.js";
import type { OpenClawPluginApi } from "../types.js";

type Subscription = Parameters<OpenClawPluginApi["registerAgentEventSubscription"]>[0];
function subscribe(options: Omit<Subscription, "id" | "handle">) {
  const handle = vi.fn<Subscription["handle"]>();
  const { config, registry } = createPluginRegistryFixture();
  registerTestPlugin({
    registry,
    config,
    record: createPluginRecord({ id: "event-payload" }),
    register(api) {
      api.agent.events.registerAgentEventSubscription({ id: "events", handle, ...options });
    },
  });
  return {
    handle,
    send: (data: Record<string, unknown>, sessionKey?: string) => {
      const event = { runId: "run-payload", seq: 1, ts: 0, stream: "tool", sessionKey, data };
      dispatchPluginAgentEventSubscriptions({
        registry: registry.registry,
        event,
        isLive: () => true,
      });
      return event;
    },
  };
}

afterEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
  clearPluginHostRuntimeState();
  resetAgentEventsForTest();
});

describe("agent event subscription payloads", () => {
  it.each(
    [undefined, [], [" start "]].flatMap((phases) => [
      { phases, payload: undefined },
      { phases, payload: "metadata" as const },
    ]),
  )(
    "filters event phases before cloning with phases=$phases and payload=$payload",
    async ({ phases, payload }) => {
      const { handle, send } = subscribe({ streams: ["tool"], phases, payload });
      const filtered = Boolean(phases?.length);
      for (const phase of ["start", "update", "result", undefined, 1, null]) {
        let payloadReads = 0;
        const data = {
          phase,
          get result() {
            payloadReads++;
            return { text: "tool output" };
          },
        };
        handle.mockClear();
        send(data);
        const delivered = !filtered || phase === "start";
        expect(handle).toHaveBeenCalledTimes(delivered ? 1 : 0);
        expect(payloadReads).toBe(delivered && payload !== "metadata" ? 1 : 0);
      }
      await setImmediate();
    },
  );

  it.each([undefined, "full", "metadata"] as const)(
    "delivers an isolated event snapshot with payload=%s",
    async (payload) => {
      const { handle, send } = subscribe({ payload });
      let payloadReads = 0;
      const primitives = {
        phase: "result",
        empty: "",
        boundary: "a".repeat(256),
        count: 42,
        enabled: false,
        missing: null,
      };
      const full = () => ({
        long: "a".repeat(257),
        nested: { text: "tool output" },
        array: [1, 2],
        absent: undefined,
      });
      const data = {
        ...primitives,
        ...full(),
        ...(payload === "metadata" ? { callback: () => undefined, bigint: 1n } : {}),
        get result() {
          payloadReads++;
          if (payload === "metadata") {
            throw new Error("Metadata must not read payload accessors");
          }
          return { text: "getter output" };
        },
      };
      Object.setPrototypeOf(data, { inherited: "not own" });
      Object.defineProperty(data, "hidden", { value: "not enumerable" });
      const event = send(data, "agent:main:main");
      expect(handle).toHaveBeenCalledTimes(1);
      const delivered = handle.mock.calls[0]![0];
      const expectedData =
        payload === "metadata"
          ? primitives
          : { ...primitives, ...full(), result: { text: "getter output" } };
      expect(delivered).toEqual({ ...event, data: expectedData });
      expect(payloadReads).toBe(payload === "metadata" ? 0 : 1);
      expect(delivered === event).toBe(false);
      expect(delivered.data === data).toBe(false);
      delivered.data.phase = "changed";
      expect(data.phase).toBe("result");
      if (payload !== "metadata") {
        expect(delivered.data.nested).not.toBe(data.nested);
      }
      await setImmediate();
    },
  );
});
