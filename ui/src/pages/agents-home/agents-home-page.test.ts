/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { GatewayEventListener } from "../../api/gateway.ts";
import type {
  AgentIdentityResult,
  AgentsListResult,
  GatewaySessionRow,
  SessionsListResult,
} from "../../api/types.ts";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { createAgentIdentityCapability } from "../../lib/agents/identity.ts";
import { createAgentCapability } from "../../lib/agents/index.ts";
import { createSessionCapability } from "../../lib/sessions/index.ts";
import { createContext } from "../../test-helpers/app-sidebar.ts";
import {
  createApplicationContextProvider,
  createApplicationGateway,
} from "../../test-helpers/application-context.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import type { ClawLifecyclePlan, ClawRemoveResult } from "../agents/claw-lifecycle-client.ts";
import { AgentsHomePage } from "./agents-home-page.ts";
import type { ClawCatalogEntry, ClawStatusRecord } from "./claws-catalog-client.ts";
import { ClawsExplore } from "./claws-explore.ts";
import { pluginAcknowledgements, type ClawPluginReview } from "./claws-plugin-review.ts";

const elementName = `test-agents-home-${crypto.randomUUID()}`;
customElements.define(elementName, class extends AgentsHomePage {});

const roster: AgentsListResult = {
  defaultId: "harbor",
  mainKey: "team-room",
  scope: "per-sender",
  agents: [
    { id: "harbor", name: "Harbor", identity: { theme: "Keeps the team organized", emoji: "⚓" } },
    {
      id: "ember",
      identity: { theme: "Builds small tools" },
      model: { primary: "example/model-small" },
    },
    { id: "system", kind: "system", name: "System helper" },
  ],
};

const workflowOperator = {
  packageName: "@openclaw/workflow-operator",
  displayName: "Workflow Operator",
  summary: "Runs approved work across your tools.",
  latestVersion: "1.2.0",
  channel: "official",
  official: true,
  downloads: 12,
  updatedAtMs: 1_000,
} as const;

const workflowPluginReview: ClawPluginReview = {
  actionId: "plugin:@openclaw/workflow-tools",
  pluginId: "workflow-tools",
  ref: "@openclaw/workflow-tools",
  version: "1.2.0",
  ownerAction: "install",
  integrity: `sha256-${"A".repeat(43)}=`,
  declaredCapabilities: {
    channels: [],
    providers: [],
    tools: ["workflow.start"],
    contracts: [],
    hooks: [],
    mcpServers: [],
    cliCommands: [],
    cliBackends: [],
    skills: [],
    dangerousConfigFlags: [],
  },
  capabilityGrants: {
    hooks: {
      allowPromptInjection: { effective: false },
      allowConversationAccess: { effective: true, configured: true },
    },
  },
  reviewToken: "review-workflow-tools",
};

const reviewedAccess = {
  coverage: "configuration-only",
  desired: {
    tools: {
      allowed: ["read", "sessions_spawn"],
      excluded: ["exec"],
      explicitAllow: ["read", "sessions_spawn"],
      explicitDeny: [],
    },
    sandbox: { mode: "all", scope: "agent", workspaceAccess: "ro", backend: "docker" },
    filesystem: { workspaceOnly: true },
    heartbeat: { enabled: false, intervalMs: null },
    memorySearch: { state: "disabled" },
    subagentTargets: {
      allowedAgentIds: ["workflow"],
      allowAnyConfiguredAgent: false,
      implicitSelfAllowed: true,
      requireAgentId: false,
    },
  },
  unresolved: ["runtime-tools", "sandbox-runtime", "memory-runtime", "scheduler-runtime"],
} as const;

const orphanedClaw: ClawStatusRecord = {
  agentId: "orphan-worker",
  name: "@openclaw/orphan-worker",
  version: "1.0.0",
  sourceKind: "package",
  status: "partial",
  agentState: "missing",
  bootstrapState: "missing",
  orphaned: true,
  addedAtMs: 1_000,
  updatedAtMs: 2_000,
  resources: [{ kind: "plugin", id: "audit@2.0.0", state: "missing" }],
};

const orphanRemovePlan: ClawLifecyclePlan = {
  schemaVersion: "openclaw.clawsGatewayPlan.v1",
  operation: "remove",
  planIntegrity: "sha256:orphan-remove-plan",
  target: {
    agentId: "orphan-worker",
    name: orphanedClaw.name,
    currentVersion: orphanedClaw.version,
  },
  actions: [
    {
      kind: "packageRef",
      id: "plugin:audit@2.0.0",
      action: "release",
      blocked: false,
      effect: {
        type: "ownership",
        relationship: "managed",
        origin: "claw-introduced",
        independentOwner: false,
        affectedClawCount: 1,
      },
    },
  ],
  capabilities: [],
  blockers: [],
  pluginReviews: [],
  skillReviews: [],
  riskAcknowledgementRequired: false,
  scheduledJobs: { coverage: "package-declarations", jobs: [] },
};

