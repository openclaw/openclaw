/* @vitest-environment jsdom */

import type { SkillsLibraryListResult } from "@openclaw/gateway-protocol";
import { createRouter } from "@openclaw/uirouter";
import { createComponent, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { AgentsListResult } from "../api/types.ts";
import type { RouteId } from "../app-routes.ts";
import type { ApplicationContext } from "../app/context.ts";
import { createGatewayMetadataObserver } from "../app/gateway-observers.ts";
import { createApplicationGateway } from "../test-helpers/application-context-fixtures.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import { EMPTY_MODEL_PROVIDERS_DATA } from "./model-providers/load.ts";
import {
  createAuthStatus,
  createEmptyModelProvidersRouteData,
  createPage as createModelProvidersPage,
  drainPageUpdates,
  mountPage as mountModelProvidersPage,
  unmountPage as unmountModelProvidersPage,
} from "./model-providers/model-providers-page.test-support.tsx";
import { SkillsPage } from "./skills/skills-page.tsx";
import type { SkillsRouteData } from "./skills/view-types.ts";
import { createReport, createSkill } from "./skills/view.test-support.ts";
import type { UsageRouteData } from "./usage/types.ts";
import {
  cacheSnapshot,
  cleanupUsagePageTest,
  createPendingUsageRouteData,
  createPage as createUsagePage,
  focusDocument,
} from "./usage/usage-page.test-support.ts";
import "./model-providers/model-providers-page.tsx";

const USAGE_PAYLOAD_TTL_MS = 5 * 60_000;
const mainAgents = { defaultId: "main", agents: [{ id: "main" }] };
const authStatus = (displayName: string, ts = 1) =>
  createAuthStatus([{ provider: "openai", displayName }], ts);
const staleSnapshot = (context: ApplicationContext) => ({
  ...context.gateway.snapshot,
  hello: gatewayHelloForMethods([]),
});
const agentList = (id: string) => ({
  defaultId: id,
  mainKey: `agent:${id}:main`,
  scope: "all",
  agents: [{ id }],
});

function usageResult(key?: string): NonNullable<UsageRouteData["result"]> {
  return {
    ...cacheSnapshot("fresh").result,
    sessions: key ? [{ key, usage: null }] : [],
  };
}

function mockClient(handlers: Record<string, () => unknown>, fallback?: () => unknown) {
  const request = vi.fn(async (method: string) => {
    const handler = handlers[method] ?? fallback;
    if (!handler) {
      throw new Error(`Unexpected request: ${method}`);
    }
    return handler();
  });
  return { request, client: { request } as unknown as GatewayBrowserClient };
}

function modelClient(loadAuth: () => unknown, hash = "hash") {
  return mockClient(
    {
      "models.authStatus": loadAuth,
      "models.list": () => ({ models: [] }),
      "config.get": () => ({ config: {}, hash }),
      "usage.status": () => ({ updatedAt: 2, providers: [] }),
      "sessions.usage": () => ({ aggregates: { byProvider: [] } }),
    },
    () => ({}),
  );
}

function skillsClient(handlers: Record<string, () => unknown>) {
  return mockClient({
    "skills.library.list": () =>
      ({
        entries: [],
        profileId: null,
        multipleProfiles: false,
        defaultTarget: "workspace",
        canManageWorkspace: true,
        defaultSelectionLimit: 64,
      }) satisfies SkillsLibraryListResult,
    ...handlers,
  });
}

function agentContext(client: GatewayBrowserClient) {
  return contextWithClient(client, {
    connected: true,
    agentsList: mainAgents,
    selectedAgentId: "main",
  });
}

function securityVerdicts() {
  return {
    schema: "openclaw.skills.security-verdicts.v1",
    items: [
      {
        registry: "https://clawhub.ai",
        ok: true,
        decision: "pass",
        requestedSlug: "agentreceipt",
        requestedVersion: "1.2.3",
        securityStatus: "clean",
      },
    ],
  };
}

function contextWithClient(
  client: GatewayBrowserClient,
  options: {
    connected?: boolean;
    agentsList?: unknown;
    ensureList?: () => Promise<unknown>;
    selectedAgentId?: string | null;
  } = {},
) {
  const source = createApplicationGateway();
  source.publish({
    ...source.gateway.snapshot,
    client,
    phase: options.connected ? "connected" : "stopped",
    hello: gatewayHelloForMethods([]),
    sessionKey: "main",
  });
  const subscribe = () => () => undefined;
  const agentsList = options.agentsList ?? null;
  const createSelection = () => ({
    state: {
      selectedId: options.selectedAgentId ?? null,
      scopeId: options.selectedAgentId ?? null,
    },
    intentRevision: 0,
    set: vi.fn(),
    setScope: vi.fn(),
    subscribe,
  });
  const context = {
    router: createRouter<RouteId, ApplicationContext>({
      routes: [{ id: "chat", path: "/chat", component: () => ({}) }],
    }),
    gateway: source.gateway,
    agents: {
      state: { agentsList, agentsLoading: false, agentsError: null },
      ensureList: options.ensureList ?? vi.fn(async () => agentsList),
      subscribe,
    },
    agentSelection: createSelection(),
    settingsAgentSelection: createSelection(),
    runtimeConfig: {
      state: { configSnapshot: {}, configLoading: false },
      ensureLoaded: vi.fn(async () => undefined),
      subscribe,
    },
    overlays: {
      snapshot: { updateRunning: false, updateReconciliationPending: false },
      subscribe,
    },
    navigate: vi.fn(),
  } as unknown as ApplicationContext;
  const { gateway, publish } = source;
  return Object.assign(context, {
    emitConnected(connected: boolean) {
      publish({
        ...gateway.snapshot,
        phase: connected ? "connected" : "stopped",
        hello: connected ? gatewayHelloForMethods([]) : gateway.snapshot.hello,
      });
    },
    reconnect() {
      this.emitConnected(false);
      this.emitConnected(true);
    },
  });
}

function retireContext(context: ApplicationContext) {
  const previous = context.gateway.snapshot;
  createGatewayMetadataObserver(() => true).synchronize(previous, {
    ...previous,
    phase: "stopped",
  });
}

async function mountUsagePage(
  context: ApplicationContext,
  result: UsageRouteData["result"],
  gatewaySnapshot = context.gateway.snapshot,
) {
  const page = await createUsagePage(context.gateway.snapshot.client!, false, context);
  page.routeData = {
    ...createPendingUsageRouteData(context.gateway, "2026-07-08"),
    gatewaySnapshot,
    result,
    loadedAtMs: Date.now(),
  };
  await page.updateComplete;
  return page;
}

function skillReport(
  name: string,
  overrides: Parameters<typeof createSkill>[0] = {},
): NonNullable<SkillsRouteData["report"]> {
  return createReport([createSkill({ name, skillKey: name, ...overrides })]);
}

function mountSkillsPage(
  context: ApplicationContext,
  report: SkillsRouteData["report"],
  gatewaySnapshot = context.gateway.snapshot,
) {
  const provider = createSolidApplicationContextProvider(context);
  const routeData: SkillsRouteData = {
    gateway: context.gateway,
    gatewaySnapshot,
    agents: context.agents,
    selectedAgentId: context.settingsAgentSelection.state.selectedId,
    selectionIntentRevision: context.settingsAgentSelection.intentRevision,
    report,
    error: null,
  };
  const mounted = mountSolid(
    () => createComponent(SkillsPage, { routeData, surface: "settings" }),
    { wrapper: provider.wrapper },
  );
  let currentContext = context;
  const page = () => mounted.container.querySelector("openclaw-skills-page")!;
  flush();
  return {
    find: (selector: string) => page().querySelector<HTMLElement>(selector),
    text: () => page().textContent,
    replaceContext(next: ApplicationContext) {
      retireContext(currentContext);
      currentContext = next;
      provider.setContext(next);
      flush();
    },
  };
}

function linkedSkillReport() {
  return skillReport("Repo Skill", {
    skillKey: "repo-skill",
    skillCard: { present: true, path: "/tmp/skill-card.md", sizeBytes: 20 },
    clawhub: {
      status: "linked",
      valid: true,
      registry: "https://clawhub.ai",
      slug: "agentreceipt",
      installedVersion: "1.2.3",
      installedAt: 123,
      originPath: "/tmp/.clawhub/origin.json",
      lockPath: "/tmp/workspace/.clawhub/lock.json",
    },
  });
}

afterEach(cleanupUsagePageTest);

it("retries interrupted usage and clears retained data on provider replacement", async () => {
  focusDocument();
  const interrupted = deferred<UsageRouteData["result"]>();
  const freshResult = usageResult("fresh");
  let usageRequestCount = 0;
  const { client } = mockClient(
    {
      "sessions.usage": () => (++usageRequestCount === 1 ? interrupted.promise : freshResult),
      "usage.status": () => ({ providers: [{ provider: "old", displayName: "Old", windows: [] }] }),
    },
    () => ({}),
  );
  const harness = contextWithClient(client, { connected: true });
  const page = await mountUsagePage(harness, usageResult("cached"));
  const expectFresh = () =>
    expect(page.usageResult?.sessions.map(({ key }) => key)).toEqual(["fresh"]);
  void page.refresh();
  await waitForFast(() => expect(usageRequestCount).toBe(1));
  harness.reconnect();

  await waitForFast(expectFresh);
  interrupted.resolve(usageResult("stale"));
  await Promise.resolve();
  await Promise.resolve();
  expectFresh();
  page.read().callbacks.details.onSelectSession("fresh", false, ["fresh"]);
  expect(page.usageSelectedSessions).toEqual(["fresh"]);
  expect(page.read().data.providerUsage).toEqual([
    { provider: "old", displayName: "Old", windows: [] },
  ]);
  retireContext(harness);
  page.remove();
  page.context = contextWithClient(client);
  document.body.append(page.element);
  await page.updateComplete;
  expect(page.usageResult).toBeNull();
  expect(page.read().data.providerUsage).toEqual([]);
  expect(page.usageSelectedSessions).toEqual([]);
});

it("gates same-client usage reconnects by payload age and page visibility", async () => {
  const loadedAt = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(loadedAt);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const { client, request } = mockClient(
    {
      "sessions.usage": () => usageResult(),
      "usage.status": () => ({ providers: [] }),
    },
    () => ({ daily: [] }),
  );
  const harness = contextWithClient(client, { connected: true });
  await mountUsagePage(harness, usageResult(), {
    ...harness.gateway.snapshot,
  });
  expect(request.mock.calls.map(([method]) => method)).toEqual(["usage.status"]);
  harness.reconnect();
  expect(request.mock.calls.filter(([method]) => method === "sessions.usage")).toEqual([]);
  request.mockClear();

  clock.mockReturnValue(loadedAt + USAGE_PAYLOAD_TTL_MS);
  visibility.mockReturnValue("hidden");
  harness.reconnect();
  expect(request).not.toHaveBeenCalled();

  visibility.mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("focus"));
  await waitForFast(() =>
    expect(request.mock.calls.map(([method]) => method).toSorted()).toEqual([
      "sessions.usage",
      "usage.status",
    ]),
  );
});

