import { vi } from "vitest";
import type { QuestionRequestedEvent } from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsListResult } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { ExecApprovalRequest } from "../../app/exec-approval.ts";
import {
  createGatewayHarness,
  createSessions,
  mountSidebar,
  type SidebarLifecycleState,
} from "../app-sidebar.ts";

const catalogHello = {
  auth: { role: "operator", scopes: ["operator.read"] },
  features: { methods: ["sessions.catalog.list"] },
} as ApplicationGatewaySnapshot["hello"];

export function catalogGateway(
  client: GatewayBrowserClient,
  snapshot: Partial<ApplicationGatewaySnapshot> = {},
) {
  const gateway = createGatewayHarness(client);
  gateway.publish({ hello: catalogHello, ...snapshot });
  return gateway;
}

export async function startCatalog(sidebar: SidebarLifecycleState) {
  sidebar.connected = true;
  await sidebar.updateComplete;
  await vi.advanceTimersByTimeAsync(0);
}

export async function mountCatalog(
  client: GatewayBrowserClient,
  options: {
    snapshot?: Partial<ApplicationGatewaySnapshot>;
    sessions?: Parameters<typeof mountSidebar>[1];
    agents?: Parameters<typeof mountSidebar>[3];
  } = {},
) {
  const gateway = catalogGateway(client, options.snapshot);
  const mounted = await mountSidebar(
    gateway.gateway,
    options.sessions ?? createSessions("main", ["agent:main:main"]),
    "panel",
    options.agents,
  );
  await startCatalog(mounted.sidebar);
  return { ...mounted, gateway };
}

export function agentList(
  agents: AgentsListResult["agents"],
  defaultId = "main",
): AgentsListResult {
  return { defaultId, mainKey: "main", scope: "per-sender", agents };
}

export function questionRequest(
  id: string,
  sessionKey: string,
  overrides: Partial<QuestionRequestedEvent> = {},
): QuestionRequestedEvent {
  return {
    id,
    sessionKey,
    agentId: "main",
    questions: [{ questionId: "confirm", header: "Confirm", question: "Continue?", options: [] }],
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000,
    status: "pending",
    ...overrides,
  };
}

export function confirmQuestion(
  options: QuestionRequestedEvent["questions"][number]["options"] = [],
) {
  return { questionId: "confirm", header: "Confirm", question: "Continue?", options };
}

export function approvalRequest(
  sessionKey: string,
  overrides: Partial<ExecApprovalRequest> = {},
): ExecApprovalRequest {
  return {
    id: "approval-1",
    kind: "exec",
    request: { command: "git status", sessionKey },
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000,
    ...overrides,
  };
}

export function attentionLabel(root: ParentNode | null | undefined, kind?: string) {
  return root
    ?.querySelector(kind ? `[data-session-attention="${kind}"]` : "[data-session-attention]")
    ?.getAttribute("aria-label");
}
