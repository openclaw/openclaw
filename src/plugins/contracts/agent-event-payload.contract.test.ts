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

async function waitForPluginEventHandlers(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
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
      const handle = vi.fn();
      const { config, registry } = createPluginRegistryFixture();
      registerTestPlugin({
        registry,
        config,
        record: createPluginRecord({ id: "phase-filter" }),
        register(api) {
          api.agent.events.registerAgentEventSubscription({
            id: "events",
            streams: ["tool"],
            phases,
            payload,
            handle,
          });
        },
      });
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
        dispatchPluginAgentEventSubscriptions({
          registry: registry.registry,
          event: { runId: "run-phase-filter", seq: 1, ts: 0, stream: "tool", data },
          isLive: () => true,
        });
        const delivered = !filtered || phase === "start";
        expect(handle).toHaveBeenCalledTimes(delivered ? 1 : 0);
        expect(payloadReads).toBe(delivered && payload !== "metadata" ? 1 : 0);
      }
      await waitForPluginEventHandlers();
    },
  );

  it.each([undefined, "full", "metadata"] as const)(
    "delivers an isolated event snapshot with payload=%s",
    async (payload) => {
      const handle =
        vi.fn<Parameters<OpenClawPluginApi["registerAgentEventSubscription"]>[0]["handle"]>();
      const { config, registry } = createPluginRegistryFixture();
      registerTestPlugin({
        registry,
        config,
        record: createPluginRecord({ id: "payload-mode" }),
        register(api) {
          api.agent.events.registerAgentEventSubscription({
            id: "events",
            payload,
            handle,
          });
        },
      });
      let payloadReads = 0;
      const primitives = {
        phase: "result",
        empty: "",
        boundary: "a".repeat(256),
        count: 42,
        enabled: false,
        missing: null,
      };
      const data = {
        ...primitives,
        long: "a".repeat(257),
        nested: { text: "tool output" },
        array: [1, 2],
        absent: undefined,
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
      const event = {
        runId: "run-payload-mode",
        seq: 1,
        ts: 0,
        stream: "tool",
        sessionKey: "agent:main:main",
        data,
      };
      dispatchPluginAgentEventSubscriptions({
        registry: registry.registry,
        event,
        isLive: () => true,
      });
      expect(handle).toHaveBeenCalledTimes(1);
      const delivered = handle.mock.calls[0]![0];
      expect(delivered).toEqual({
        ...event,
        data:
          payload === "metadata"
            ? primitives
            : {
                ...primitives,
                long: "a".repeat(257),
                nested: { text: "tool output" },
                array: [1, 2],
                absent: undefined,
                result: { text: "getter output" },
              },
      });
      expect(payloadReads).toBe(payload === "metadata" ? 0 : 1);
      expect(delivered === event).toBe(false);
      expect(delivered.data === data).toBe(false);
      delivered.data.phase = "changed";
      expect(data.phase).toBe("result");
      if (payload !== "metadata") {
        expect(delivered.data.nested === data.nested).toBe(false);
      }
      await waitForPluginEventHandlers();
    },
  );
});