it("discards Model Providers work from a replaced source that reuses its client", async () => {
  const staleAuth = deferred<unknown>();
  let authCalls = 0;
  const { client } = modelClient(() =>
    ++authCalls === 1 ? staleAuth.promise : authStatus("Fresh provider", 2),
  );
  const page = createModelProvidersPage(agentContext(client));
  const providerNames = () => page.view.props.cards.map((card) => card.displayName);
  page.routeData = createEmptyModelProvidersRouteData(page.context);
  mountModelProvidersPage(page);
  await waitForFast(() => expect(authCalls).toBe(1));

  retireContext(page.context);
  unmountModelProvidersPage(page);
  page.context = agentContext(client);
  mountModelProvidersPage(page);
  await page.updateComplete;
  await waitForFast(() => expect(providerNames()).toContain("Fresh provider"));

  staleAuth.resolve(authStatus("Retired provider"));
  await drainPageUpdates(page);
  expect(providerNames()).toContain("Fresh provider");
  expect(providerNames()).not.toContain("Retired provider");
});

it("hydrates cloned skill route data and retires verdicts across disconnect and replacement", async () => {
  const pending = deferred<{ schema: string; items: unknown[] }>();
  const verdicts = securityVerdicts();
  let verdictRequests = 0;
  const { client } = skillsClient({
    "skills.status": () => linkedSkillReport(),
    "skills.skillCard": () => ({ skillKey: "repo-skill", content: "Previous provider card" }),
    "skills.securityVerdicts": () => (++verdictRequests === 1 ? pending.promise : verdicts),
  });
  const harness = contextWithClient(client, {
    connected: true,
    agentsList: mainAgents,
    selectedAgentId: "main",
  });
  const mounted = mountSkillsPage(harness, linkedSkillReport(), {
    ...harness.gateway.snapshot,
  });
  await waitForSolid(() =>
    expect(mounted.find(".plugins-item")?.textContent).toContain("Refreshing"),
  );
  mounted.find('[aria-label="Open Repo Skill details"]')!.click();
  await waitForSolid(() => expect(mounted.find("#skill-detail-tab-card")).not.toBeNull());
  mounted
    .find("#skill-detail-tab-card")!
    .dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  await waitForSolid(() => expect(mounted.text()).toContain("Previous provider card"));
  const row = mounted.find(".plugins-item");
  harness.emitConnected(false);
  pending.resolve(verdicts);
  await pending.promise;
  await waitForSolid(() => expect(mounted.text()).not.toContain("Refreshing"));
  expect(mounted.find(".plugins-item")).toBe(row);
  expect(row?.textContent).toContain("Repo Skill");
  expect(mounted.text()).not.toContain("Clean");
  expect(mounted.find('[role="alert"]')).toBeNull();
  harness.emitConnected(true);
  await waitForSolid(() => expect(mounted.find(".plugins-item")?.textContent).toContain("Clean"));
  expect(mounted.text()).toContain("Repo Skill");
  expect(verdictRequests).toBe(2);

  mounted.replaceContext(contextWithClient(client));
  await waitForSolid(() => expect(mounted.find(".plugins-item")).toBeNull());
  expect(mounted.text()).not.toContain("Repo Skill");
  expect(mounted.text()).not.toContain("Clean");
  expect(mounted.text()).not.toContain("Previous provider card");
  expect(mounted.find("#skill-detail-panel")).toBeNull();
});

