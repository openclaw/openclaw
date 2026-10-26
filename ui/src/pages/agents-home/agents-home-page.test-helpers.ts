import { createComponent } from "solid-js";
import { vi } from "vitest";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import type { AgentIdentityResult, AgentsListResult } from "../../api/types.ts";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { createAgentIdentityCapability } from "../../lib/agents/identity.ts";
import { createAgentCapability } from "../../lib/agents/index.ts";
import { createSessionCapability } from "../../lib/sessions/index.ts";
import { createContext } from "../../test-helpers/app-sidebar.ts";
import { createApplicationGatewaySnapshot } from "../../test-helpers/application-context-fixtures.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { ClawsPage } from "../claws/page.tsx";

const roster: AgentsListResult = {
  defaultId: "harbor",
  mainKey: "team-room",
  scope: "per-sender",
  agents: [
    { id: "harbor", name: "Harbor", identity: { theme: "Keeps the team organized", emoji: "⚓" } },
  ],
};

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
  pathname?: string;
  clawIconUrl?: string;
  workspaceFileNames?: string[];
  riskConsentRequired?: boolean;
  reviewRequiredOnce?: "plugin" | "skill";
  clawHubTrustWarning?: string;
  applyWait?: Promise<void>;
};

const disposers: Array<() => void> = [];

export function createPage(options: PageOptions = {}) {
  const ensureConfigLoaded = vi.fn(async () => undefined);
  let addCount = 0;
  let rejectedForReview = false;
  const runtimeConfigListeners = new Set<() => void>();
  const runtimeConfig = {
    state: {
      configSnapshot: {
        sourceConfig: {
          gateway: { controlUi: { experimental: { claws: options.clawsEnabled ?? false } } },
        },
      },
    },
    ensureLoaded: ensureConfigLoaded,
    subscribe: (listener: () => void) => {
      runtimeConfigListeners.add(listener);
      return () => runtimeConfigListeners.delete(listener);
    },
  };
  const capabilityGrants = {
    hooks: {
      allowPromptInjection: { effective: false },
      allowConversationAccess: { effective: true },
    },
  };
  const request = createGatewayRequestMock(async (method, params) => {
    const args = params && typeof params === "object" ? params : {};
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
      const agentId = "agentId" in args ? String(args.agentId) : "";
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
    if (method === "claws.catalog.search") {
      const query = "query" in args ? String(args.query).trim().toLowerCase() : "";
      const category = "category" in args ? String(args.category) : "";
      const featured = "featured" in args ? Boolean(args.featured) : false;
      return {
        entries:
          featured ||
          (category && category !== "productivity") ||
          (query &&
            !workflowOperator.displayName.toLowerCase().includes(query) &&
            !workflowOperator.packageName.toLowerCase().includes(query))
            ? []
            : [{ ...workflowOperator, iconUrl: options.clawIconUrl }],
      };
    }
    if (method === "claws.catalog.detail") {
      const instructions = (options.workspaceFileNames ?? ["AGENTS.md", "SOUL.md", "USER.md"]).map(
        (name) => ({ name, source: `workspace/${name}` }),
      );
      return {
        detail: {
          ...workflowOperator,
          iconUrl: options.clawIconUrl,
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
      const name = "name" in args ? String(args.name) : "";
      return { preview: { kind: "instruction", name, content: `# ${name}` } };
    }
    if (method === "plugins.list") {
      return { plugins: [], diagnostics: [], mutationAllowed: true };
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
      const acknowledged = "acknowledgeClawHubRisk" in args && args.acknowledgeClawHubRisk === true;
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
        options.reviewRequiredOnce === "plugin"
          ? "acknowledgeCapabilities" in args
          : "acknowledgeSkillWarnings" in args;
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
  const source = createApplicationGateway(
    createApplicationGatewaySnapshot({
      client,
      phase: "connected",
      hello: gatewayHelloForMethods(
        ["openclaw.chat", "claws.catalog.search", "claws.catalog.detail", "claws.add.apply"],
        ["operator.read", "operator.admin"],
      ),
      assistantAgentId: "harbor",
      sessionKey: "agent:harbor:team-room",
    }),
  );
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
    agents,
    agentSelection,
    runtimeConfig: runtimeConfig as unknown as ApplicationContext["runtimeConfig"],
    navigate,
  };
  const solidProvider = createSolidApplicationContextProvider(context);
  const view = mountSolid(
    () =>
      createComponent(ClawsPage, {
        routeData: {
          basePath: "",
          location: { pathname: options.pathname ?? "/claws", search: "", hash: "" },
        },
      }),
    { wrapper: solidProvider.wrapper },
  );
  disposers.push(() => {
    view.unmount();
    agentSelection.dispose();
    agents.dispose();
    sessionCapability.dispose();
  });
  return {
    page: view.container,
    wrapper: solidProvider.wrapper,
    context,
    request,
    navigate,
    ensureConfigLoaded,
    setPhase: (phase: ApplicationGatewaySnapshot["phase"]) =>
      source.publish({ ...source.gateway.snapshot, phase }),
    setClawsEnabled: (enabled: boolean) => {
      runtimeConfig.state.configSnapshot.sourceConfig.gateway.controlUi.experimental.claws =
        enabled;
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
