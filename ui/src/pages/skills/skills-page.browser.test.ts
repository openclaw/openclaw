import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsListResult, SkillStatusEntry, SkillStatusReport } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { clawhubVerdictKey } from "../../lib/skills/index.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import type { SkillsRouteData } from "./skills-page.ts";
import "./skills-page.ts";

type TestSkillsPage = HTMLElement & {
  routeData: SkillsRouteData;
  skillsDetailKey: string | null;
  clawhubVerdicts: Record<string, { securityStatus?: string | null }>;
  readonly updateComplete: Promise<boolean>;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function createSkill(): SkillStatusEntry {
  return {
    name: "AgentReceipt",
    description: "Linked ClawHub skill",
    source: "workspace",
    filePath: "/tmp/skills/agentreceipt/SKILL.md",
    baseDir: "/tmp/skills/agentreceipt",
    skillKey: "agentreceipt",
    bundled: false,
    primaryEnv: undefined,
    emoji: undefined,
    homepage: "https://clawhub.ai/skills/agentreceipt",
    always: false,
    disabled: false,
    blockedByAllowlist: false,
    blockedByAgentFilter: false,
    eligible: true,
    requirements: { bins: [], env: [], config: [], os: [] },
    missing: { bins: [], env: [], config: [], os: [] },
    configChecks: [],
    install: [],
    clawhub: {
      status: "linked",
      valid: true,
      registry: "https://clawhub.ai",
      slug: "agentreceipt",
      installedVersion: "1.2.3",
      installedAt: 123,
    },
  };
}

function createContext(
  client: GatewayBrowserClient,
  agentsList: AgentsListResult,
  connected = true,
): ApplicationContext {
  const snapshot = {
    client,
    connected,
    reconnecting: false,
    hello: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  } as ApplicationGatewaySnapshot;
  const gateway = {
    snapshot,
    eventLog: [],
    subscribe: () => () => undefined,
    subscribeEvents: () => () => undefined,
    subscribeEventLog: () => () => undefined,
  } as unknown as ApplicationContext["gateway"];
  const agents = {
    state: { agentsList, agentsLoading: false, agentsError: null },
    ensureList: vi.fn(async () => agentsList),
    subscribe: () => () => undefined,
  } as unknown as ApplicationContext["agents"];
  return {
    gateway,
    agents,
    navigate: vi.fn(),
  } as unknown as ApplicationContext;
}

function normalizedText(node: Node): string {
  return node.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("openclaw-skills-page route hydration", () => {
  it.each([
    { connected: true, routeState: "connected" },
    { connected: false, routeState: "request-capable but transiently disconnected" },
  ])(
    "hydrates linked skill verdicts without reloading the $routeState route report",
    async ({ connected }) => {
      const verdictResponse = deferred<{
        schema: "openclaw.skills.security-verdicts.v1";
        items: Array<{
          registry: string;
          ok: boolean;
          decision: string;
          reasons: string[];
          requestedSlug: string;
          requestedVersion: string;
          securityStatus: string;
          securityPassed: boolean;
        }>;
      }>();
      const request = vi.fn((method: string) => {
        if (method === "skills.securityVerdicts") {
          return verdictResponse.promise;
        }
        return Promise.reject(new Error(`Unexpected Gateway request: ${method}`));
      });
      const client = { request } as unknown as GatewayBrowserClient;
      const agentsList: AgentsListResult = {
        defaultId: "main",
        mainKey: "main",
        scope: "project",
        agents: [{ id: "main", name: "Main" }],
      };
      const context = createContext(client, agentsList, connected);
      const report: SkillStatusReport = {
        workspaceDir: "/tmp/workspace",
        managedSkillsDir: "/tmp/skills",
        skills: [createSkill()],
      };
      const page = document.createElement("openclaw-skills-page") as TestSkillsPage;
      page.routeData = {
        gateway: context.gateway,
        gatewaySnapshot: context.gateway.snapshot,
        agents: context.agents,
        agentsList,
        selectedAgentId: null,
        report,
        error: null,
      };
      const provider = createApplicationContextProvider(context);
      provider.append(page);
      document.body.append(provider);

      await vi.waitFor(() => {
        expect(request).toHaveBeenCalledWith("skills.securityVerdicts", {});
      });
      expect(request.mock.calls.map(([method]) => method)).toEqual(["skills.securityVerdicts"]);

      page.skillsDetailKey = "agentreceipt";
      await page.updateComplete;
      expect(normalizedText(page)).toContain("Refreshing");
      expect(normalizedText(page)).not.toContain("Unavailable");

      verdictResponse.resolve({
        schema: "openclaw.skills.security-verdicts.v1",
        items: [
          {
            registry: "https://clawhub.ai",
            ok: true,
            decision: "pass",
            reasons: [],
            requestedSlug: "agentreceipt",
            requestedVersion: "1.2.3",
            securityStatus: "clean",
            securityPassed: true,
          },
        ],
      });

      const key = clawhubVerdictKey({
        registry: "https://clawhub.ai",
        slug: "agentreceipt",
        version: "1.2.3",
      });
      await vi.waitFor(() => {
        expect(page.clawhubVerdicts[key]?.securityStatus).toBe("clean");
        expect(normalizedText(page)).toContain("Clean");
      });
      expect(normalizedText(page)).not.toContain("Unavailable");
    },
  );
});