function createPage(
  options: {
    clawsEnabled?: boolean;
    roster?: AgentsListResult;
    statusRecords?: ClawStatusRecord[];
    removePlan?: ClawLifecyclePlan;
    removeApplyResult?: ClawRemoveResult;
    removeApplyError?: boolean;
    removeAppliedBeforeError?: boolean;
    applyResult?: {
      agentId: string;
      status: string;
      readiness: { ready: boolean; requirements?: Array<{ kind: string; owner: string }> };
      error?: { code: string; message: string };
    };
    applyError?: boolean;
    applyRejectedOnce?: boolean;
    statusRecord?: {
      agentId: string;
      version: string;
      status: string;
      agentState?: string;
      name?: string;
      sourceKind?: "package" | "development";
    };
    newAgentVisible?: boolean;
    pluginRiskWarning?: string;
    skillRiskWarning?: string;
    reusePlugin?: boolean;
    missingPluginReview?: boolean;
    missingDisclosure?: boolean;
    malformedDisclosure?: boolean;
    rosterErrorAfterAdd?: boolean;
    statusErrorAfterAdd?: boolean;
    catalogSearch?: (query: string) => Promise<{ entries: ClawCatalogEntry[] }>;
  } = {},
) {
  let clawsEnabled = options.clawsEnabled ?? false;
  let addedAgent = false;
  let rejectedApply = false;
  let currentRoster = options.roster ?? roster;
  let statusRecords = options.statusRecords ?? [];
  const runtimeConfigListeners = new Set<() => void>();
  const runtimeConfig = {
    state: {
      configSnapshot: {
        sourceConfig: { gateway: { controlUi: { experimental: { claws: clawsEnabled } } } },
      },
    },
    ensureLoaded: async () => undefined,
    subscribe: (listener: () => void) => {
      runtimeConfigListeners.add(listener);
      return () => runtimeConfigListeners.delete(listener);
    },
  };
  let sessions: GatewaySessionRow[] = [
    {
      key: "agent:harbor:team-room",
      agentId: "harbor",
      kind: "direct",
      isMain: true,
      updatedAt: 5_000,
      lastMessagePreview: "The schedule is ready.",
    },
    {
      key: "agent:ember:team-room",
      agentId: "ember",
      kind: "direct",
      isMain: true,
      updatedAt: 1_000,
      lastMessagePreview: "The main chat summary.",
    },
    {
      key: "agent:ember:side-task",
      agentId: "ember",
      kind: "direct",
      updatedAt: 2_000,
      lastMessagePreview: "A newer side-task message.",
      hasActiveRun: true,
    },
  ];
  const request = createGatewayRequestMock(async (method, params) => {
    if (method === "agents.list") {
      if (addedAgent && options.rosterErrorAfterAdd) {
        throw new Error("Roster unavailable");
      }
      return addedAgent && options.newAgentVisible !== false
        ? { ...currentRoster, agents: [...currentRoster.agents, { id: "workflow-operator" }] }
        : currentRoster;
    }
    if (method === "agent.identity.get") {
      const agentId =
        params && typeof params === "object" && "agentId" in params ? String(params.agentId) : "";
      return {
        agentId,
        name: agentId === "ember" ? "Ember" : "Harbor",
        avatar: "",
        emoji: agentId === "harbor" ? "⚓" : "",
      } satisfies AgentIdentityResult;
    }
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    if (method === "sessions.list") {
      const offset =
        params && typeof params === "object" && "offset" in params ? Number(params.offset) : 0;
      const limit =
        params && typeof params === "object" && "limit" in params ? Number(params.limit) : 300;
      const rows = sessions.slice(offset, offset + limit);
      return {
        ts: 6_000,
        path: "",
        count: rows.length,
        sessions: rows,
        defaults: { model: null, modelProvider: null, contextTokens: null },
        hasMore: offset + rows.length < sessions.length,
        nextOffset: offset + rows.length,
      } satisfies SessionsListResult;
    }
    if (method === "claws.catalog.search") {
      const query =
        params && typeof params === "object" && "query" in params
          ? String(params.query).trim().toLowerCase()
          : "";
      if (options.catalogSearch) {
        return options.catalogSearch(query);
      }
      return {
        entries:
          query && !workflowOperator.displayName.toLowerCase().includes(query)
            ? []
            : [workflowOperator],
      };
    }
    if (method === "claws.catalog.detail") {
      return {
        detail: {
          ...workflowOperator,
          version: "1.2.0",
          agentName: "Workflow Operator",
          workspaceFiles: 3,
          skills: 1,
          plugins: 1,
          mcpServers: 0,
          scheduledJobs: 0,
        },
      };
    }
    if (method === "claws.add.plan") {
      return {
        schemaVersion: "openclaw.clawsGatewayPlan.v1",
        operation: "add",
        planIntegrity: "sha256:reviewed-plan",
        target: { agentId: "workflow-operator", name: "Workflow Operator", targetVersion: "1.2.0" },
        actions: [
          {
            kind: "agent",
            id: "workflow-operator",
            action: "create",
            blocked: false,
          },
          { kind: "workspace", id: "workflow-operator", action: "create", blocked: false },
          {
            kind: "package",
            id: "plugin:@openclaw/workflow-tools",
            action: "install",
            blocked: false,
          },
        ],
        capabilities: [
          {
            kind: "package",
            id: "plugin:@openclaw/workflow-tools",
            action: "install",
            reason: "The Claw requires downloadable package content or executable code.",
          },
        ],
        blockers: [],
        skillReviews: options.skillRiskWarning
          ? [
              {
                actionId: "skill:@community/triage",
                ref: "@community/triage",
                version: "1.0.0",
                integrity: "sha256:reviewed-skill",
                riskWarning: options.skillRiskWarning,
                reviewToken: "sha256:skill-review",
              },
            ]
          : [],
        ...(options.missingPluginReview
          ? {}
          : {
              pluginReviews: [
                {
                  ...workflowPluginReview,
                  ownerAction: options.reusePlugin ? "reuse" : "install",
                  ...(options.pluginRiskWarning ? { riskWarning: options.pluginRiskWarning } : {}),
                },
              ],
            }),
        riskAcknowledgementRequired: false,
        ...(options.missingDisclosure
          ? {}
          : {
              configuredAccess: options.malformedDisclosure
                ? { ...reviewedAccess, desired: {} }
                : reviewedAccess,
              scheduledJobs: { coverage: "package-declarations", jobs: [] },
            }),
        readiness: { ready: true, requirements: [] },
      };
    }
    if (method === "claws.add.apply") {
      if (options.applyRejectedOnce && !rejectedApply) {
        rejectedApply = true;
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "The Claw changed since review. Preview it again.",
        });
      }
      addedAgent = !options.applyError || Boolean(options.statusRecord);
      if (options.applyError) {
        throw new Error("Gateway reply timed out");
      }
      return (
        options.applyResult ?? {
          agentId: "workflow-operator",
          status: "complete",
          readiness: { ready: true },
        }
      );
    }
    if (method === "claws.status") {
      if (addedAgent && options.statusErrorAfterAdd) {
        throw new Error("Status unavailable");
      }
      const addedRecord = options.statusRecord
        ? {
            name: "@openclaw/workflow-operator",
            sourceKind: "package",
            agentState: "present",
            ...options.statusRecord,
          }
        : addedAgent
          ? {
              agentId: "workflow-operator",
              name: "@openclaw/workflow-operator",
              version: "1.2.0",
              sourceKind: "package",
              status: options.applyResult?.status ?? "complete",
              agentState: "present",
            }
          : null;
      const records = addedRecord ? [...statusRecords, addedRecord] : statusRecords;
      const target =
        params && typeof params === "object" && "target" in params ? String(params.target) : null;
      return {
        records: target ? records.filter((record) => record.agentId === target) : records,
      };
    }
    if (method === "claws.remove.plan" && options.removePlan) {
      return options.removePlan;
    }
    if (method === "claws.remove.apply" && options.removeApplyError) {
      if (options.removeAppliedBeforeError) {
        statusRecords = [];
      }
      throw new Error("Gateway reply timed out");
    }
    if (method === "claws.remove.apply" && options.removeApplyResult) {
      if (options.removeApplyResult.status === "complete") {
        statusRecords = statusRecords.filter(
          (record) => record.agentId !== options.removeApplyResult?.agentId,
        );
      }
      return options.removeApplyResult;
    }
    throw new Error(`Unexpected RPC: ${method}`);
  });
  const client = createTestGatewayClient(request);
  const source = createApplicationGateway({
    client,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: gatewayHelloForMethods(
      [
        "openclaw.chat",
        "claws.catalog.search",
        "claws.catalog.detail",
        "claws.add.plan",
        "claws.add.apply",
        "claws.status",
        "claws.remove.plan",
        "claws.remove.apply",
      ],
      ["operator.read", "operator.admin"],
    ),
    assistantAgentId: "harbor",
    sessionKey: "agent:harbor:team-room",
    lastError: null,
    lastErrorCode: null,
  });
  source.gateway.setSessionKey = vi.fn((sessionKey: string) => {
    source.publish({ ...source.gateway.snapshot, sessionKey });
  });
  const eventListeners = new Set<GatewayEventListener>();
  source.gateway.subscribeEvents = (listener) => {
    eventListeners.add(listener);
    return () => eventListeners.delete(listener);
  };
  const agents = createAgentCapability(source.gateway);
  const agentSelection = createAgentSelectionCapability(source.gateway, agents);
  const agentIdentity = createAgentIdentityCapability(source.gateway);
  const sessionCapability = createSessionCapability(source.gateway, agentSelection);
  const navigate = vi.fn<ApplicationContext["navigate"]>();
  const context = {
    ...createContext(source.gateway, sessionCapability, currentRoster, [], agentIdentity),
    basePath: "",
    gateway: source.gateway,
    agents,
    agentIdentity,
    agentSelection,
    sessions: sessionCapability,
    runtimeConfig: runtimeConfig as unknown as ApplicationContext["runtimeConfig"],
    navigate,
  };
  const baselineEventListeners = eventListeners.size;
  const provider = createApplicationContextProvider(context);
  const page = new (customElements.get(elementName) ?? AgentsHomePage)();
  provider.append(page);
  document.body.append(provider);
  disposers.push(() => {
    agentSelection.dispose();
    agents.dispose();
    sessionCapability.dispose();
  });
  return {
    page,
    provider,
    rosterListenerCount: () => eventListeners.size - baselineEventListeners,
    request,
    navigate,
    agentSelection,
    gateway: source.gateway,
    updateSessions: (next: GatewaySessionRow[]) => {
      sessions = next;
    },
    setStatusRecords: (next: ClawStatusRecord[]) => {
      statusRecords = next;
    },
    setRoster: async (next: AgentsListResult) => {
      currentRoster = next;
      await agents.refreshList();
    },
    emitChange: () => {
      for (const listener of eventListeners) {
        listener({ type: "event", event: "sessions.changed", payload: {} });
      }
    },
    setPhase: (phase: ApplicationGatewaySnapshot["phase"]) => {
      source.publish({ ...source.gateway.snapshot, phase });
    },
    setClawsEnabled: (enabled: boolean) => {
      clawsEnabled = enabled;
      runtimeConfig.state.configSnapshot.sourceConfig.gateway.controlUi.experimental.claws =
        clawsEnabled;
      for (const listener of runtimeConfigListeners) {
        listener();
      }
    },
  };
}

