import { vi } from "vitest";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { invalidateConfigConnection } from "../../lib/config/config-state-model.ts";
import {
  createApplicationContextProvider,
  createApplicationGateway,
} from "../../test-helpers/application-context.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import type { ClawStatusRecord } from "../agents-home/claws-catalog-client.ts";
import type { ClawLifecyclePlan, ClawUpdatePlan } from "./claw-lifecycle-client.ts";
import { AgentClawPanel } from "./claw-lifecycle-panel.ts";

export const installed: ClawStatusRecord = {
  agentId: "workflow",
  name: "@openclaw/workflow-operator",
  version: "1.2.0",
  sourceKind: "package",
  status: "complete",
  agentState: "present",
  bootstrapState: "complete",
  orphaned: false,
  addedAtMs: 1_000,
  updatedAtMs: 2_000,
  resources: [
    { kind: "agent", id: "workflow", state: "present", relationship: "managed" },
    {
      kind: "plugin",
      id: "workflow-tools",
      state: "present",
      relationship: "referenced",
      origin: "pre-existing",
      independentOwner: true,
    },
  ],
};

export const updatePluginReview = {
  actionId: "package:workflow-tools",
  pluginId: "workflow-tools",
  ref: "@openclaw/workflow-tools",
  version: "1.3.0",
  ownerAction: "install" as const,
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
      allowConversationAccess: { effective: true },
    },
  },
  capabilityGrantsByPluginId: {
    "workflow-tools": {
      hooks: {
        allowPromptInjection: { effective: false },
        allowConversationAccess: { effective: true },
      },
    },
  },
  reviewToken: "review-workflow-tools-1.3.0",
};

export const auditUrl =
  "https://clawhub.ai/@openclaw/workflow-tools/versions/1.3.0/security-audit?review=pending-analysis";
export const auditWarning = [
  "╭─ ClawHub Security Audit ──────────────────────────────────────────────╮",
  "│ @openclaw/workflow-tools@1.3.0                                      │",
  "│ Outcome: Review                                                      │",
  "│ Overview:                                                            │",
  "│ Analysis pending; review this release before installation.          │",
  `│ Details: ${auditUrl} │`,
  "╰─────────────────────────────────────────────────────────────────────╯",
].join("\n");

