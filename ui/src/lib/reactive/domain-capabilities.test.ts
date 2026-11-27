import { flush } from "@solidjs/signals";
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
  const loading = agents.ensureList();
  changed.mockClear();
  await loading;
  expect(state.read()).toBe(original);
  expect(state.read().agentsList?.agents).toEqual([{ id: "main" }]);
  expect(changed).toHaveBeenCalledOnce();
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

it("reads config permissions with the mutable draft snapshot", async () => {
  const source = createApplicationGateway();
  const config = owned(createRuntimeConfigCapability(source.gateway));
  const projection = owned(project.projectRuntimeConfig(config));
  const shared = sharedRuntimeConfigProjection(config);
  projection.subscribe(() => {});
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
  expect(shared.read().canSet).toBe(false);
  const previousRevision = projection.revision();
  config.setRaw('{"agents":{}}');
  flush();
  expect(projection.read().state.configRaw).toBe('{"agents":{}}');
  expect(projection.revision()).toBeGreaterThan(previousRevision);
  source.publish({
    ...source.gateway.snapshot,
    hello: gatewayHelloForMethods(
      ["config.get", "config.set", "config.apply", "config.patch", "config.openFile"],
      ["operator.admin"],
    ),
  });
  for (const view of [projection, shared]) {
    const facts = view.read();
    expect(facts).toEqual({
      state: config.state,
      canSet: true,
      canApply: true,
      canPatch: true,
      canOpenFile: true,
    });
    expect(facts.state).toBe(config.state);
  }
  source.publish({
    ...source.gateway.snapshot,
    hello: gatewayHelloForMethods(["config.get"], ["operator.read"]),
  });
  expect(projection.read().canSet).toBe(false);
  expect(shared.read().canSet).toBe(false);
});
