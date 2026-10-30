import { expect, it, onTestFinished, vi } from "vitest";
import { findSourceImportBackedges } from "../../test/helpers/source-import-closure.js";
import type {
  SessionEventOptions,
  SessionEventTarget,
} from "../auto-reply/reply/session-event-contract.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { revokePluginRecord, withPluginRegistryPreparationScope } from "./registry-lifecycle.js";
import { createOwnershipRecord } from "./registry-ownership.test-support.js";
import { createRuntimeTestRegistry } from "./registry-runtime.test-helpers.js";
import { disposePluginRegistryInstances } from "./runtime.js";
import {
  bindGatewayContextResolver,
  clearGatewayContextResolver,
} from "./runtime/gateway-request-scope.js";
import { createPluginRuntime } from "./runtime/index.js";

it("keeps plugin runtime snapshot readers independent of config IO and mutation facades", () => {
  expect(
    findSourceImportBackedges(
      ["src/plugins/registry-runtime.ts", "src/plugins/runtime/system-events.ts"],
      ["src/config/config.ts", "src/config/io.ts", "src/config/mutate.ts"],
    ),
  ).toEqual([]);
});

const host = vi.hoisted(() => ({
  capture: vi.fn<(...args: unknown[]) => Promise<SessionEventTarget>>(),
  enqueue: vi.fn(),
}));
// mock-isolation: Exercise registry-owned system authority without reading sessions or starting model work.
vi.mock("../auto-reply/reply/session-event-handoff.js", () => ({
  captureSessionEventTargetForHost: host.capture,
  enqueueSessionEventForHost: host.enqueue,
}));

function fixture() {
  vi.clearAllMocks();
  const runtime = createPluginRuntime();
  const builder = createRuntimeTestRegistry(runtime);
  onTestFinished(async () => void (await disposePluginRegistryInstances(builder.registry)));
  const record = createOwnershipRecord("event-owner");
  const api = builder.createApi(record, { config: {}, pluginConfig: {} });
  return { runtime, builder, record, system: api.runtime.system };
}

const target = { agentId: "main", sessionKey: "agent:main:main" };
function pendingEvent(system: ReturnType<typeof fixture>["system"]) {
  system.enqueueSessionEvent("Completed", target);
  const forwarded = host.enqueue.mock.calls[0]?.[1] as SessionEventOptions;
  const pending = createDeferredCore<SessionEventTarget>();
  host.capture.mockReturnValueOnce(pending.promise);
  const capture = system.captureSessionEventTarget(target.agentId, target.sessionKey);
  return async (error: string) => {
    pending.resolve({ sessionId: "original", generation: "process" });
    await expect(capture).rejects.toThrow(error);
    expect(() => forwarded.assertCurrent?.()).toThrow(error);
  };
}

it("revokes a pending capture and retained event effects with the plugin instance", async () => {
  const { builder, record, system } = fixture();
  const assertRevoked = pendingEvent(system);
  revokePluginRecord(builder.registry, record);
  await assertRevoked("system owner is no longer active");
  expect(() => system.enqueueSessionEvent("Late", target)).toThrow("runtime is no longer active");
});

it.each(["context", "binding", "removed"] as const)(
  "retains the original Gateway owner after its %s changes",
  async (replacement) => {
    const { runtime, system } = fixture();
    let context = {} as GatewayRequestContext;
    bindGatewayContextResolver(runtime, () => context);
    const assertRevoked = pendingEvent(system);
    if (replacement === "context") {
      context = {} as GatewayRequestContext;
    } else if (replacement === "binding") {
      bindGatewayContextResolver(runtime, () => context);
    } else {
      clearGatewayContextResolver(runtime);
    }
    await assertRevoked("Gateway owner is no longer active");
  },
);

it("does not let replacement preparation route system events", () => {
  const { builder, system } = fixture();
  withPluginRegistryPreparationScope(builder.registry, () => {
    expect(() => system.enqueueSessionEvent("Premature", target)).toThrow(
      "cannot route system events during replacement preparation",
    );
  });
  expect(host.enqueue).not.toHaveBeenCalled();
});
