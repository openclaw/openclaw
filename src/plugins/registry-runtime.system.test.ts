import { afterEach, expect, it, vi } from "vitest";
import type {
  SessionEventOptions,
  SessionEventTarget,
} from "../auto-reply/reply/session-event-contract.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createPluginRecord } from "./loader-records.js";
import { revokePluginRecord, withPluginRegistryPreparationScope } from "./registry-lifecycle.js";
import { createRuntimeTestRegistry } from "./registry-runtime.test-helpers.js";
import { disposePluginRegistryInstances } from "./runtime.js";
import {
  bindGatewayContextResolver,
  clearGatewayContextResolver,
} from "./runtime/gateway-request-scope.js";
import { createPluginRuntime } from "./runtime/index.js";

const host = vi.hoisted(() => ({
  capture: vi.fn<(...args: unknown[]) => Promise<SessionEventTarget>>(),
  enqueue: vi.fn(),
}));
// mock-isolation: Exercise registry-owned system authority without reading sessions or starting model work.
vi.mock("../auto-reply/reply/session-event-handoff.js", () => ({
  captureSessionEventTargetForHost: host.capture,
  enqueueSessionEventForHost: host.enqueue,
}));

const registries: Array<ReturnType<typeof createRuntimeTestRegistry>["registry"]> = [];
afterEach(async () => {
  await Promise.all(
    registries.splice(0).map((registry) => disposePluginRegistryInstances(registry)),
  );
  vi.clearAllMocks();
});

function fixture() {
  const runtime = createPluginRuntime();
  const builder = createRuntimeTestRegistry(runtime);
  registries.push(builder.registry);
  const record = createPluginRecord({
    id: "event-owner",
    source: "/plugins/event-owner/index.js",
    origin: "global",
    enabled: true,
    configSchema: false,
  });
  const api = builder.createApi(record, { config: {}, pluginConfig: {} });
  return { runtime, builder, record, system: api.runtime.system };
}

it("revokes a pending capture and retained event effects with the plugin instance", async () => {
  const { builder, record, system } = fixture();
  system.enqueueSessionEvent("Completed", { agentId: "main", sessionKey: "agent:main:main" });
  const forwarded = host.enqueue.mock.calls[0]?.[1] as SessionEventOptions;
  const pending = createDeferredCore<SessionEventTarget>();
  host.capture.mockReturnValueOnce(pending.promise);
  const capture = system.captureSessionEventTarget("main", "agent:main:main");
  revokePluginRecord(builder.registry, record);
  pending.resolve({ sessionId: "original", generation: "process" });
  await expect(capture).rejects.toThrow("system owner is no longer active");
  expect(() => forwarded.assertCurrent?.()).toThrow("system owner is no longer active");
  expect(() =>
    system.enqueueSessionEvent("Late", {
      agentId: "main",
      sessionKey: "agent:main:main",
    }),
  ).toThrow("runtime is no longer active");
});

it.each(["context", "binding", "removed"] as const)(
  "retains the original Gateway owner after its %s changes",
  async (replacement) => {
    const { runtime, system } = fixture();
    let context = {} as GatewayRequestContext;
    bindGatewayContextResolver(runtime, () => context);
    system.enqueueSessionEvent("Completed", { agentId: "main", sessionKey: "agent:main:main" });
    const forwarded = host.enqueue.mock.calls[0]?.[1] as SessionEventOptions;
    const pending = createDeferredCore<SessionEventTarget>();
    host.capture.mockReturnValueOnce(pending.promise);
    const capture = system.captureSessionEventTarget("main", "agent:main:main");
    if (replacement === "context") {
      context = {} as GatewayRequestContext;
    } else if (replacement === "binding") {
      bindGatewayContextResolver(runtime, () => context);
    } else {
      clearGatewayContextResolver(runtime);
    }
    pending.resolve({ sessionId: "original", generation: "process" });
    await expect(capture).rejects.toThrow("Gateway owner is no longer active");
    expect(() => forwarded.assertCurrent?.()).toThrow("Gateway owner is no longer active");
  },
);

it("does not let replacement preparation route system events", () => {
  const { builder, system } = fixture();
  withPluginRegistryPreparationScope(builder.registry, () => {
    expect(() =>
      system.enqueueSessionEvent("Premature", {
        agentId: "main",
        sessionKey: "agent:main:main",
      }),
    ).toThrow("cannot route system events during replacement preparation");
  });
  expect(host.enqueue).not.toHaveBeenCalled();
});
