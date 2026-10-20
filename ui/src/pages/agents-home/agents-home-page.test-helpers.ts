import { createComponent } from "solid-js";
import { vi } from "vitest";
import { GatewayRequestError } from "../../api/gateway.ts";
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

export function session(
  agentId: string,
  lastMessagePreview: string,
  updatedAt: number,
  overrides: Partial<GatewaySessionRow> = {},
): GatewaySessionRow {
  return {
    key: `agent:${agentId}:team-room`,
    agentId,
    kind: "direct",
    isMain: true,
    updatedAt,
    lastMessagePreview,
    ...overrides,
  };
}

export const initialSessions = () => [
  session("harbor", "The schedule is ready.", 5_000),
  session("ember", "The main chat summary.", 1_000),
  session("ember", "A newer side-task message.", 2_000, {
    key: "agent:ember:side-task",
    isMain: undefined,
    hasActiveRun: true,
  }),
];

function parameter(params: unknown, key: string, fallback: unknown = ""): unknown {
  return params && typeof params === "object" && key in params
    ? Reflect.get(params, key)
    : fallback;
}

export function rosterIdentity(params: unknown): AgentIdentityResult {
  const agentId = String(parameter(params, "agentId"));
  return {
    agentId,
    name: agentId === "ember" ? "Ember" : "Harbor",
    avatar: "",
    emoji: agentId === "harbor" ? "⚓" : "",
  };
}

export function listSessions(sessions: GatewaySessionRow[], params: unknown): SessionsListResult {
  const offset = Number(parameter(params, "offset", 0));
  const limit = Number(parameter(params, "limit", 300));
  const rows = sessions.slice(offset, offset + limit);
  return {
    ts: 6_000,
    path: "",
    count: rows.length,
    sessions: rows,
    defaults: { model: null, modelProvider: null, contextTokens: null },
    hasMore: offset + rows.length < sessions.length,
    nextOffset: offset + rows.length,
  };
}

export const workflowOperator = {
  packageName: "@openclaw/workflow-operator",
  displayName: "Workflow Operator",
  summary: "Runs approved work across your tools.",
  latestVersion: "1.2.0",
  channel: "official",
  official: true,
  ownerHandle: "openclaw",
  downloads: 12,
  installs: 12,
  updatedAtMs: 1_000,
} as const;

type PageOptions = {
  clawsEnabled?: boolean;
  workspaceFileNames?: string[];
  riskConsentRequired?: boolean;
  reviewRequiredOnce?: "plugin" | "skill";
  clawHubTrustWarning?: string;
  applyWait?: Promise<void>;
};

const disposers: Array<() => void> = [];

export function createPage(options: PageOptions = {}) {
  const clawsEnabled = options.clawsEnabled ?? false;
  const ensureConfigLoaded = vi.fn(async () => undefined);
  let addCount = 0;
  let rejectedForReview = false;
  const runtimeConfig = {
    state: {
      configSnapshot: {
        sourceConfig: { gateway: { controlUi: { experimental: { claws: clawsEnabled } } } },
      },
    },
    ensureLoaded: ensureConfigLoaded,
    subscribe: () => () => undefined,
  };
  const sessions = initialSessions();

  const request = createGatewayRequestMock(async (method, params) => {
    if (method === "agents.list") {
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
      return rosterIdentity(params);
    }
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    if (method === "sessions.list") {
      return listSessions(sessions, params);
    }
    if (method === "claws.catalog.search") {
      const query = String(parameter(params, "query")).trim().toLowerCase();
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
    if (method === "plugins.list") {
      return { plugins: [], diagnostics: [], mutationAllowed: true };
    }
    if (method === "claws.add.plan") {
      const capabilityGrants = {
        hooks: {
          allowPromptInjection: { effective: false },
          allowConversationAccess: { effective: true },
        },
      };
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
                  capabilityGrants,
                  capabilityGrantsByPluginId: { "workflow-tools": capabilityGrants },
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
      return {
        agentId: addCount === 1 ? "workflow-operator" : `workflow-operator-${addCount}`,
        status: "complete",
        readiness: { ready: true },
      };
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
    request,
    navigate,
    ensureConfigLoaded,
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
