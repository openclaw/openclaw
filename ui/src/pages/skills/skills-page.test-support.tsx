import type { SkillsLibraryListResult } from "@openclaw/gateway-protocol";
import { createRouter, definePage } from "@openclaw/uirouter";
import { createSignal, flush } from "solid-js";
import { onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
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

export function mountSkills(
  request: (method: string, params?: unknown) => Promise<unknown>,
  surface: "discovery" | "settings" = "discovery",
) {
  const client = { request } as unknown as GatewayBrowserClient;
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
    report: { workspaceDir: "/workspace", managedSkillsDir: "/managed", skills: [] },
    error: null,
  };
  const [routeData, setRouteData] = createSignal(initialRouteData, { ownedWrite: true });
  const [currentSurface, setCurrentSurface] = createSignal(surface);
  const mounted = mountSolid(() => (
    <ApplicationProvider value={context}>
      <SkillsPage routeData={routeData()} surface={currentSurface()} />
    </ApplicationProvider>
  ));
  flush();
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
    publishRouteData(this: void, patch: Partial<SkillsRouteData>) {
      setRouteData({ ...initialRouteData, ...patch });
      flush();
    },
    refreshRouteData: () => {
      setRouteData({ ...initialRouteData });
      flush();
    },
  };
}
