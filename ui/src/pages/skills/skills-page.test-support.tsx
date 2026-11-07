import type { SkillsLibraryListResult } from "@openclaw/gateway-protocol";
import { createRouter, definePage } from "@openclaw/uirouter";
import { createSignal, flush } from "solid-js";
import { onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SkillStatusReport } from "../../api/types.ts";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import { makeBootRoster } from "../../app/bootstrap.test-support.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import type { SkillsState } from "../../lib/skills/index.ts";
import { createApplicationGatewaySnapshot } from "../../test-helpers/application-context-fixtures.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { SkillsPage } from "./skills-page.tsx";
import type { SkillsRouteData } from "./view-types.ts";

export const personalLibrary = {
  entries: [],
  profileId: "alice",
  multipleProfiles: true,
  defaultTarget: "personal",
  canManageWorkspace: true,
  defaultSelectionLimit: 64,
} satisfies SkillsLibraryListResult;

export const remoteSkill = {
  score: 1,
  slug: "calendar",
  registry: "https://clawhub.ai",
  installRef: "@alice/calendar",
  displayName: "Calendar",
};

type SkillsRouteFixture = Partial<SkillsRouteData> & { report?: SkillStatusReport | null };

export function mountSkills(
  request: (
    method: string,
    params?: unknown,
    options?: Parameters<GatewayBrowserClient["request"]>[2],
  ) => Promise<unknown>,
  surface: "discovery" | "settings" = "discovery",
  initialData: SkillsRouteFixture = {},
) {
  const {
    report = { workspaceDir: "/workspace", managedSkillsDir: "/managed", skills: [] },
    ...initialRoute
  } = initialData;
  let nextReport = report;
  // Fixture inventories enter through the same request owner as live route adoption.
  const client = {
    request: (
      method: string,
      params?: unknown,
      options?: Parameters<GatewayBrowserClient["request"]>[2],
    ) => {
      if (method === "skills.status" && nextReport) {
        const value = nextReport;
        nextReport = null;
        return Promise.resolve(value);
      }
      return options ? request(method, params, options) : request(method, params);
    },
  } as unknown as GatewayBrowserClient;
  const connection = createApplicationGateway(
    createApplicationGatewaySnapshot({
      client,
      phase: "connected",
      hello: gatewayHelloForMethods(["skills.install", "skills.update"]),
      assistantAgentId: "main",
      sessionKey: "main",
    }),
  );
  const agentsList = makeBootRoster({
    scope: "global",
    agents: [{ id: "main" }, { id: "research" }],
  });
  const agents = {
    state: { agentsList, agentsLoading: false, agentsError: null },
    ensureList: vi.fn(async () => agentsList),
    subscribe: () => () => undefined,
  } as unknown as ApplicationContext["agents"];
  const router = createRouter({
    routes: [
      definePage({ id: "skills", path: "/skills", component: () => ({}) }),
      definePage({ id: "skill-settings", path: "/skills/settings", component: () => ({}) }),
    ],
  });
  onTestFinished(() => router.stop());
  const runtimeConfig: SkillsState["runtimeConfig"] = {
    runExternalMutation: async (task) => ({
      ok: true,
      value: await task(client),
      refresh: { ok: true },
    }),
  };
  const context = {
    basePath: "",
    router,
    runtimeConfig,
    gateway: connection.gateway,
    agents,
    agentSelection: createAgentSelectionCapability(connection.gateway, agents),
    settingsAgentSelection: createAgentSelectionCapability(
      connection.gateway,
      agents,
      undefined,
      undefined,
      { requireConfiguredAgent: true },
    ),
    navigate: vi.fn(),
  } as unknown as ApplicationContext;
  const selection =
    surface === "settings" ? context.settingsAgentSelection : context.agentSelection;
  const initialRouteData: SkillsRouteData = {
    gateway: connection.gateway,
    gatewaySnapshot: connection.gateway.snapshot,
    agents,
    selectedAgentId: "main",
    selectionIntentRevision: selection.intentRevision,
    error: null,
    ...initialRoute,
  };
  const [routeData, setRouteData] = createSignal(initialRouteData, { ownedWrite: true });
  const [currentSurface, setCurrentSurface] = createSignal(surface);
  const mounted = mountSolid(() => (
    <ApplicationProvider value={context}>
      <SkillsPage routeData={routeData()} surface={currentSurface()} />
    </ApplicationProvider>
  ));
  flush();
  nextReport = null;
  const page = mounted.container.querySelector<HTMLElement>("openclaw-skills-page")!;
  return {
    page,
    unmount: mounted.unmount,
    connection,
    agents,
    context,
    router,
    changeSurface(this: void, next: "discovery" | "settings") {
      setCurrentSurface(next);
      flush();
    },
    publishRouteData(this: void, patch: SkillsRouteFixture) {
      const { report: fixtureReport = report, ...route } = patch;
      nextReport = fixtureReport;
      setRouteData({ ...initialRouteData, ...route });
      flush();
      nextReport = null;
    },
    refreshRouteData: () => {
      nextReport = report;
      setRouteData({ ...initialRouteData });
      flush();
      nextReport = null;
    },
  };
}
