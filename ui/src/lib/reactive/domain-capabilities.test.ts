import { flush } from "@solidjs/signals";
import { expect, it, onTestFinished, vi } from "vitest";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createAgentCapability } from "../agents/index.ts";
import { createChannelCapability } from "../channels/index.ts";
import { createRuntimeConfigCapability } from "../config/runtime-config-capability.ts";
import * as project from "./domain-capabilities.ts";

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

it("reads config permissions with the mutable draft snapshot", () => {
  const source = createApplicationGateway();
  const config = owned(createRuntimeConfigCapability(source.gateway));
  const projection = owned(project.projectRuntimeConfig(config));
  projection.subscribe(() => {});
  expect(projection.read().canSet).toBe(false);
  config.setRaw('{"agents":{}}');
  flush();
  expect(projection.read().state.configRaw).toBe('{"agents":{}}');
  expect(projection.revision()).toBeGreaterThan(0);
});
