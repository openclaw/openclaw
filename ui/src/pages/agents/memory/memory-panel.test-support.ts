import { flush } from "solid-js";
import { expect, vi } from "vitest";
import { registerListener } from "../../../../../src/shared/listeners.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../../app/context.ts";
import { hasOperatorReadAccess } from "../../../app/operator-access.ts";
import { createApplicationGateway } from "../../../test-helpers/application-context-fixtures.ts";
import { createTestGatewayClient } from "../../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createAgentMemory, type AgentMemoryState } from "./memory-panel-state.ts";
import { AgentMemoryView } from "./memory-panel-view.tsx";

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
      openFile: vi.fn(async () => undefined),
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

export function requestFor(
  replies: Record<string, () => unknown>,
  fallback: (method: string) => unknown = emptyReply,
) {
  return vi.fn((method: string) => replies[method]?.() ?? fallback(method));
}

export async function createPage(
  replies:
    | Parameters<typeof createTestGatewayClient>[0]
    | Record<string, () => unknown> = emptyReply,
  agentId = "main",
  hello = gatewayHelloForMethods(["config.patch"]),
) {
  const request = typeof replies === "function" ? vi.fn(replies) : requestFor(replies);
  const context = contextWithRequest(request);
  context.emit({ hello });
  const agentTarget = createAgentTarget(agentId);
  let state: AgentMemoryState;
  const { container, unmount } = mountSolid(() => {
    state = createAgentMemory(context, () => agentTarget);
    return AgentMemoryView({ state });
  });
  await waitForSolid(() => {
    // Initial config loading can yield before the first resource is admitted.
    if (agentId && hasOperatorReadAccess(hello.auth)) {
      expect(request).toHaveBeenCalledWith(STATUS, { agentId });
      expect(request).toHaveBeenCalledWith(DIARY, { agentId });
    }
    expect(state.view().header.refreshLoading).toBe(false);
  });
  return {
    get state() {
      return state;
    },
    context,
    request,
    get dreaming() {
      return state.view().dreaming;
    },
    get toggle() {
      return state.view().toggle;
    },
    query: container.querySelector.bind(container),
    text: (selector: string) => container.querySelector(selector)?.textContent,
    waitText: (selector: string, text: string) =>
      waitForSolid(() => expect(container.querySelector(selector)?.textContent).toBe(text)),
    container,
    setAgentId: agentTarget.set,
    unmount,
  };
}
