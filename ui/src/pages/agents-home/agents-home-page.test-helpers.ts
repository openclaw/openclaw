import { createComponent } from "solid-js";
import { vi } from "vitest";
import { GatewayRequestError, type GatewayEventListener } from "../../api/gateway.ts";
import type {
  AgentIdentityResult,
  AgentsListResult,
  GatewaySessionRow,
  SessionsListResult,
} from "../../api/types.ts";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { createAgentIdentityCapability } from "../../lib/agents/identity.ts";
import { createAgentCapability } from "../../lib/agents/index.ts";
import type { PluginListResult } from "../../lib/plugins/index.ts";
import { createSessionCapability } from "../../lib/sessions/index.ts";
import { createContext } from "../../test-helpers/app-sidebar.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { AgentsHomePage } from "./agents-home-page.tsx";

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

type PageOptions = {
  clawsEnabled?: boolean;
  workspaceFileNames?: string[];
  applyResult?: {
    agentId: string;
    status: string;
    readiness: { ready: boolean; requirements?: Array<{ kind: string; owner: string }> };
  };
  riskConsentRequired?: boolean;
  reviewRequiredOnce?: "plugin" | "skill";
  clawHubTrustWarning?: string;
  installedPlugins?: PluginListResult["plugins"];
  rosterErrorOnceAfterAdd?: boolean;
  applyWait?: Promise<void>;
};

const disposers: Array<() => void> = [];

export function createPage(options: PageOptions = {}) {
  let clawsEnabled = options.clawsEnabled ?? false;
  const ensureConfigLoaded = vi.fn(async () => undefined);
  let addCount = 0;
  let rejectedForReview = false;
  let rosterFailuresAfterAdd = 0;
  const runtimeConfigListeners = new Set<() => void>();
  const runtimeConfig = {
    state: {
      configSnapshot: {
        sourceConfig: { gateway: { controlUi: { experimental: { claws: clawsEnabled } } } },
      },
    },
    ensureLoaded: ensureConfigLoaded,
    subscribe: (listener: () => void) => {
      runtimeConfigListeners.add(listener);
      return () => runtimeConfigListeners.delete(listener);
    },
  };
  const sessions: GatewaySessionRow[] = [
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
      if (addCount > 0 && options.rosterErrorOnceAfterAdd && rosterFailuresAfterAdd++ === 0) {
        throw new Error("Roster unavailable");
      }
      return {
        ...roster,
        agents: [
          ...roster.agents,
          ...Array.from({ length: addCount }, (_, index) => ({
            id: index === 0 ? "workflow-operator" : `workflow-operator-${index + 1}`,
          })),
        ],
      };
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
      return {
        entries:
          query &&
          !workflowOperator.displayName.toLowerCase().includes(query) &&
          !workflowOperator.packageName.toLowerCase().includes(query)
            ? []
            : [workflowOperator],
      };
    }
    if (method === "claws.catalog.detail") {
      const instructions = (options.workspaceFileNames ?? ["AGENTS.md", "SOUL.md", "USER.md"]).map(
        (name) => ({ name, source: `workspace/${name}` }),
      );
      return {
        detail: {
          ...workflowOperator,
          version: "1.2.0",
          agentName: "Workflow Operator",
          workspaceFiles: instructions.length,
          skills: 1,
          plugins: 1,
          mcpServers: 0,
          scheduledJobs: 0,
          contents: {
            instructions,
            skills: [{ name: "@openclaw/research", version: "1.2.0" }],
            integrations: [{ name: "@openclaw/workflow-tools", kind: "plugin", version: "1.2.0" }],
            automations: [],
          },
        },
      };
    }
    if (method === "claws.catalog.preview") {
      const name =
        params && typeof params === "object" && "name" in params ? String(params.name) : "";
      return { preview: { kind: "instruction", name, content: `# ${name}` } };
    }
    if (method === "plugins.list") {
      return { plugins: options.installedPlugins ?? [], diagnostics: [], mutationAllowed: true };
    }
    if (method === "claws.add.plan") {
      return {
        operation: "add",
        planIntegrity: "sha256:reviewed-plan",
        pluginReviews:
          options.reviewRequiredOnce === "plugin"
            ? [
                {
                  actionId: "plugin:@openclaw/workflow-tools",
                  pluginId: "workflow-tools",
                  ref: "@openclaw/workflow-tools",
                  version: "1.2.0",
                  ownerAction: "install",
                  integrity: `sha256-${"A".repeat(43)}=`,
                  declaredCapabilities: { tools: ["workflow.start"] },
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
                  reviewToken: "review-workflow-tools",
                  riskWarning: "This plugin can access conversations.",
                },
              ]
            : [],
        skillReviews:
          options.reviewRequiredOnce === "skill"
            ? [
                {
                  actionId: "skill:@openclaw/research",
                  ref: "@openclaw/research",
                  version: "1.2.0",
                  integrity: "sha256:reviewed-skill",
                  riskWarning: "This skill needs your trust.",
                  reviewToken: "review-research",
                },
              ]
            : [],
      };
    }
    if (method === "claws.add.apply") {
      await options.applyWait;
      const acknowledged =
        params &&
        typeof params === "object" &&
        "acknowledgeClawHubRisk" in params &&
        params.acknowledgeClawHubRisk === true;
      if (options.riskConsentRequired && !acknowledged) {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "Explicit acknowledgement is required for this ClawHub release.",
          details: {
            code: "CLAWHUB_RISK_ACKNOWLEDGEMENT_REQUIRED",
            warning: options.clawHubTrustWarning ?? "Review this ClawHub release before adding it.",
          },
        });
      }
      const reviewed =
        params &&
        typeof params === "object" &&
        (options.reviewRequiredOnce === "plugin"
          ? "acknowledgeCapabilities" in params
          : "acknowledgeSkillWarnings" in params);
      if (options.reviewRequiredOnce && !rejectedForReview && !reviewed) {
        rejectedForReview = true;
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "Review the included dependencies before adding.",
          details: { code: "CLAW_REVIEW_REQUIRED", kind: options.reviewRequiredOnce },
        });
      }
      addCount += 1;
      return (
        options.applyResult ?? {
          agentId: addCount === 1 ? "workflow-operator" : `workflow-operator-${addCount}`,
          status: "complete",
          readiness: { ready: true },
        }
      );
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
      ["openclaw.chat", "claws.catalog.search", "claws.catalog.detail", "claws.add.apply"],
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
    ...createContext(source.gateway, sessionCapability, roster, [], agentIdentity),
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
  const solidProvider = createSolidApplicationContextProvider(context);
  const view = mountSolid(() => createComponent(AgentsHomePage, {}), {
    wrapper: solidProvider.wrapper,
  });
  const page = view.container;
  disposers.push(() => {
    view.unmount();
    agentSelection.dispose();
    agents.dispose();
    sessionCapability.dispose();
  });
  return {
    page,
    wrapper: solidProvider.wrapper,
    context,
    rosterListenerCount: () => eventListeners.size - baselineEventListeners,
    request,
    navigate,
    ensureConfigLoaded,
    agentSelection,
    gateway: source.gateway,
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
