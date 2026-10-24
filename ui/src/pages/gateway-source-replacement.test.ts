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
import { sessionsResult } from "../lib/sessions/session-capability.test-support.ts";
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
import {
  createContext as createSessionsContext,
  createSessions,
} from "./sessions/sessions-page.test-support.ts";
import { SessionsPage } from "./sessions/sessions-page.tsx";
import { SkillsPage } from "./skills/skills-page.tsx";
import type { SkillsRouteData } from "./skills/view-types.ts";
import { createSkill } from "./skills/view.test-support.ts";
import type { UsageRouteData } from "./usage/types.ts";
import {
  cacheSnapshot,
  cleanupUsagePageTest,
  createPage as createUsagePage,
} from "./usage/usage-page.test-support.ts";
import "./model-providers/model-providers-page.tsx";

// Mirrors the module-private default usage TTL asserted below.
const USAGE_PAYLOAD_TTL_MS = 5 * 60_000;

function usageResult(key?: string): NonNullable<UsageRouteData["result"]> {
  return {
    ...cacheSnapshot("fresh").result,
    sessions: key ? [{ key, usage: null }] : [],
  };
}

const emptySkillLibrary = {
  entries: [],
  profileId: null,
  multipleProfiles: false,
  defaultTarget: "workspace",
  canManageWorkspace: true,
  defaultSelectionLimit: 64,
} satisfies SkillsLibraryListResult;

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

function modelClient(authStatus: () => unknown, hash: string) {
  return mockClient(
    {
      "models.authStatus": authStatus,
      "models.list": () => ({ models: [] }),
      "config.get": () => ({ config: {}, hash }),
      "usage.status": () => ({ updatedAt: 2, providers: [] }),
      "sessions.usage": () => ({ aggregates: { byProvider: [] } }),
    },
    () => ({}),
  );
}

function skillsClient(handlers: Record<string, () => unknown>) {
  return mockClient({ "skills.library.list": () => emptySkillLibrary, ...handlers });
}

function agentContext(client: GatewayBrowserClient) {
  return contextWithClient(client, {
    connected: true,
    agentsList: { defaultId: "main", agents: [{ id: "main" }] },
    selectedAgentId: "main",
  });
}

function securityVerdicts(withReasons = false) {
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
        ...(withReasons ? { reasons: [] } : {}),
      },
    ],
  };
}

function gatewayWithClient(
  client: GatewayBrowserClient,
  connected: boolean,
): ApplicationContext["gateway"] {
  const source = createApplicationGateway();
  source.publish({
    ...source.gateway.snapshot,
    client,
    phase: connected ? "connected" : "stopped",
    hello: gatewayHelloForMethods([]),
    sessionKey: "main",
  });
  return source.gateway;
}

function contextWithClient(
  client: GatewayBrowserClient,
  options: {
    connected?: boolean;
    agentsList?: unknown;
    ensureList?: () => Promise<unknown>;
    selectedAgentId?: string | null;
  } = {},
): ApplicationContext {
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
  return {
    router: createRouter<RouteId, ApplicationContext>({
      routes: [{ id: "chat", path: "/chat", component: () => ({}) }],
    }),
    gateway: gatewayWithClient(client, options.connected ?? false),
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
}

function contextWithMutableGateway(
  client: GatewayBrowserClient,
  options: { agentsList?: unknown; selectedAgentId?: string | null } = {},
) {
  const context = contextWithClient(client, { connected: true, ...options });
  const { gateway, publish } = createApplicationGateway(context.gateway.snapshot);
  Object.defineProperty(context, "gateway", { value: gateway });
  return {
    context,
    emitConnected(connected: boolean) {
      publish({
        ...gateway.snapshot,
        phase: connected ? "connected" : "stopped",
        hello: connected ? gatewayHelloForMethods([]) : gateway.snapshot.hello,
      });
    },
  };
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
    gateway: context.gateway,
    gatewaySnapshot,
    query: {
      startDate: "2026-07-08",
      endDate: "2026-07-08",
      scope: "family",
      timeZone: "local",
      agentId: null,
    },
    result,
    costSummary: null,
    loadedAtMs: Date.now(),
    error: null,
  };
  document.body.append(page.element);
  await page.updateComplete;
  return page;
}