const disposers: (() => void)[] = [];
beforeEach(async () => {
  await i18n.setLocale("en");
});
afterEach(() => {
  document.body.replaceChildren();
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
  vi.useRealTimers();
});

describe("AgentsHomePage", () => {
  it("shows an unrepresented installed Claw on an empty roster with Labs off and opens its lifecycle panel", async () => {
    const { page, request, navigate } = createPage({
      roster: { ...roster, agents: [] },
      statusRecords: [orphanedClaw],
      removePlan: orphanRemovePlan,
    });

    await vi.waitFor(() =>
      expect(page.querySelector('[data-claw-unrepresented="orphan-worker"]')).not.toBeNull(),
    );
    expect(request).toHaveBeenCalledWith("claws.status", {});
    expect(page.querySelectorAll(".agents-home__card")).toHaveLength(0);
    expect(page.querySelector(".agents-home__empty")).toBeNull();
    expect(page.querySelector("[data-claws-explore]")).toBeNull();
    const row = page.querySelector<HTMLElement>('[data-claw-unrepresented="orphan-worker"]');
    expect(row?.textContent).toContain("@openclaw/orphan-worker");
    expect(row?.textContent).toContain("Partial");
    expect(row?.querySelector("a[href*='chat']")).toBeNull();
    expect(navigate).not.toHaveBeenCalled();

    row?.querySelector<HTMLButtonElement>("[data-claw-inspect]")?.click();
    await vi.waitFor(() =>
      expect(page.querySelector("openclaw-agent-claw-panel")?.textContent).toContain("audit@2.0.0"),
    );
    expect(request).toHaveBeenCalledWith("claws.status", { target: "orphan-worker" });
    expect(page.querySelector("[data-claw-update]")).toBeNull();
    expect(
      page.querySelector("openclaw-agent-claw-panel .settings-row .btn.danger"),
    ).not.toBeNull();
  });

  it("discovers an orphan installed outside the UI when Agents regains focus", async () => {
    const { page, request, setStatusRecords } = createPage({
      roster: { ...roster, agents: [] },
      statusRecords: [],
    });
    await vi.waitFor(() => expect(page.querySelector(".agents-home__empty")).not.toBeNull());
    expect(page.querySelector("[data-claws-attention]")).toBeNull();

    setStatusRecords([orphanedClaw]);
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() =>
      expect(page.querySelector('[data-claw-unrepresented="orphan-worker"]')).not.toBeNull(),
    );
    expect(request.mock.calls.filter(([method]) => method === "claws.status")).toHaveLength(2);
  });

  it("closes an idle inspector when its Claw gains a roster card", async () => {
    const { page, setRoster } = createPage({
      roster: { ...roster, agents: [] },
      statusRecords: [orphanedClaw],
    });
    await vi.waitFor(() =>
      expect(page.querySelector('[data-claw-unrepresented="orphan-worker"]')).not.toBeNull(),
    );
    page.querySelector<HTMLButtonElement>("[data-claw-inspect]")?.click();
    await vi.waitFor(() =>
      expect(page.querySelector("openclaw-agent-claw-panel")?.textContent).toContain("audit@2.0.0"),
    );

    await setRoster({ ...roster, agents: [{ id: "orphan-worker" }] });
    await vi.waitFor(() =>
      expect(page.querySelector('[data-agent-id="orphan-worker"]')).not.toBeNull(),
    );
    await vi.waitFor(() => expect(page.querySelector("[data-claws-attention]")).toBeNull());
    expect(page.querySelector("openclaw-agent-claw-panel")).toBeNull();
  });

  it("removes an orphaned Claw through the reviewed plan without claiming its absent agent was removed", async () => {
    const { page, request, navigate } = createPage({
      roster: { ...roster, agents: [] },
      statusRecords: [orphanedClaw],
      removePlan: orphanRemovePlan,
      removeApplyResult: {
        agentId: "orphan-worker",
        status: "complete",
        agentRemoved: false,
      },
    });
    await vi.waitFor(() =>
      expect(page.querySelector('[data-claw-unrepresented="orphan-worker"]')).not.toBeNull(),
    );
    page.querySelector<HTMLButtonElement>("[data-claw-inspect]")?.click();
    await vi.waitFor(() =>
      expect(page.querySelector("openclaw-agent-claw-panel")?.textContent).toContain("audit@2.0.0"),
    );
    page
      .querySelector<HTMLButtonElement>("openclaw-agent-claw-panel .settings-row .btn.danger")
      ?.click();
    await vi.waitFor(() =>
      expect(page.querySelector<HTMLButtonElement>("[data-claw-remove-confirm]")?.disabled).toBe(
        false,
      ),
    );
    expect(request).toHaveBeenCalledWith("claws.remove.plan", { agentId: "orphan-worker" });
    expect(page.textContent).toContain("plugin:audit@2.0.0");
    expect(request).not.toHaveBeenCalledWith("claws.remove.apply", expect.anything());

    page.querySelector<HTMLButtonElement>("[data-claw-remove-confirm]")?.click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("claws.remove.apply", {
        agentId: "orphan-worker",
        planIntegrity: "sha256:orphan-remove-plan",
      }),
    );
    await vi.waitFor(() =>
      expect(page.querySelector('[data-claw-unrepresented="orphan-worker"]')).toBeNull(),
    );
    expect(page.querySelector("openclaw-agent-claw-panel")).toBeNull();
    expect(page.textContent).toContain("Claw removed");
    expect(page.textContent).not.toContain("Removal incomplete");
    expect(request.mock.calls.filter(([method]) => method === "claws.remove.apply")).toHaveLength(
      1,
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it("shows only Claws without roster cards and replaces their status after reconnect", async () => {
    const representedClaw: ClawStatusRecord = {
      ...orphanedClaw,
      agentId: "harbor",
      name: "@openclaw/harbor",
      status: "complete",
      agentState: "present",
      bootstrapState: "complete",
      orphaned: false,
    };
    const { page, request, setPhase, setStatusRecords } = createPage({
      statusRecords: [representedClaw, orphanedClaw],
    });
    await vi.waitFor(() =>
      expect(page.querySelector('[data-claw-unrepresented="orphan-worker"]')).not.toBeNull(),
    );
    expect(page.querySelector('[data-claw-unrepresented="harbor"]')).toBeNull();
    expect(page.querySelectorAll(".agents-home__card")).toHaveLength(2);
    page.querySelector<HTMLButtonElement>("[data-claw-inspect]")?.click();
    await vi.waitFor(() =>
      expect(page.querySelector("openclaw-agent-claw-panel")?.textContent).toContain("audit@2.0.0"),
    );

    setPhase("reconnecting");
    await vi.waitFor(() =>
      expect(page.querySelector('[data-claw-unrepresented="orphan-worker"]')).toBeNull(),
    );
    setStatusRecords([representedClaw]);
    setPhase("connected");
    await vi.waitFor(() =>
      expect(
        request.mock.calls.filter(
          ([method, params]) => method === "claws.status" && !Object.hasOwn(params ?? {}, "target"),
        ),
      ).toHaveLength(2),
    );
    await vi.waitFor(() => expect(page.querySelector("[data-claws-attention]")).toBeNull());
  });

  it("reconciles timed-out orphan removal from status without applying it twice", async () => {
    const { page, request, navigate } = createPage({
      roster: { ...roster, agents: [] },
      statusRecords: [orphanedClaw],
      removePlan: orphanRemovePlan,
      removeApplyError: true,
      removeAppliedBeforeError: true,
    });
    await vi.waitFor(() =>
      expect(page.querySelector('[data-claw-unrepresented="orphan-worker"]')).not.toBeNull(),
    );
    page.querySelector<HTMLButtonElement>("[data-claw-inspect]")?.click();
    await vi.waitFor(() =>
      expect(page.querySelector("openclaw-agent-claw-panel")?.textContent).toContain("audit@2.0.0"),
    );
    page
      .querySelector<HTMLButtonElement>("openclaw-agent-claw-panel .settings-row .btn.danger")
      ?.click();
    await vi.waitFor(() =>
      expect(page.querySelector<HTMLButtonElement>("[data-claw-remove-confirm]")?.disabled).toBe(
        false,
      ),
    );
    page.querySelector<HTMLButtonElement>("[data-claw-remove-confirm]")?.click();

    await vi.waitFor(() => expect(page.textContent).toContain("Claw removed"));
    expect(page.querySelector('[data-claw-unrepresented="orphan-worker"]')).toBeNull();
    expect(request).toHaveBeenCalledWith("claws.status", { target: "orphan-worker" });
    expect(request.mock.calls.filter(([method]) => method === "claws.remove.apply")).toHaveLength(
      1,
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it("keeps an ambiguous orphan removal inspector mounted until status confirms cleanup", async () => {
    const { page, request, setRoster, setStatusRecords } = createPage({
      roster: { ...roster, agents: [] },
      statusRecords: [orphanedClaw],
      removePlan: orphanRemovePlan,
      removeApplyError: true,
    });
    await vi.waitFor(() =>
      expect(page.querySelector('[data-claw-unrepresented="orphan-worker"]')).not.toBeNull(),
    );
    page.querySelector<HTMLButtonElement>("[data-claw-inspect]")?.click();
    await vi.waitFor(() =>
      expect(page.querySelector("openclaw-agent-claw-panel")?.textContent).toContain("audit@2.0.0"),
    );
    page
      .querySelector<HTMLButtonElement>("openclaw-agent-claw-panel .settings-row .btn.danger")
      ?.click();
    await vi.waitFor(() =>
      expect(page.querySelector<HTMLButtonElement>("[data-claw-remove-confirm]")?.disabled).toBe(
        false,
      ),
    );
    page.querySelector<HTMLButtonElement>("[data-claw-remove-confirm]")?.click();
    await vi.waitFor(() => expect(page.textContent).toContain("Removal outcome unknown"));
    page.querySelector<HTMLButtonElement>(".claw-lifecycle-dialog__footer .btn")?.click();
    await vi.waitFor(() => expect(page.querySelector(".claw-lifecycle-dialog")).toBeNull());

    const inspect = page.querySelector<HTMLButtonElement>("[data-claw-inspect]");
    expect(inspect?.disabled).toBe(true);
    inspect?.click();
    expect(page.querySelector("openclaw-agent-claw-panel")).not.toBeNull();

    await setRoster({ ...roster, agents: [{ id: "orphan-worker" }] });
    await vi.waitFor(() =>
      expect(page.querySelector('[data-agent-id="orphan-worker"]')).not.toBeNull(),
    );
    expect(page.querySelector("openclaw-agent-claw-panel")).not.toBeNull();

    setStatusRecords([]);
    page
      .querySelector<HTMLButtonElement>("openclaw-agent-claw-panel .callout.warn button")
      ?.click();
    await vi.waitFor(() => expect(page.textContent).toContain("Claw removed"));
    expect(page.querySelector('[data-claw-unrepresented="orphan-worker"]')).toBeNull();
    expect(request.mock.calls.filter(([method]) => method === "claws.remove.apply")).toHaveLength(
      1,
    );
  });

  it("shows official Explore cards and search beside the installed roster only with Labs on", async () => {
    const { page, request, setClawsEnabled } = createPage();
    await vi.waitFor(() => expect(page.querySelectorAll(".agents-home__card")).toHaveLength(2));
    expect(page.querySelector("[data-claws-explore]")).toBeNull();
    expect(page.querySelector("[data-claws-open-catalog]")).toBeNull();
    expect(request.mock.calls.some(([method]) => method === "claws.catalog.search")).toBe(false);

    setClawsEnabled(true);
    await vi.waitFor(() => expect(page.querySelectorAll("[data-claws-entry]")).toHaveLength(1));
    expect(page.querySelector("[data-claws-open-catalog]")).not.toBeNull();
    expect(page.querySelector("openclaw-claws-catalog-dialog")).toBeNull();
    expect(page.querySelector("[data-claws-explore]")?.textContent).toContain("Explore Claws");
    expect(page.querySelector("[data-claws-entry]")?.textContent).toContain("Workflow Operator");
    expect(page.querySelector("[data-claws-entry]")?.textContent).toContain("Runs approved work");
    expect(page.querySelector("[data-claws-entry]")?.textContent).toContain("Version 1.2.0");
    expect(page.querySelector("[data-claws-entry]")?.textContent).toContain("12 downloads");
    expect(request).toHaveBeenCalledWith("claws.catalog.search", {});

    const search = page.querySelector<HTMLInputElement>("[data-claws-search]");
    expect(search).not.toBeNull();
    search!.value = "no match";
    search!.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("claws.catalog.search", { query: "no match" }),
    );
    await vi.waitFor(() => expect(page.querySelectorAll("[data-claws-entry]")).toHaveLength(0));
    expect(page.querySelector("[data-claws-explore]")?.textContent).toContain("No Claws found");
    search!.value = "workflow";
    search!.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("claws.catalog.search", { query: "workflow" }),
    );
    await vi.waitFor(() => expect(page.querySelectorAll("[data-claws-entry]")).toHaveLength(1));
    page.querySelector<HTMLElement>("[data-claws-entry] button")?.click();
    await vi.waitFor(() => expect(page.querySelector("[data-claws-confirm]")).not.toBeNull());
    expect(page.querySelector(".claws-catalog__list")).toBeNull();
    setClawsEnabled(false);
    await vi.waitFor(() => expect(page.querySelector("[data-claws-explore]")).toBeNull());
    expect(page.querySelector("[data-claws-open-catalog]")).toBeNull();
    expect(page.querySelector("[data-claws-confirm]")).toBeNull();
    expect(page.querySelectorAll(".agents-home__card")).toHaveLength(2);
    setClawsEnabled(true);
    await vi.waitFor(() => expect(page.querySelectorAll("[data-claws-entry]")).toHaveLength(1));
    expect(page.querySelector("openclaw-claws-catalog-dialog")).toBeNull();
  });

  it("opens the searchable catalog from the header and keeps the installed roster", async () => {
    const { page, request } = createPage({ clawsEnabled: true });
    await vi.waitFor(() => expect(page.querySelectorAll("[data-claws-entry]")).toHaveLength(1));
    const trigger = page.querySelector<HTMLButtonElement>("[data-claws-open-catalog]");
    expect(trigger?.getAttribute("aria-label")).toBe("Search Claws");
    expect(trigger?.getAttribute("aria-haspopup")).toBe("dialog");
    trigger?.click();

    await vi.waitFor(() => expect(page.querySelector(".claws-catalog__list")).not.toBeNull());
    expect(page.querySelectorAll(".agents-home__card")).toHaveLength(2);
    const search = page.querySelector<HTMLInputElement>(
      "openclaw-claws-catalog-dialog [data-claws-search]",
    );
    expect(search?.hasAttribute("autofocus")).toBe(true);
    search!.value = "workflow";
    search!.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("claws.catalog.search", { query: "workflow" }),
    );
    page.querySelector<HTMLElement>(".claws-catalog__close")?.click();
    await vi.waitFor(() => expect(page.querySelector("openclaw-claws-catalog-dialog")).toBeNull());
    expect(page.querySelectorAll("[data-claws-entry]")).toHaveLength(1);
  });

  it("returns from a selected review to the inline Explore cards", async () => {
    const { page, request } = createPage({ clawsEnabled: true });
    await vi.waitFor(() => expect(page.querySelector("[data-claws-entry] button")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-entry] button")?.click();
    await vi.waitFor(() => expect(page.querySelector("[data-claws-confirm]")).not.toBeNull());
    expect(page.querySelector(".claws-catalog__list")).toBeNull();
    page.querySelector<HTMLElement>(".claws-catalog__back")?.click();
    await vi.waitFor(() => expect(page.querySelector("openclaw-claws-catalog-dialog")).toBeNull());
    expect(page.querySelectorAll("[data-claws-entry]")).toHaveLength(1);
    expect(page.querySelectorAll(".agents-home__card")).toHaveLength(2);
    expect(request.mock.calls.filter(([method]) => method === "claws.catalog.search")).toHaveLength(
      1,
    );
  });

  it("does not replace a newer search with an older catalog response", async () => {
    const loads = vi.spyOn(
      ClawsExplore.prototype as unknown as { loadCatalog: () => Promise<void> },
      "loadCatalog",
    );
    let resolveInitial!: (value: { entries: ClawCatalogEntry[] }) => void;
    const initialSearch = new Promise<{ entries: ClawCatalogEntry[] }>((resolve) => {
      resolveInitial = resolve;
    });
    try {
      const { page, request } = createPage({
        clawsEnabled: true,
        catalogSearch: (query) =>
          query ? Promise.resolve({ entries: [workflowOperator] }) : initialSearch,
      });
      await vi.waitFor(() => expect(request).toHaveBeenCalledWith("claws.catalog.search", {}));
      const initialLoad = loads.mock.results[0]?.value;
      expect(initialLoad).toBeDefined();
      const search = page.querySelector<HTMLInputElement>("[data-claws-search]");
      expect(search).not.toBeNull();
      search!.value = "workflow";
      search!.dispatchEvent(new Event("input", { bubbles: true }));
      await vi.waitFor(() => expect(page.querySelectorAll("[data-claws-entry]")).toHaveLength(1));
      resolveInitial({ entries: [{ ...workflowOperator, displayName: "Stale result" }] });
      await initialLoad;
      await page.querySelector<ClawsExplore>("openclaw-claws-explore")?.updateComplete;
      expect(page.querySelector("[data-claws-entry]")?.textContent).toContain("Workflow Operator");
      expect(page.textContent).not.toContain("Stale result");
    } finally {
      loads.mockRestore();
    }
  });

  it("reviews a plugin-bearing Claw before Add and opens its home chat when ready", async () => {
    const { page, request, navigate, agentSelection, gateway } = createPage({
      clawsEnabled: true,
    });
    await vi.waitFor(() => expect(page.querySelector("[data-claws-explore]")).not.toBeNull());
    await vi.waitFor(() => expect(page.querySelector("[data-claws-entry] ")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-entry] button")?.click();
    await vi.waitFor(() => expect(page.textContent).toContain("workflow-tools"));
    expect(page.textContent).toContain("create workspace");
    expect(page.textContent).toContain("install package");
    expect(page.textContent).toContain("workflow.start");
    expect(page.textContent).toContain(workflowPluginReview.integrity);
    expect(page.textContent).toContain("Conversation access");
    expect(page.textContent).toContain("Allowed");
    expect(page.textContent).toContain("Configured access");
    expect(page.textContent).toContain("sessions_spawn");
    expect(page.textContent).toContain("No scheduled jobs declared");
    expect(request).toHaveBeenCalledWith("claws.catalog.detail", {
      packageName: "@openclaw/workflow-operator",
      version: "1.2.0",
    });
    expect(request).toHaveBeenCalledWith("claws.add.plan", {
      source: { packageName: "@openclaw/workflow-operator", version: "1.2.0" },
    });
    expect(request).not.toHaveBeenCalledWith("claws.add.apply", expect.anything());

    page.querySelector<HTMLElement>("[data-claws-confirm]")?.click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("claws.add.apply", {
        source: { packageName: "@openclaw/workflow-operator", version: "1.2.0" },
        planIntegrity: "sha256:reviewed-plan",
        acknowledgeCapabilities: [
          {
            actionId: "plugin:@openclaw/workflow-tools",
            pluginId: "workflow-tools",
            reviewToken: "review-workflow-tools",
            capabilityGrants: workflowPluginReview.capabilityGrants,
          },
        ],
      }),
    );
    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("chat", { pathname: "/chat/workflow-operator" }),
    );
    expect(agentSelection.state.selectedId).toBe("workflow-operator");
    expect(gateway.setSessionKey).toHaveBeenCalledWith("agent:workflow-operator:team-room");
  });

  it("does not acknowledge a plugin review without artifact integrity", () => {
    expect(
      pluginAcknowledgements([{ ...workflowPluginReview, integrity: "" }], new Set()),
    ).toBeNull();
    expect(
      pluginAcknowledgements(
        [{ ...workflowPluginReview, ownerAction: "reuse", integrity: "" }],
        new Set(),
      ),
    ).toBeNull();
  });

  it("requires explicit acknowledgment of plugin risk before applying the reviewed grant", async () => {
    const { page, request } = createPage({
      clawsEnabled: true,
      pluginRiskWarning: "This plugin can access customer conversations.",
    });
    await vi.waitFor(() => expect(page.querySelector("[data-claws-explore]")).not.toBeNull());
    await vi.waitFor(() => expect(page.querySelector("[data-claws-entry] button")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-entry] button")?.click();
    await vi.waitFor(() => expect(page.textContent).toContain("customer conversations"));
    expect(page.querySelector<HTMLButtonElement>("[data-claws-confirm]")?.disabled).toBe(true);
    page.querySelector<HTMLInputElement>("[data-claw-plugin-risk]")?.click();
    await vi.waitFor(() =>
      expect(page.querySelector<HTMLButtonElement>("[data-claws-confirm]")?.disabled).toBe(false),
    );
    page.querySelector<HTMLElement>("[data-claws-confirm]")?.click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "claws.add.apply",
        expect.objectContaining({
          acknowledgeCapabilities: [
            expect.objectContaining({
              pluginId: "workflow-tools",
              acknowledgeRiskWarning: true,
            }),
          ],
        }),
      ),
    );
  });

  it("requires explicit review of a warned skill before Add", async () => {
    const { page, request } = createPage({
      clawsEnabled: true,
      skillRiskWarning: "This community skill needs review.",
    });
    await vi.waitFor(() => expect(page.querySelector("[data-claws-entry] button")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-entry] button")?.click();
    await vi.waitFor(() =>
      expect(page.textContent).toContain("This community skill needs review."),
    );
    expect(page.querySelector<HTMLButtonElement>("[data-claws-confirm]")?.disabled).toBe(true);
    page.querySelector<HTMLInputElement>("[data-claw-skill-risk]")?.click();
    await vi.waitFor(() =>
      expect(page.querySelector<HTMLButtonElement>("[data-claws-confirm]")?.disabled).toBe(false),
    );
    page.querySelector<HTMLElement>("[data-claws-confirm]")?.click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "claws.add.apply",
        expect.objectContaining({
          acknowledgeSkillWarnings: [
            {
              actionId: "skill:@community/triage",
              ref: "@community/triage",
              reviewToken: "sha256:skill-review",
              acknowledgeRiskWarning: true,
            },
          ],
        }),
      ),
    );
  });

  it("shows a reused plugin without sending installer capability consent", async () => {
    const { page, request } = createPage({ clawsEnabled: true, reusePlugin: true });
    await vi.waitFor(() => expect(page.querySelector("[data-claws-explore]")).not.toBeNull());
    await vi.waitFor(() => expect(page.querySelector("[data-claws-entry] button")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-entry] button")?.click();
    await vi.waitFor(() => expect(page.textContent).toContain("Already installed"));
    page.querySelector<HTMLElement>("[data-claws-confirm]")?.click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("claws.add.apply", {
        source: { packageName: "@openclaw/workflow-operator", version: "1.2.0" },
        planIntegrity: "sha256:reviewed-plan",
      }),
    );
  });

  it("does not offer Add when the Gateway omits the plugin review", async () => {
    const { page, request } = createPage({ clawsEnabled: true, missingPluginReview: true });
    await vi.waitFor(() => expect(page.querySelector("[data-claws-explore]")).not.toBeNull());
    await vi.waitFor(() => expect(page.querySelector("[data-claws-entry] button")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-entry] button")?.click();
    await vi.waitFor(() => expect(page.textContent).toContain("Plugin review is unavailable"));
    expect(page.querySelector<HTMLButtonElement>("[data-claws-confirm]")?.disabled).toBe(true);
    expect(request.mock.calls.some(([method]) => method === "claws.add.apply")).toBe(false);
  });

  it("does not offer Add when configured access or schedule review is missing", async () => {
    const { page, request } = createPage({ clawsEnabled: true, missingDisclosure: true });
    await vi.waitFor(() => expect(page.querySelector("[data-claws-explore]")).not.toBeNull());
    await vi.waitFor(() => expect(page.querySelector("[data-claws-entry] button")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-entry] button")?.click();
    await vi.waitFor(() =>
      expect(page.textContent).toContain("Access or schedule review is unavailable"),
    );
    expect(page.querySelector<HTMLButtonElement>("[data-claws-confirm]")?.disabled).toBe(true);
    expect(request.mock.calls.some(([method]) => method === "claws.add.apply")).toBe(false);
  });

  it("refuses a truncated configured-access review", async () => {
    const { page, request } = createPage({ clawsEnabled: true, malformedDisclosure: true });
    await vi.waitFor(() => expect(page.querySelector("[data-claws-explore]")).not.toBeNull());
    await vi.waitFor(() => expect(page.querySelector("[data-claws-entry] button")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-entry] button")?.click();
    await vi.waitFor(() =>
      expect(page.textContent).toContain("Access or schedule review is unavailable"),
    );
    expect(page.querySelector<HTMLButtonElement>("[data-claws-confirm]")?.disabled).toBe(true);
    expect(request.mock.calls.some(([method]) => method === "claws.add.apply")).toBe(false);
  });

  it("does not reapply a completed Claw while its agent is absent from the refreshed roster", async () => {
    const { page, request, navigate } = createPage({
      clawsEnabled: true,
      newAgentVisible: false,
    });
    await vi.waitFor(() => expect(page.querySelector("[data-claws-explore]")).not.toBeNull());
    await vi.waitFor(() => expect(page.querySelector("[data-claws-entry] button")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-entry] button")?.click();
    await vi.waitFor(() => expect(page.querySelector("[data-claws-confirm]")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-confirm]")?.click();
    await vi.waitFor(() => expect(page.textContent).toContain("Claw added"));
    expect(page.textContent).toContain("Open it from Agents");
    expect(page.querySelector("[data-claws-confirm]")).toBeNull();
    expect(request.mock.calls.filter(([method]) => method === "claws.add.apply")).toHaveLength(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("keeps a known Add result when roster refresh fails", async () => {
    const { page, request, navigate } = createPage({
      clawsEnabled: true,
      rosterErrorAfterAdd: true,
    });
    await vi.waitFor(() => expect(page.querySelector("[data-claws-explore]")).not.toBeNull());
    await vi.waitFor(() => expect(page.querySelector("[data-claws-entry] button")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-entry] button")?.click();
    await vi.waitFor(() => expect(page.querySelector("[data-claws-confirm]")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-confirm]")?.click();
    await vi.waitFor(() => expect(page.textContent).toContain("Claw added"));
    expect(page.textContent).not.toContain("Add outcome unknown");
    expect(request.mock.calls.filter(([method]) => method === "claws.add.apply")).toHaveLength(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("checks status after an ambiguous Add and never offers a second Add", async () => {
    const { page, request, navigate } = createPage({ clawsEnabled: true, applyError: true });
    await vi.waitFor(() => expect(page.querySelector("[data-claws-explore]")).not.toBeNull());
    await vi.waitFor(() => expect(page.querySelector("[data-claws-entry] button")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-entry] button")?.click();
    await vi.waitFor(() => expect(page.querySelector("[data-claws-confirm]")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-confirm]")?.click();
    await vi.waitFor(() => expect(page.textContent).toContain("Add outcome unknown"));
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("claws.status", { target: "workflow-operator" }),
    );
    expect(page.querySelector("[data-claws-confirm]")).toBeNull();
    expect(request.mock.calls.filter(([method]) => method === "claws.add.apply")).toHaveLength(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("replans after a definite Add rejection without treating it as an unknown outcome", async () => {
    const { page, request, navigate } = createPage({
      clawsEnabled: true,
      applyRejectedOnce: true,
    });
    await vi.waitFor(() => expect(page.querySelector("[data-claws-explore]")).not.toBeNull());
    await vi.waitFor(() => expect(page.querySelector("[data-claws-entry] button")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-entry] button")?.click();
    await vi.waitFor(() =>
      expect(page.querySelector<HTMLButtonElement>("[data-claws-confirm]")?.disabled).toBe(false),
    );
    page.querySelector<HTMLElement>("[data-claws-confirm]")?.click();
    await vi.waitFor(() => expect(page.textContent).toContain("Preview it again"));
    expect(page.textContent).not.toContain("Add outcome unknown");
    expect(page.querySelector<HTMLButtonElement>("[data-claws-confirm]")?.disabled).toBe(true);
    expect(request).not.toHaveBeenCalledWith("claws.status", { target: "workflow-operator" });

    page.querySelector<HTMLElement>(".claws-catalog__review .callout.danger button")?.click();
    await vi.waitFor(() =>
      expect(request.mock.calls.filter(([method]) => method === "claws.add.plan")).toHaveLength(2),
    );
    await vi.waitFor(() =>
      expect(page.querySelector<HTMLButtonElement>("[data-claws-confirm]")?.disabled).toBe(false),
    );
    page.querySelector<HTMLElement>("[data-claws-confirm]")?.click();
    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("chat", { pathname: "/chat/workflow-operator" }),
    );
    expect(request.mock.calls.filter(([method]) => method === "claws.add.apply")).toHaveLength(2);
  });

  it("reconciles a timed-out Add from Claws status without retrying installation", async () => {
    const { page, request, navigate } = createPage({
      clawsEnabled: true,
      applyError: true,
      statusRecord: { agentId: "workflow-operator", version: "1.2.0", status: "complete" },
    });
    await vi.waitFor(() => expect(page.querySelector("[data-claws-explore]")).not.toBeNull());
    await vi.waitFor(() => expect(page.querySelector("[data-claws-entry] button")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-entry] button")?.click();
    await vi.waitFor(() => expect(page.querySelector("[data-claws-confirm]")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-confirm]")?.click();
    await vi.waitFor(() => expect(page.textContent).toContain("Claw added"));
    expect(page.querySelector("[data-claws-confirm]")).toBeNull();
    expect(request.mock.calls.filter(([method]) => method === "claws.add.apply")).toHaveLength(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("keeps an ambiguous Add unknown when status belongs to another Claw", async () => {
    const { page, request, navigate } = createPage({
      clawsEnabled: true,
      applyError: true,
      statusRecord: {
        agentId: "workflow-operator",
        name: "@openclaw/other-claw",
        version: "1.2.0",
        status: "complete",
      },
    });
    await vi.waitFor(() => expect(page.querySelector("[data-claws-entry] button")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-entry] button")?.click();
    await vi.waitFor(() => expect(page.querySelector("[data-claws-confirm]")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-confirm]")?.click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("claws.status", { target: "workflow-operator" }),
    );
    await vi.waitFor(() =>
      expect(
        page.querySelector(".claws-catalog__review .callout.warn button")?.textContent?.trim(),
      ).toBe("Check status"),
    );
    expect(page.textContent).toContain("Add outcome unknown");
    expect(page.textContent).not.toContain("Claw added");
    expect(request.mock.calls.filter(([method]) => method === "claws.add.apply")).toHaveLength(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("opens an installed Claw's home chat after Add when it needs setup", async () => {
    const { page, request, navigate, agentSelection, gateway } = createPage({
      clawsEnabled: true,
      applyResult: {
        agentId: "workflow-operator",
        status: "complete",
        readiness: { ready: false, requirements: [{ kind: "oauth", owner: "workflows" }] },
      },
    });
    await vi.waitFor(() => expect(page.querySelector("[data-claws-explore]")).not.toBeNull());
    await vi.waitFor(() => expect(page.querySelector("[data-claws-entry] button")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-entry] button")?.click();
    await vi.waitFor(() => expect(page.querySelector("[data-claws-confirm]")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-confirm]")?.click();
    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("chat", { pathname: "/chat/workflow-operator" }),
    );
    expect(request).toHaveBeenCalledWith("claws.status", { target: "workflow-operator" });
    expect(agentSelection.state.selectedId).toBe("workflow-operator");
    expect(gateway.setSessionKey).toHaveBeenCalledWith("agent:workflow-operator:team-room");
    expect(page.querySelector("openclaw-claws-catalog-dialog")).toBeNull();
  });

  const confirmedStatus = { agentId: "workflow-operator", version: "1.2.0", status: "complete" };
  const safeAddOutcomes: Array<[string, Parameters<typeof createPage>[0], string]> = [
    [
      "the agent is missing",
      {
        applyResult: {
          agentId: "workflow-operator",
          status: "complete",
          readiness: { ready: false, requirements: [{ kind: "oauth", owner: "workflows" }] },
        },
        statusRecord: { ...confirmedStatus, agentState: "missing" },
      },
      "Needs setup",
    ],
    [
      "Add is partial",
      {
        applyResult: {
          agentId: "workflow-operator",
          status: "partial",
          readiness: { ready: false },
          error: { code: "plugin_install_failed", message: "Plugin installation failed" },
        },
      },
      "Check Claws status",
    ],
    ["the status read fails", { statusErrorAfterAdd: true }, "Claw added"],
    [
      "the status record is stale",
      { statusRecord: { ...confirmedStatus, version: "1.1.0", agentState: "present" } },
      "Claw added",
    ],
    [
      "the status belongs to another Claw",
      { statusRecord: { ...confirmedStatus, name: "@openclaw/other-claw" } },
      "Claw added",
    ],
  ];

  it.each(safeAddOutcomes)("stays in review: %s", async (_condition, options, message) => {
    const { page, navigate, agentSelection } = createPage({
      clawsEnabled: true,
      ...options,
    });
    await vi.waitFor(() => expect(page.querySelector("[data-claws-entry] button")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-entry] button")?.click();
    await vi.waitFor(() => expect(page.querySelector("[data-claws-confirm]")).not.toBeNull());
    page.querySelector<HTMLElement>("[data-claws-confirm]")?.click();
    await vi.waitFor(() => expect(page.querySelectorAll(".agents-home__card")).toHaveLength(3));
    await vi.waitFor(() => {
      const done = page.querySelector<HTMLButtonElement>(".claws-catalog__footer button");
      expect(done?.textContent?.trim()).toBe("Done");
      expect(done?.disabled).toBe(false);
    });
    expect(page.textContent).toContain(message);
    expect(page.textContent).not.toContain("Add outcome unknown");
    expect(page.querySelector("[data-claws-confirm]")).toBeNull();
    expect(agentSelection.state.selectedId).toBe("harbor");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("shows the configured roster, prioritizes work across sessions, and opens the canonical main chat", async () => {
    const { page, request, navigate } = createPage();
    await vi.waitFor(() => expect(page.querySelectorAll(".agents-home__card")).toHaveLength(2));

    const cards = [...page.querySelectorAll(".agents-home__card")];
    expect(cards.map((card) => card.querySelector("h2")?.textContent)).toEqual(["Ember", "Harbor"]);
    expect(cards[0]?.textContent).toContain("Builds small tools");
    expect(cards[0]?.textContent).toContain("example/model-small");
    await vi.waitFor(() =>
      expect(cards[0]?.querySelector(".identity-avatar__agent-face")).not.toBeNull(),
    );
    expect(cards[1]?.querySelector(".identity-avatar__text")?.getAttribute("data-avatar")).toBe(
      "⚓",
    );
    expect(cards[0]?.querySelector(".agents-home__working")?.textContent).toBe("Working now");
    expect(cards[1]?.querySelector(".agents-home__working")).toBeNull();
    expect(cards[0]?.querySelector(".agents-home__preview")?.textContent?.trim()).toBe(
      "The main chat summary.",
    );
    expect(page.textContent).not.toContain("System helper");
    expect(page.textContent).not.toContain("A newer side-task message.");
    expect(request).toHaveBeenCalledWith(
      "sessions.list",
      expect.objectContaining({ includeLastMessage: true, archived: "all", limit: 100 }),
    );

    const openChat = cards[0]?.querySelector<HTMLElement>(".agents-home__open");
    expect(openChat?.textContent).toBe("Open chat");
    openChat?.click();
    expect(navigate).toHaveBeenCalledExactlyOnceWith("chat", { pathname: "/chat/ember" });
  });

  it("shares bounded activity loading between consumers and stops after the last detach", async () => {
    vi.useFakeTimers();
    const { page, provider, request, rosterListenerCount, updateSessions, emitChange } =
      createPage();
    await vi.waitFor(() => expect(page.querySelectorAll(".agents-home__card")).toHaveLength(2));
    const second = new (customElements.get(elementName) ?? AgentsHomePage)();
    provider.append(second);
    await vi.waitFor(() => expect(second.querySelectorAll(".agents-home__card")).toHaveLength(2));
    const calls = (method: string) =>
      request.mock.calls.filter(
        ([name, params]) =>
          name === method &&
          (method !== "sessions.list" ||
            (params !== null &&
              typeof params === "object" &&
              "archived" in params &&
              params.archived === "all")),
      );
    expect(calls("sessions.subscribe")).toHaveLength(0);
    expect(calls("sessions.list")).toHaveLength(1);
    expect(rosterListenerCount()).toBe(0);

    updateSessions(
      Array.from({ length: 301 }, (_, index) => ({
        key: `agent:harbor:task-${index}`,
        kind: "direct",
        updatedAt: index + 1,
        lastMessagePreview: `Activity ${index}`,
      })),
    );
    request.mockClear();
    emitChange();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(page.textContent).toContain("Activity 299");
    expect(second.textContent).toContain("Activity 299");
    expect(calls("sessions.list")).toHaveLength(3);
    expect(calls("sessions.subscribe")).toHaveLength(0);
    expect(page.textContent).not.toContain("Activity 300");

    page.remove();
    expect(rosterListenerCount()).toBe(0);
    request.mockClear();
    emitChange();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls("sessions.list")).toHaveLength(3);
    emitChange();
    second.remove();
    expect(rosterListenerCount()).toBe(0);
    request.mockClear();
    emitChange();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls("sessions.list")).toHaveLength(0);
  });

  it("refreshes live status and previews after session events and gateway reconnect", async () => {
    vi.useFakeTimers();
    const { page, updateSessions, emitChange, setPhase } = createPage();
    await vi.waitFor(() => expect(page.querySelector(".agents-home__working")).not.toBeNull());
    updateSessions([
      {
        key: "agent:ember:team-room",
        agentId: "ember",
        kind: "direct",
        isMain: true,
        updatedAt: 7_000,
        lastMessagePreview: "The tool is finished.",
      },
    ]);
    emitChange();
    emitChange();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(page.textContent).toContain("The tool is finished."));
    expect(page.querySelector(".agents-home__working")).toBeNull();

    setPhase("reconnecting");
    await vi.waitFor(() => expect(page.textContent).toContain("Connect to the Gateway"));
    updateSessions([
      {
        key: "agent:harbor:team-room",
        agentId: "harbor",
        kind: "direct",
        isMain: true,
        updatedAt: 8_000,
        lastMessagePreview: "The next schedule is ready.",
        hasActiveRun: true,
      },
    ]);
    setPhase("connected");
    await vi.waitFor(() => expect(page.textContent).toContain("The next schedule is ready."));
    expect(page.querySelector(".agents-home__card h2")?.textContent).toBe("Harbor");
    expect(page.querySelector(".agents-home__working")?.textContent).toBe("Working now");
  });
});
