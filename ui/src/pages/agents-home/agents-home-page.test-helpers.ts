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
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { createAgentIdentityCapability } from "../../lib/agents/identity.ts";
import { createAgentCapability } from "../../lib/agents/index.ts";
import { createSessionCapability } from "../../lib/sessions/index.ts";
import { createContext } from "../../test-helpers/app-sidebar.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import {
  createGatewayRequestMock,
  type GatewayRequestMock,
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
  updatedAtMs: 1_000,
} as const;

type PageOptions = {
  workspaceFileNames?: string[];
  riskConsentRequired?: boolean;
  reviewRequiredOnce?: "plugin" | "skill";
  clawHubTrustWarning?: string;
  applyWait?: Promise<void>;
};

const disposers: Array<() => void> = [];

export function createPage(options: PageOptions = {}) {
  let addCount = 0;
  let rejectedForReview = false;
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
      const kind = options.reviewRequiredOnce;
      const plugin = kind === "plugin";
      const ref = plugin ? "@openclaw/workflow-tools" : "@openclaw/research";
      const review = {
        actionId: `${kind}:${ref}`,
        ref,
        version: "1.2.0",
        reviewToken: plugin ? "review-workflow-tools" : "review-research",
        riskWarning: plugin
          ? "This plugin can access conversations."
          : "This skill needs your trust.",
      };
      return {
        operation: "add",
        planIntegrity: "sha256:reviewed-plan",
        pluginReviews: plugin
          ? [
              {
                ...review,
                pluginId: "workflow-tools",
                ownerAction: "install",
                capabilityGrants,
                capabilityGrantsByPluginId: { "workflow-tools": capabilityGrants },
              },
            ]
          : [],
        skillReviews: kind === "skill" ? [review] : [],
      };
    }
    if (method === "claws.add.apply") {
      await options.applyWait;
      const acknowledged = parameter(params, "acknowledgeClawHubRisk") === true;
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
  return mountAgentsHome(request, {
    config: { gateway: { controlUi: { experimental: { claws: true } } } },
    hello: gatewayHelloForMethods(
      ["openclaw.chat", "claws.catalog.search", "claws.catalog.detail", "claws.add.apply"],
      ["operator.read", "operator.admin"],
    ),
  });
}

export function mountAgentsHome(
  request: GatewayRequestMock,
  options: {
    config?: Record<string, unknown>;
    hello?: ApplicationGatewaySnapshot["hello"];
    staticSelection?: boolean;
  } = {},
) {
  const ensureConfigLoaded = vi.fn(async () => undefined);
  const source = createApplicationGateway({
    client: createTestGatewayClient(request),
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: options.hello ?? null,
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
  const agentSelection = options.staticSelection
    ? {
        intentRevision: 0,
        state: { selectedId: "harbor", scopeId: null },
        set: () => undefined,
        setScope: () => undefined,
        subscribe: () => () => undefined,
        dispose: () => undefined,
      }
    : createAgentSelectionCapability(source.gateway, agents);
  const agentIdentity = createAgentIdentityCapability(source.gateway);
  const sessions = createSessionCapability(source.gateway, agentSelection);
  const navigate = vi.fn<ApplicationContext["navigate"]>();
  const context = {
    ...createContext(source.gateway, sessions, roster, [], agentIdentity),
    basePath: "",
    agents,
    agentSelection,
    navigate,
    runtimeConfig: {
      state: { configSnapshot: { sourceConfig: options.config ?? {} } },
      ensureLoaded: ensureConfigLoaded,
      subscribe: () => () => undefined,
    } as unknown as ApplicationContext["runtimeConfig"],
  };
  const baselineEventListeners = eventListeners.size;
  const provider = createSolidApplicationContextProvider(context);
  const mountPage = () =>
    mountSolid(() => createComponent(AgentsHomePage, {}), { wrapper: provider.wrapper });
  const view = mountPage();
  disposers.push(() => {
    view.unmount();
    agentSelection.dispose();
    agents.dispose();
    sessions.dispose();
  });
  return {
    page: view.container,
    wrapper: provider.wrapper,
    unmount: view.unmount,
    mountPage,
    request,
    navigate,
    ensureConfigLoaded,
    rosterListenerCount: () => eventListeners.size - baselineEventListeners,
    emitChange: () => {
      for (const listener of eventListeners) {
        listener({ type: "event", event: "sessions.changed", payload: {} });
      }
    },
    setPhase: (phase: ApplicationGatewaySnapshot["phase"]) =>
      source.publish({ ...source.gateway.snapshot, phase }),
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
