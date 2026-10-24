import { expect } from "vitest";
import type { AgentsListResult, GatewaySessionRow, SessionsListResult } from "../api/types.ts";
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
  const mounted = await mountSidebar(harness.gateway, sessions, "panel", agents);
  return { ...mounted, data: mounted.sidebar.sessionData, harness, sessions, client };
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
  return { ...mounted, data: mounted.sidebar.sessionData, selection, sessions };
}

export const sessionRow = <T extends Partial<GatewaySessionRow>>(
  key: string,
  sessionId: string,
  fields: T,
) => ({ key, sessionId, kind: "direct" as const, ...fields });

export const human = (id: string, label: string) => ({ type: "human" as const, id, label });

export function disposeRoster(roster: {
  provider: { remove(): void };
  sessions: { dispose(): void };
}) {
  roster.provider.remove();
  roster.sessions.dispose();
}

export const rowElement = (sidebar: SidebarLifecycleState, key: string) =>
  sidebar.querySelector(`[data-session-key="${key}"]`);

export const childToggle = (sidebar: SidebarLifecycleState, key?: string) =>
  sidebar.querySelector<HTMLButtonElement>(
    key ? `[data-child-session-toggle="${key}"]` : "[data-child-session-toggle]",
  );

export const findRow = (result: SessionsListResult | null | undefined, key: string) =>
  result?.sessions.find((row) => row.key === key);

export const waitForRequest = (
  request: GatewayRequestHandler,
  method: string,
  params: Record<string, unknown>,
  partial = false,
) =>
  waitForFast(() =>
    expect(request).toHaveBeenCalledWith(
      method,
      partial ? expect.objectContaining(params) : params,
    ),
  );

export const placement = (status: "available" | "offline") => ({
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
});
