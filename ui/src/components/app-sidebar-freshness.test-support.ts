import { expect } from "vitest";
import type { AgentsListResult, SessionsListResult } from "../api/types.ts";
import { createAgentSelectionCapability } from "../app/agent-selection.ts";
import { createSessionCapability } from "../lib/sessions/index.ts";
import { createTestSessionCapability } from "../lib/sessions/session-capability.test-support.ts";
import {
  createContext,
  createGatewayHarness,
  mountSidebar,
  mountSidebarContext,
  type SidebarLifecycleState,
} from "../test-helpers/app-sidebar.ts";
import {
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../test-helpers/gateway-client.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";

export async function mountRoster(
  request: GatewayRequestHandler,
  agents: AgentsListResult | null = null,
  user?: { id: string; label: string },
) {
  const client = createTestGatewayClient(request);
  const harness = createGatewayHarness(client);
  if (user) {
    harness.publish({ selfUser: { id: user.id, name: user.label } });
  }
  const sessions = createTestSessionCapability(harness.gateway);
  await sessions.refresh({ agentId: "main", force: true });
  return {
    ...(await mountSidebar(harness.gateway, sessions, "panel", agents)),
    harness,
    sessions,
    client,
  };
}

export async function mountSelectedRoster(
  harness: ReturnType<typeof createGatewayHarness>,
  agentsList: AgentsListResult,
  selectedId: string,
) {
  const { gateway } = harness;
  gateway.setSessionKey = (sessionKey) => harness.publish({ sessionKey });
  const selection = createAgentSelectionCapability(
    gateway,
    { state: { agentsList }, subscribe: () => () => undefined },
    { load: () => selectedId, save: () => undefined },
  );
  const sessions = createSessionCapability(gateway, selection);
  const context = { ...createContext(gateway, sessions, agentsList), agentSelection: selection };
  const mounted = await mountSidebarContext(context, "panel", "sessions");
  return { ...mounted, selection, sessions };
}

export function rowElement(sidebar: SidebarLifecycleState, key: string) {
  return sidebar.querySelector(`[data-session-key="${key}"]`);
}

export function childToggle(sidebar: SidebarLifecycleState, key?: string) {
  return sidebar.querySelector<HTMLButtonElement>(
    key ? `[data-child-session-toggle="${key}"]` : "[data-child-session-toggle]",
  );
}

export const findRow = (result: SessionsListResult | null | undefined, key: string) =>
  result?.sessions.find((row) => row.key === key);

export function waitForRequest(
  request: GatewayRequestHandler,
  method: string,
  params: Record<string, unknown>,
  partial = false,
) {
  return waitForFast(() =>
    expect(request).toHaveBeenCalledWith(
      method,
      partial ? expect.objectContaining(params) : params,
    ),
  );
}

export function placement(status: "available" | "offline") {
  return {
    state: "active" as const,
    generation: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
    stateChangedAtMs: 1,
    environmentId: "worker:device",
    activeOwnerEpoch: 1,
    workerBundleHash: "a".repeat(64),
    workspaceBaseManifestRef: "manifest",
    remoteWorkspaceDir: "/workspace",
    runner: { kind: "device" as const, status },
  };
}
