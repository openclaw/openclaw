import { createRoot, flush } from "@solidjs/signals";
import { expect, it, onTestFinished, vi } from "vitest";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { createAgentCapability } from "../agents/index.ts";
import { createChannelCapability } from "../channels/index.ts";
import { configSnapshot } from "../config/config-snapshot.test-support.ts";
import { createRuntimeConfigCapability } from "../config/runtime-config-capability.ts";
import * as project from "./domain-capabilities.ts";
import { sharedRuntimeConfigProjection } from "./shared-application-projections.ts";

function owned<T extends { dispose(): void }>(owner: T): T {
  onTestFinished(() => owner.dispose());
  return owner;
}

it("publishes mutable agent state", async () => {
  const source = createApplicationGateway();
  const client = createTestGatewayClient(async (method) => {
    expect(method).toBe("agents.list");
    return { defaultId: "main", mainKey: "main", scope: "per-sender", agents: [{ id: "main" }] };
  });
  const agents = owned(createAgentCapability(source.gateway));
  const state = owned(project.projectAgents(agents));
  const changed = vi.fn();
  state.subscribe(changed);
  const original = state.read();
  expect(original.agentsList).toBeNull();
  source.publish({ ...source.gateway.snapshot, client, phase: "connected" });
  await agents.ensureList();
  expect(state.read()).toBe(original);
  expect(state.read().agentsList?.agents).toEqual([{ id: "main" }]);
  expect(changed).toHaveBeenCalled();
});

it("invalidates channel state on the real connection boundary", () => {
  const source = createApplicationGateway();
  const channels = owned(createChannelCapability(source.gateway));
  const projection = owned(project.projectChannels(channels));
  const changed = vi.fn();
  projection.subscribe(changed);
  expect(projection.read().connected).toBe(false);
  source.publish({ ...source.gateway.snapshot, phase: "connected" });
  expect(projection.read().connected).toBe(true);
  expect(changed).toHaveBeenCalledOnce();
  projection.dispose();
  source.publish({ ...source.gateway.snapshot, phase: "stopped" });
  expect(changed).toHaveBeenCalledOnce();
});

it("keeps runtime-config facts aligned without merging local and shared lifetimes", async () => {
  const source = createApplicationGateway();
  const config = owned(createRuntimeConfigCapability(source.gateway));
  const other = owned(createRuntimeConfigCapability(createApplicationGateway().gateway));
  const track = (owner: typeof config) => {
    const subscribe = owner.subscribe.bind(owner);
    const release = vi.fn();
    const subscriptions = vi.spyOn(owner, "subscribe").mockImplementation((notify) => {
      const stop = subscribe(notify);
      return () => {
        release();
        stop();
      };
    });
    return { subscriptions, release };
  };
  const first = track(config);
  const second = track(other);
  const local = createRoot((dispose) => ({
    projection: project.projectRuntimeConfig(config),
    dispose,
  }));
  onTestFinished(local.dispose);
  const projection = local.projection;
  const shared = sharedRuntimeConfigProjection(config);
  const separate = sharedRuntimeConfigProjection(other);
  expect(sharedRuntimeConfigProjection(config)).toBe(shared);
  expect(separate).not.toBe(shared);
  expect([first.subscriptions.mock.calls.length, second.subscriptions.mock.calls.length]).toEqual([
    0, 0,
  ]);
  projection.subscribe(() => {});
  const stopLeft = shared.subscribe(() => {});
  const changed = vi.fn();
  const stopRight = shared.subscribe(changed);
  const stopOther = separate.subscribe(() => {});
  onTestFinished(() => {
    stopLeft();
    stopRight();
    stopOther();
    first.subscriptions.mockRestore();
    second.subscriptions.mockRestore();
  });
  expect([first.subscriptions.mock.calls.length, second.subscriptions.mock.calls.length]).toEqual([
    2, 1,
  ]);
  expect(projection.read().canSet).toBe(false);
  const client = createTestGatewayClient(async () => configSnapshot({}));
  source.publish({
    ...source.gateway.snapshot,
    client,
    phase: "connected",
    hello: gatewayHelloForMethods(["config.get"], ["operator.read"]),
  });
  await config.ensureLoaded();
  expect(projection.read().canSet).toBe(false);
  source.publish({
    ...source.gateway.snapshot,
    hello: gatewayHelloForMethods(
      ["config.get", "config.set", "config.apply", "config.patch", "config.openFile"],
      ["operator.admin"],
    ),
  });
  const previousRevision = projection.revision();
  config.setRaw('{"agents":{}}');
  flush();
  for (const view of [projection, shared]) {
    expect(view.read()).toEqual({
      state: config.state,
      canSet: true,
      canApply: true,
      canPatch: true,
      canOpenFile: true,
    });
    expect(view.read().state).toBe(config.state);
    expect(view.read()).not.toBe(view.read());
    expect(view.read().state.configRaw).toBe('{"agents":{}}');
  }
  expect(projection.revision()).toBeGreaterThan(previousRevision);
  expect(separate.read().state).toBe(other.state);
  expect(separate.read().canSet).toBe(false);
  projection.replaceSource(other);
  expect(projection.read().state).toBe(other.state);
  expect(first.release).toHaveBeenCalledOnce();
  expect(second.subscriptions).toHaveBeenCalledTimes(2);
  local.dispose();
  expect(second.release).toHaveBeenCalledOnce();
  changed.mockClear();
  config.setRaw("{}");
  expect(changed).toHaveBeenCalledOnce();
  expect(shared.read().state.configRaw).toBe("{}");
  stopLeft();
  expect(first.release).toHaveBeenCalledOnce();
  stopRight();
  expect(first.release).toHaveBeenCalledTimes(2);
  stopOther();
  expect(second.release).toHaveBeenCalledTimes(2);
  source.publish({
    ...source.gateway.snapshot,
    hello: gatewayHelloForMethods(["config.get"], ["operator.read"]),
  });
  expect(shared.read().canSet).toBe(false);
  expect(first.subscriptions).toHaveBeenCalledTimes(2);
});
