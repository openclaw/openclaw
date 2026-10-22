import { expect, vi } from "vitest";
import type { QuestionRequestedEvent } from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsListResult, GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { ExecApprovalRequest } from "../../app/exec-approval.ts";
import {
  createGatewayHarness,
  createSessions,
  mountSidebar,
  type SidebarLifecycleState,
} from "../app-sidebar.ts";
import { waitForFast } from "../wait-for.ts";

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

export async function settleCatalog(sidebar: SidebarLifecycleState, elapsedMs = 0) {
  await vi.advanceTimersByTimeAsync(elapsedMs);
  await sidebar.updateComplete;
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

export const agentList = (
  agents: AgentsListResult["agents"],
  defaultId = "main",
): AgentsListResult => ({ defaultId, mainKey: "main", scope: "per-sender", agents });

export function publishQuestion(
  gateway: ReturnType<typeof createGatewayHarness>,
  id: string,
  sessionKey: string,
  overrides: Partial<QuestionRequestedEvent> = {},
) {
  gateway.publishEvent("question.requested", {
    id,
    sessionKey,
    agentId: "main",
    questions: [confirmQuestion()],
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000,
    status: "pending",
    ...overrides,
  } satisfies QuestionRequestedEvent);
}

export const confirmQuestion = (
  options: QuestionRequestedEvent["questions"][number]["options"] = [],
  question = "Continue?",
) => ({ questionId: "confirm", header: "Confirm", question, options });

export const approvalRequest = (
  sessionKey: string,
  overrides: Partial<ExecApprovalRequest> = {},
): ExecApprovalRequest => ({
  id: "approval-1",
  kind: "exec",
  request: { command: "git status", sessionKey },
  createdAtMs: Date.now(),
  expiresAtMs: Date.now() + 60_000,
  ...overrides,
});

export function attentionLabel(root: ParentNode | null | undefined, kind?: string) {
  return root
    ?.querySelector(kind ? `[data-session-attention="${kind}"]` : "[data-session-attention]")
    ?.getAttribute("aria-label");
}

export const sessionList = (sessions: GatewaySessionRow[], ts = 2): SessionsListResult => ({
  ts,
  path: "",
  count: sessions.length,
  defaults: { modelProvider: null, model: null, contextTokens: null },
  sessions,
});

export function expectAttention(
  root: () => ParentNode | null | undefined,
  label: string,
  kind?: string,
  options?: Parameters<typeof waitForFast>[1],
) {
  return waitForFast(() => expect(attentionLabel(root(), kind)).toBe(label), options);
}
