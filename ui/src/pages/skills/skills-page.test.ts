/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  ApplicationContext,
  ApplicationGateway,
  ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import {
  createApplicationContextProvider,
  type ApplicationContextProvider,
} from "../../test-helpers/application-context.ts";
import type { SkillsRouteData } from "./skills-page.ts";
import "./skills-page.ts";

type TestSkillsPage = HTMLElement & {
  routeData?: SkillsRouteData;
  updateComplete: Promise<boolean>;
};

function createHarness() {
  const request = vi.fn(async (method: string) => {
    if (method === "skills.status") {
      return { workspaceDir: "C:\\workspace", managedSkillsDir: "C:\\skills", skills: [] };
    }
    return undefined;
  });
  const client = { request } as unknown as GatewayBrowserClient;
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    connected: true,
    reconnecting: false,
    hello: {
      type: "hello-ok",
      protocol: 1,
      auth: { role: "operator", scopes: ["operator.read"] },
      features: { methods: ["skills.status"] },
    },
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const gateway = {
    snapshot,
    connection: { gatewayUrl: "ws://localhost", token: "", password: "", bootstrapToken: "" },
    eventLog: [],
    connect: () => undefined,
    setSessionKey: () => undefined,
    start: () => undefined,
    stop: () => undefined,
    subscribe: () => () => undefined,
    subscribeEventLog: () => () => undefined,
    subscribeEvents: () => () => undefined,
  } satisfies ApplicationGateway;
  const agentsList = { defaultId: "main", mainKey: "main", scope: "all", agents: [] };
  const agents = {
    state: {
      agentsLoading: false,
      agentsError: null,
      agentsList,
    },
    ensureList: vi.fn(async () => agentsList),
    subscribe: () => () => undefined,
  } as unknown as ApplicationContext["agents"];
  const context = {
    gateway,
    agents,
    basePath: "",
    navigate: vi.fn(),
  } as unknown as ApplicationContext;
  const routeData: SkillsRouteData = {
    gateway,
    gatewaySnapshot: snapshot,
    agents,
    agentsList: null,
    selectedAgentId: null,
    report: null,
    error: null,
    initialTab: "following",
  };
  return { context, gateway, request, routeData };
}

async function mount(
  context: ApplicationContext,
  routeData: SkillsRouteData,
): Promise<{ page: TestSkillsPage; provider: ApplicationContextProvider }> {
  const provider = createApplicationContextProvider(context);
  const page = document.createElement("openclaw-skills-page") as TestSkillsPage;
  page.routeData = routeData;
  provider.append(page);
  document.body.append(provider);
  await page.updateComplete;
  return { page, provider };
}

describe("SkillsPage publisher feed fallback", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("loads Skills when a Following deep link is unsupported", async () => {
    const { context, request, routeData } = createHarness();
    const { page } = await mount(context, routeData);

    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("skills.status", {}));
    expect(page.querySelector("#plugins-tab-following")).toBeNull();
    expect(page.querySelector("#plugins-tab-skills")?.getAttribute("aria-selected")).toBe("true");
  });
});
