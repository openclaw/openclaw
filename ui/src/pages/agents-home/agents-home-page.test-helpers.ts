import { vi } from "vitest";
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
import { invalidateConfigConnection } from "../../lib/config/config-state-model.ts";
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
import type { ClawPluginReview } from "./claws-plugin-review.ts";

export const elementName = `test-agents-home-${crypto.randomUUID()}`;
customElements.define(elementName, class extends AgentsHomePage {});

export const roster: AgentsListResult = {
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

export const workflowOperator = {
  packageName: "@openclaw/workflow-operator",
  displayName: "Workflow Operator",
  summary: "Runs approved work across your tools.",
  latestVersion: "1.2.0",
  channel: "official",
  official: true,
  downloads: 12,
  updatedAtMs: 1_000,
} as const;

export const workflowPluginReview: ClawPluginReview = {
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
  capabilityGrantsByPluginId: {
    "workflow-tools": {
      hooks: {
        allowPromptInjection: { effective: false },
        allowConversationAccess: { effective: true, configured: true },
      },
    },
  },
  reviewToken: "review-workflow-tools",
};

export const auditUrl =
  "https://clawhub.ai/@openclaw/workflow-tools/versions/1.2.0/security-audit?review=pending-analysis";
export const auditWarning = [
  "╭─ ClawHub Security Audit ──────────────────────────────────────────────╮",
  "│ @openclaw/workflow-tools@1.2.0                                      │",
  "│ Outcome: Review                                                      │",
  "│ Overview:                                                            │",
  "│ Analysis pending; review this release before installation.          │",
  `│ Details: ${auditUrl} │`,
  "╰─────────────────────────────────────────────────────────────────────╯",
].join("\n");

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

export const orphanedClaw: ClawStatusRecord = {
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

export const orphanRemovePlan: ClawLifecyclePlan = {
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

export function createPage(
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
    catalogPluginCount?: number;
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
          plugins: options.catalogPluginCount ?? 1,
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
    switchGateway: (gatewayUrl: string) => {
      source.gateway.connection.gatewayUrl = gatewayUrl;
      source.publish({ ...source.gateway.snapshot, client: createTestGatewayClient(request) });
    },
    setClawsEnabled: (enabled: boolean) => {
      clawsEnabled = enabled;
      runtimeConfig.state.configSnapshot.sourceConfig.gateway.controlUi.experimental.claws =
        clawsEnabled;
      for (const listener of runtimeConfigListeners) {
        listener();
      }
    },
    markConfigStale: () => {
      invalidateConfigConnection(runtimeConfig.state);
      for (const listener of runtimeConfigListeners) {
        listener();
      }
    },
  };
}

const disposers: (() => void)[] = [];

export async function setupAgentsHomePageTest() {
  await i18n.setLocale("en");
}

export function cleanupAgentsHomePageTest() {
  document.body.replaceChildren();
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
  vi.useRealTimers();
}