it.each([
  [
    "usage",
    async () => {
      const { client } = mockClient({ "sessions.usage": () => usageResult("fresh") }, () => ({}));
      const context = contextWithClient(client, { connected: true });
      const page = await mountUsagePage(context, usageResult("stale"), staleSnapshot(context));
      return () => page.usageResult?.sessions.map(({ key }) => key);
    },
  ],
  [
    "Model Providers",
    async () => {
      const { client } = modelClient(() => authStatus("fresh", 2), "fresh");
      const context = contextWithClient(client, { connected: true, selectedAgentId: "main" });
      const page = createModelProvidersPage(context);
      page.routeData = {
        ...createEmptyModelProvidersRouteData(context),
        client,
        gatewaySnapshot: staleSnapshot(context),
        data: { ...EMPTY_MODEL_PROVIDERS_DATA, authStatus: authStatus("stale") },
      };
      mountModelProvidersPage(page);
      return () => page.view.props.cards.map((card) => card.displayName);
    },
  ],
  [
    "skills",
    async () => {
      const { client } = skillsClient({ "skills.status": () => skillReport("fresh") });
      const context = agentContext(client);
      const mounted = mountSkillsPage(context, skillReport("stale"), staleSnapshot(context));
      return mounted.text;
    },
  ],
] as const)("rejects %s route data from an earlier same-client epoch", async (page, mount) => {
  const read = await mount();
  await waitForSolid(() => expect(read()).toContain("fresh"));
  if (page === "usage") {
    expect(read()).toEqual(["fresh"]);
  }
  expect(read()).not.toContain("stale");
});

it("discards an agent list from a replaced skills source that reuses its client", async () => {
  const pending = deferred<AgentsListResult | null>();
  const ensureList = vi.fn(() => pending.promise);
  const { client, request } = skillsClient({
    "skills.status": () => skillReport("Replacement agent skill"),
  });
  const context = contextWithClient(client, { connected: true, ensureList });
  const mounted = mountSkillsPage(context, null, staleSnapshot(context));
  await waitForSolid(() => expect(ensureList).toHaveBeenCalled());
  mounted.replaceContext(
    contextWithClient(client, {
      connected: true,
      agentsList: agentList("fresh"),
      selectedAgentId: "fresh",
    }),
  );
  await waitForSolid(() => expect(mounted.text()).toContain("Replacement agent skill"));
  pending.resolve(agentList("stale") as unknown as AgentsListResult);
  await pending.promise;
  flush();
  expect(mounted.text()).toContain("Replacement agent skill");
  expect(request).toHaveBeenCalledWith("skills.status", { agentId: "fresh" });
  expect(request).not.toHaveBeenCalledWith("skills.status", { agentId: "stale" });
});