function skillReport(
  name: string,
  overrides: Parameters<typeof createSkill>[0] = {},
): NonNullable<SkillsRouteData["report"]> {
  return {
    workspaceDir: "/tmp/workspace",
    managedSkillsDir: "/tmp/skills",
    skills: [createSkill({ name, skillKey: name, ...overrides })],
  };
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
  flush();
  return {
    find: (selector: string) =>
      mounted.container.querySelector("openclaw-skills-page")!.querySelector<HTMLElement>(selector),
    text: () => mounted.container.querySelector("openclaw-skills-page")!.textContent,
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

afterEach(() => {
  cleanupUsagePageTest();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("rejects usage route data from an earlier same-client gateway epoch", async () => {
  const freshResult = usageResult("fresh");
  const { client } = mockClient({ "sessions.usage": () => freshResult }, () => ({}));
  const context = contextWithClient(client, { connected: true });
  const page = await mountUsagePage(context, usageResult("stale"), {
    ...context.gateway.snapshot,
    hello: gatewayHelloForMethods([]),
  });

  await waitForFast(() =>
    expect(page.usageResult?.sessions.map(({ key }) => key)).toEqual(["fresh"]),
  );
});

it("retries a usage load interrupted by a same-client disconnect", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const interrupted = deferred<UsageRouteData["result"]>();
  const freshResult = usageResult("fresh");
  let usageRequestCount = 0;
  const { client, request } = mockClient(
    {
      "sessions.usage": () => (++usageRequestCount === 1 ? interrupted.promise : freshResult),
    },
    () => ({}),
  );
  const harness = contextWithMutableGateway(client);
  const page = await mountUsagePage(harness.context, usageResult("cached"));
  const expectFresh = () =>
    expect(page.usageResult?.sessions.map(({ key }) => key)).toEqual(["fresh"]);
  void page.refresh();
  await waitForFast(() => expect(usageRequestCount).toBe(1));
  harness.emitConnected(false);
  harness.emitConnected(true);

  await waitForFast(() =>
    expect(request.mock.calls.filter(([method]) => method === "sessions.usage")).toHaveLength(2),
  );
  await waitForFast(expectFresh);
  interrupted.resolve(usageResult("stale"));
  await Promise.resolve();
  await Promise.resolve();
  expectFresh();
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
  const harness = contextWithMutableGateway(client);
  const result = usageResult();
  const page = await mountUsagePage(harness.context, result, {
    ...harness.context.gateway.snapshot,
  });

  expect(page.usageResult).toMatchObject({
    totals: result.totals,
    sessions: result.sessions,
  });

  // Route data carries only session usage; the page starts its own provider read.
  expect(request.mock.calls.map(([method]) => method)).toEqual(["usage.status"]);
  harness.emitConnected(false);
  harness.emitConnected(true);
  // Fresh session usage survives a same-client reconnect, even one that interrupts the
  // page's provider read.
  expect(request.mock.calls.filter(([method]) => method === "sessions.usage")).toEqual([]);
  request.mockClear();

  clock.mockReturnValue(loadedAt + USAGE_PAYLOAD_TTL_MS);
  visibility.mockReturnValue("hidden");
  harness.emitConnected(false);
  harness.emitConnected(true);
  expect(request).not.toHaveBeenCalled();

  visibility.mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("focus"));
  await waitForFast(() => expect(page.usageLoading).toBe(false));
  const initialMethods = request.mock.calls.map(([method]) => method);
  expect(initialMethods.toSorted()).toEqual(["sessions.usage", "usage.status"]);

  void page.refresh();
  await waitForFast(() => expect(page.usageLoading).toBe(false));
  expect(request).toHaveBeenCalledTimes(4);

  const failedRefresh = deferred<never>();
  request.mockImplementationOnce(() => failedRefresh.promise);
  clock.mockReturnValue(loadedAt + 2 * USAGE_PAYLOAD_TTL_MS);
  void page.refresh();
  expect(request).toHaveBeenCalledTimes(6);
  window.dispatchEvent(new Event("focus"));
  failedRefresh.reject(new Error("connection interrupted"));
  await waitForFast(() => expect(request).toHaveBeenCalledTimes(8));
  await waitForFast(() => expect(page.usageLoading).toBe(false));
});

it("discards Model Providers work from a replaced source that reuses its client", async () => {
  const staleAuth = deferred<unknown>();
  let authCalls = 0;
  const { client } = modelClient(
    () =>
      ++authCalls === 1
        ? staleAuth.promise
        : createAuthStatus([{ provider: "openai", displayName: "Fresh provider" }], 2),
    "hash",
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

  staleAuth.resolve(createAuthStatus([{ provider: "openai", displayName: "Retired provider" }]));
  await drainPageUpdates(page);
  expect(providerNames()).toContain("Fresh provider");
  expect(providerNames()).not.toContain("Retired provider");
});

it("rejects Model Providers route data from an earlier same-client gateway epoch", async () => {
  const { client } = modelClient(
    () => createAuthStatus([{ provider: "openai", displayName: "Fresh provider" }], 2),
    "fresh",
  );
  const context = contextWithClient(client, {
    connected: true,
    selectedAgentId: "main",
  });
  const staleData = {
    ...EMPTY_MODEL_PROVIDERS_DATA,
    authStatus: createAuthStatus([{ provider: "openai", displayName: "Retired provider" }]),
  };
  const page = createModelProvidersPage(context);
  page.routeData = {
    gateway: context.gateway,
    gatewaySnapshot: { ...context.gateway.snapshot, hello: gatewayHelloForMethods([]) },
    data: staleData,
    client,
    agentId: "main",
    selectionIntentRevision: context.settingsAgentSelection.intentRevision,
  };

  mountModelProvidersPage(page);
  await waitForFast(() =>
    expect(page.view.props.cards.map((card) => card.displayName)).toContain("Fresh provider"),
  );
  expect(page.view.props.cards.map((card) => card.displayName)).not.toContain("Retired provider");
});

it.each([false, true])("hydrates skill verdicts (disconnect: %s)", async (disconnect) => {
  const pending = deferred<{ schema: string; items: unknown[] }>();
  const verdicts = securityVerdicts(!disconnect);
  let verdictRequests = 0;
  const { client, request } = skillsClient({
    ...(disconnect ? { "skills.status": () => linkedSkillReport() } : {}),
    "skills.securityVerdicts": () =>
      ++verdictRequests === 1 && disconnect ? pending.promise : verdicts,
  });
  const harness = contextWithMutableGateway(client, {
    agentsList: { defaultId: "main", agents: [{ id: "main" }] },
    selectedAgentId: "main",
  });
  const mounted = mountSkillsPage(
    harness.context,
    linkedSkillReport(),
    disconnect ? harness.context.gateway.snapshot : { ...harness.context.gateway.snapshot },
  );
  await waitForSolid(() =>
    expect(mounted.find(".plugins-item")?.textContent).toContain(
      disconnect ? "Refreshing" : "Clean",
    ),
  );
  if (disconnect) {
    const row = mounted.find(".plugins-item");
    harness.emitConnected(false);
    pending.resolve(verdicts);
    await pending.promise;
    await waitForSolid(() => expect(mounted.text()).not.toContain("Refreshing"));
    expect(mounted.find(".plugins-item")).toBe(row);
    expect(row?.textContent).toContain("Repo Skill");
    expect(mounted.text()).not.toContain("Clean");
    expect(mounted.find('[role="alert"]')).toBeNull();
  } else {
    expect(mounted.text()).toContain("Repo Skill");
  }
  expect(request).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenCalledWith("skills.library.list", { scope: "all" });
  expect(request).toHaveBeenCalledWith("skills.securityVerdicts", { agentId: "main" });
  if (!disconnect) {
    return;
  }

  harness.emitConnected(true);
  await waitForSolid(() => expect(mounted.find(".plugins-item")?.textContent).toContain("Clean"));
  expect(mounted.text()).toContain("Repo Skill");
  expect(verdictRequests).toBe(2);

  mounted.replaceContext(contextWithClient(client));
  await waitForSolid(() => expect(mounted.find(".plugins-item")).toBeNull());
  expect(mounted.text()).not.toContain("Repo Skill");
  expect(mounted.text()).not.toContain("Clean");
});

it("rejects skills route data from an earlier same-client gateway epoch", async () => {
  const freshReport = skillReport("Fresh skill");
  const { client } = skillsClient({ "skills.status": () => freshReport });
  const context = agentContext(client);
  const mounted = mountSkillsPage(context, skillReport("Stale skill"), {
    ...context.gateway.snapshot,
    hello: gatewayHelloForMethods([]),
  });
  await waitForSolid(() => expect(mounted.text()).toContain("Fresh skill"));
  expect(mounted.text()).not.toContain("Stale skill");
});

it("clears sessions loaded by the previous provider", async () => {
  const client = {} as GatewayBrowserClient;
  const row = { key: "old", sessionId: "old-session", kind: "direct" as const };
  const stopList = vi.fn();
  const context = createSessionsContext(
    gatewayWithClient(client, true),
    createSessions({
      listSnapshot: () => ({
        result: sessionsResult([row], 1),
        agentId: null,
        loading: false,
        error: null,
      }),
      subscribeList: () => stopList,
    }),
  );
  const provider = createSolidApplicationContextProvider(context);
  const mounted = mountSolid(() => createComponent(SessionsPage, {}), {
    wrapper: provider.wrapper,
  });
  const page = () => mounted.container.querySelector<HTMLElement>("openclaw-sessions-page")!;
  const checkbox = () =>
    page().querySelector<HTMLInputElement>('input[aria-label="Select session: old"]');
  await waitForSolid(() => expect(checkbox()).not.toBeNull());
  const previousPage = page();
  checkbox()!.click();
  await waitForSolid(() =>
    expect(page().querySelector(".data-table-bulk-bar")?.textContent).toContain("1 selected"),
  );

  retireContext(context);
  // Application contexts are owner-scoped: the keyed provider retires the old page tree.
  provider.setContext(createSessionsContext(gatewayWithClient(client, false), createSessions()));
  await waitForSolid(() => {
    expect(page()).not.toBe(previousPage);
    expect(previousPage.isConnected).toBe(false);
    expect(checkbox()).toBeNull();
    expect(page().querySelector(".data-table-bulk-bar")).toBeNull();
    expect(stopList).toHaveBeenCalledOnce();
  });
});

it("clears usage loaded by the previous provider", async () => {
  const result = usageResult("old");
  const providerUsage = {
    updatedAt: 1,
    providers: [{ provider: "old", displayName: "Old provider", windows: [] }],
  };
  const { client } = mockClient({
    "sessions.usage": () => result,
    "usage.status": () => providerUsage,
    "sessions.usage.timeseries": () => null,
    "sessions.usage.logs": () => ({ logs: [] }),
  });
  const context = contextWithClient(client, { connected: true });
  const page = await createUsagePage(client, false, context);
  document.body.append(page.element);
  await page.updateComplete;
  await page.refresh();
  expect(page.usageResult).toMatchObject({
    totals: result.totals,
    sessions: result.sessions,
  });
  expect(page.read().data.providerUsage).toEqual(providerUsage.providers);
  page.read().callbacks.details.onSelectSession("old", false, ["old"]);
  expect(page.usageSelectedSessions).toEqual(["old"]);

  retireContext(page.context);
  page.remove();
  page.context = contextWithClient(client);
  document.body.append(page.element);
  await page.updateComplete;

  expect(page.usageResult).toBeNull();
  expect(page.read().data.providerUsage).toEqual([]);
  expect(page.usageSelectedSessions).toEqual([]);
});

it("clears skills and cached cards loaded by the previous provider", async () => {
  const report = skillReport("Old provider skill");
  report.skills[0]!.skillCard = { present: true, path: "/tmp/skill-card.md", sizeBytes: 20 };
  const { client } = skillsClient({
    "skills.skillCard": () => ({
      skillKey: "Old provider skill",
      content: "# Previous provider card",
    }),
  });
  const context = agentContext(client);
  const mounted = mountSkillsPage(context, report);
  const details = () => mounted.find('[aria-label="Open Old provider skill details"]');
  await waitForSolid(() => expect(details()).not.toBeNull());
  details()!.click();
  await waitForSolid(() => expect(mounted.find("#skill-detail-tab-card")).not.toBeNull());
  mounted
    .find("#skill-detail-tab-card")!
    .dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  await waitForSolid(() => expect(mounted.text()).toContain("Previous provider card"));
  mounted.replaceContext(contextWithClient(client));
  await waitForSolid(() => expect(mounted.text()).not.toContain("Old provider skill"));
  expect(mounted.text()).not.toContain("Previous provider card");
  expect(mounted.find("#skill-detail-panel")).toBeNull();
});

it("discards an agent list from a replaced skills source that reuses its client", async () => {
  const pending = deferred<AgentsListResult | null>();
  const ensureList = vi.fn(() => pending.promise);
  const { client, request } = skillsClient({
    "skills.status": () => skillReport("Replacement agent skill"),
  });
  const context = contextWithClient(client, { connected: true, ensureList });
  const mounted = mountSkillsPage(context, null, {
    ...context.gateway.snapshot,
    hello: gatewayHelloForMethods([]),
  });
  await waitForSolid(() => expect(ensureList).toHaveBeenCalled());
  const replacementAgents = {
    defaultId: "fresh",
    mainKey: "agent:fresh:main",
    scope: "all",
    agents: [{ id: "fresh" }],
  };
  mounted.replaceContext(
    contextWithClient(client, {
      connected: true,
      agentsList: replacementAgents,
      selectedAgentId: "fresh",
    }),
  );
  await waitForSolid(() => expect(mounted.text()).toContain("Replacement agent skill"));
  pending.resolve({
    defaultId: "stale",
    mainKey: "agent:stale:main",
    scope: "all",
    agents: [{ id: "stale" }],
  } as unknown as AgentsListResult);
  await pending.promise;
  flush();
  expect(mounted.text()).toContain("Replacement agent skill");
  expect(request).toHaveBeenCalledWith("skills.status", { agentId: "fresh" });
  expect(request).not.toHaveBeenCalledWith("skills.status", { agentId: "stale" });
});