export const updatePlan: ClawUpdatePlan = {
  schemaVersion: "openclaw.clawsGatewayPlan.v1",
  operation: "update",
  planIntegrity: "sha256:update-plan",
  target: {
    agentId: "workflow",
    name: installed.name,
    currentVersion: installed.version,
    targetVersion: "1.3.0",
  },
  actions: [
    {
      kind: "plugin",
      id: "workflow-tools",
      action: "install",
      blocked: false,
    },
  ],
  capabilities: [
    {
      kind: "plugin",
      id: "workflow-tools",
      action: "grant",
      reason: "Start approved workflows",
    },
  ],
  pluginReviews: [updatePluginReview],
  skillReviews: [],
  blockers: [],
  riskAcknowledgementRequired: false,
  configuredAccess: {
    coverage: "configuration-only",
    current: {
      tools: { allowed: ["read"], excluded: ["exec"], explicitAllow: ["read"], explicitDeny: [] },
      sandbox: { mode: "non-main", scope: "agent", workspaceAccess: "ro", backend: "docker" },
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
    desired: {
      tools: {
        allowed: ["read", "workflow.start"],
        excluded: ["exec"],
        explicitAllow: ["read", "workflow.start"],
        explicitDeny: [],
      },
      sandbox: { mode: "non-main", scope: "agent", workspaceAccess: "ro", backend: "docker" },
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
  },
  scheduledJobs: { coverage: "package-declarations", jobs: [] },
  readiness: { ready: true, requirements: [] },
};

export const removePlan: ClawLifecyclePlan = {
  schemaVersion: "openclaw.clawsGatewayPlan.v1",
  operation: "remove",
  planIntegrity: "sha256:remove-plan",
  target: { agentId: "workflow", name: installed.name, currentVersion: installed.version },
  actions: [
    { kind: "agent", id: "workflow", action: "delete", blocked: false },
    {
      kind: "plugin",
      id: "workflow-tools",
      action: "retain",
      blocked: false,
    },
  ],
  capabilities: [],
  blockers: [],
  pluginReviews: [],
  skillReviews: [],
  riskAcknowledgementRequired: false,
  scheduledJobs: { coverage: "package-declarations", jobs: [] },
};

export function mount(
  options: {
    clawsEnabled?: boolean;
    record?: ClawStatusRecord | null;
    plan?: ClawLifecyclePlan;
    applyError?: boolean;
    removeAppliedBeforeError?: boolean;
    agentStillInRoster?: boolean;
    removeRejectedOnce?: boolean;
    applyResult?: { agentId: string; status: "complete" | "partial"; agentRemoved: boolean };
    latestVersion?: string;
    updatePlan?: ClawUpdatePlan;
    updateApplyError?: boolean;
    updateRejectedOnce?: boolean;
    updateAppliedBeforeError?: boolean;
    updateAppliedRecord?: Partial<ClawStatusRecord>;
    updateApplyResult?: { agentId: string; status: string; readiness: { ready: boolean } };
  } = {},
) {
  let record: ClawStatusRecord | null = options.record === undefined ? installed : options.record;
  let rejectedRemove = false;
  let rejectedUpdate = false;
  let clawsEnabled = options.clawsEnabled ?? false;
  const latestVersion = options.latestVersion ?? "1.3.0";
  const plannedUpdate =
    options.updatePlan ??
    ({
      ...updatePlan,
      target: { ...updatePlan.target, targetVersion: latestVersion },
    } satisfies ClawUpdatePlan);
  const request = createGatewayRequestMock(async (method) => {
    if (method === "claws.status") {
      return { records: record ? [record] : [] };
    }
    if (method === "claws.catalog.search") {
      return {
        entries: [
          {
            packageName: "@openclaw/workflow-operator",
            displayName: "Workflow Operator",
            latestVersion,
            channel: "official",
            official: true,
          },
        ],
      };
    }
    if (method === "claws.catalog.detail") {
      return {
        detail: {
          packageName: "@openclaw/workflow-operator",
          displayName: "Workflow Operator",
          version: latestVersion,
          latestVersion,
          channel: "official",
          official: true,
          workspaceFiles: 1,
          skills: 0,
          plugins: 1,
          mcpServers: 0,
          scheduledJobs: 0,
        },
      };
    }
    if (method === "claws.update.plan") {
      return plannedUpdate;
    }
    if (method === "claws.update.apply") {
      if (options.updateRejectedOnce && !rejectedUpdate) {
        rejectedUpdate = true;
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "The Claw changed since review. Preview it again.",
        });
      }
      if (options.updateApplyError) {
        if (options.updateAppliedBeforeError && record) {
          record = {
            ...record,
            version: latestVersion,
            ...options.updateAppliedRecord,
            updatedAtMs: 3_000,
          };
        }
        throw new Error("Gateway reply timed out");
      }
      if (record) {
        record = { ...record, version: latestVersion, updatedAtMs: 3_000 };
      }
      return (
        options.updateApplyResult ?? {
          agentId: "workflow",
          status: "complete",
          readiness: { ready: true },
        }
      );
    }
    if (method === "claws.remove.plan") {
      return options.plan ?? removePlan;
    }
    if (method === "claws.remove.apply") {
      if (options.removeRejectedOnce && !rejectedRemove) {
        rejectedRemove = true;
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "The removal plan changed. Preview it again.",
        });
      }
      if (options.applyError) {
        if (options.removeAppliedBeforeError) {
          record = null;
        }
        throw new Error("Gateway reply timed out");
      }
      const result = options.applyResult ?? {
        agentId: "workflow",
        status: "complete" as const,
        agentRemoved: true,
      };
      if (result.agentRemoved) {
        record = null;
      }
      return result;
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
        "claws.status",
        "claws.catalog.search",
        "claws.catalog.detail",
        "claws.update.plan",
        "claws.update.apply",
        "claws.remove.plan",
        "claws.remove.apply",
      ],
      ["operator.read", "operator.admin"],
    ),
    assistantAgentId: "workflow",
    sessionKey: "agent:workflow:main",
    lastError: null,
    lastErrorCode: null,
  });
  const navigate = vi.fn<ApplicationContext["navigate"]>();
  const refreshList = vi.fn(async () => ({
    agents: record || options.agentStillInRoster ? [{ id: "workflow" }] : [],
    defaultId: "main",
    mainKey: "main",
  }));
  const runtimeConfigListeners = new Set<() => void>();
  const runtimeConfig = {
    state: {
      configSnapshot: {
        sourceConfig: {
          gateway: { controlUi: { experimental: { claws: clawsEnabled } } },
        },
      },
    },
    ensureLoaded: async () => undefined,
    subscribe: (listener: () => void) => {
      runtimeConfigListeners.add(listener);
      return () => runtimeConfigListeners.delete(listener);
    },
  };
  const provider = createApplicationContextProvider({
    gateway: source.gateway,
    agents: { refreshList },
    runtimeConfig,
    navigate,
  } as unknown as ApplicationContext);
  const panel = document.createElement("openclaw-agent-claw-panel") as AgentClawPanel;
  panel.agentId = "workflow";
  provider.append(panel);
  document.body.append(provider);
  return {
    panel,
    request,
    navigate,
    refreshList,
    source,
    setClawsEnabled: (enabled: boolean) => {
      clawsEnabled = enabled;
      runtimeConfig.state.configSnapshot.sourceConfig.gateway.controlUi.experimental.claws =
        enabled;
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

export async function setupClawLifecyclePanelTest() {
  await i18n.setLocale("en");
}

export function cleanupClawLifecyclePanelTest() {
  document.body.replaceChildren();
}
