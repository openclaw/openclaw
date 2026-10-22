import { flush } from "solid-js";
import { expect, vi } from "vitest";
import { registerListener } from "../../../../../src/shared/listeners.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../../app/context.ts";
import { createApplicationGateway } from "../../../test-helpers/application-context-fixtures.ts";
import { createTestGatewayClient } from "../../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";

export const STATUS = "doctor.memory.status";
export const DIARY = "doctor.memory.dreamDiary";

export function contextWithRequest(request: Parameters<typeof createTestGatewayClient>[0]) {
  const { gateway, publish } = createApplicationGateway();
  publish({
    ...gateway.snapshot,
    client: createTestGatewayClient(request),
    phase: "connected",
    hello: gatewayHelloForMethods(["config.patch"]),
    sessionKey: "main",
  });
  const configListeners = new Set<() => void>();
  const context = {
    gateway,
    agents: { state: { agentsList: null }, subscribe: () => () => {} },
    runtimeConfig: {
      state: {
        configForm: null,
        configSnapshot: null,
        client: gateway.snapshot.client,
        connected: true,
      },
      ensureLoaded: vi.fn(async () => undefined),
      refresh: vi.fn(async () => undefined),
      patch: vi.fn(async () => true),
      lookupSchemaPath: vi.fn(async () => ({ children: [{ key: "dreaming" }] })),
      subscribe: (listener: () => void) => registerListener(configListeners, listener),
    },
  } as unknown as ApplicationContext;
  return Object.assign(context, {
    emit(patch: Partial<ApplicationGatewaySnapshot>) {
      publish({ ...gateway.snapshot, ...patch });
    },
    setConfig(config: Record<string, unknown>) {
      context.runtimeConfig.state.configForm = config;
      context.runtimeConfig.state.configSnapshot = { config, hash: "synthetic-config-hash" };
      configListeners.forEach((listener) => listener());
    },
  });
}

export function createAgentTarget(initialAgentId: string | null) {
  let agentId = initialAgentId;
  const listeners = new Set<() => void>();
  return {
    read: () => agentId,
    subscribe: (notify: () => void) => registerListener(listeners, notify),
    set: (next: string | null) => {
      agentId = next;
      listeners.forEach((notify) => notify());
    },
    subscriberCount: () => listeners.size,
  };
}

export function click(container: HTMLElement, selector: string) {
  const button = container.querySelector<HTMLButtonElement>(selector);
  expect(button).not.toBeNull();
  button!.click();
  flush();
}

export function diary(content: string) {
  return { found: true, path: "DREAMS.md", content };
}

export const emptyReply = (method: string) =>
  method === STATUS ? { dreaming: null } : { found: false, path: "DREAMS.md" };
