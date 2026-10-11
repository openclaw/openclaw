/* @vitest-environment jsdom */

import { TaskStatus } from "@lit/task";
import type { SkillsLibraryListResult } from "@openclaw/gateway-protocol";
import { nothing } from "lit";
import { createComponent, createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { AgentsListResult } from "../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../app/context.ts";
import { createGatewayMetadataObserver } from "../app/gateway-observers.ts";
import { sessionsResult } from "../lib/sessions/session-capability.test-support.ts";
import { settleLitElement } from "../test-helpers/lit-settle.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import type { ModelProvidersData } from "./model-providers/load.ts";
import {
  createEmptyModelProvidersRouteData,
  createPage as createModelProvidersPage,
  mountPage as mountModelProvidersPage,
  unmountPage as unmountModelProvidersPage,
} from "./model-providers/model-providers-page.test-support.tsx";
import {
  createContext as createSessionsContext,
  createPage as createSessionsPage,
  createSessions,
  reconnectPage,
} from "./sessions/sessions-page.test-support.ts";
import { SkillsPage, type SkillsRouteData } from "./skills/skills-page.tsx";
import { createSkill } from "./skills/view.test-support.ts";
import type { UsageRefreshPolicy } from "./usage/refresh-policy.ts";
import { cacheSnapshot } from "./usage/usage-page.test-support.ts";
import type { UsageRouteData } from "./usage/usage-page.ts";
import "./debug/debug-page.ts";
import "./logs/logs-page.ts";
import "./model-providers/model-providers-page.tsx";
import "./usage/usage-page.ts";

// Mirrors the module-private default usage TTL asserted below.
const USAGE_PAYLOAD_TTL_MS = 5 * 60_000;

function usageResult(key?: string): NonNullable<UsageRouteData["result"]> {
  return {
    ...cacheSnapshot("fresh").result,
    sessions: key ? [{ key, usage: null }] : [],
  };
}

const settledEmptyProviderUsage = {
  state: "settled",
  result: { ok: true, value: { updatedAt: 1, providers: [] } },
} satisfies UsageRouteData["providerUsage"];

const emptySkillLibrary = {
  entries: [],
  profileId: null,
  multipleProfiles: false,
  defaultTarget: "workspace",
  canManageWorkspace: true,
  defaultSelectionLimit: 64,
} satisfies SkillsLibraryListResult;

type TestPage = HTMLElement & {
  context: ApplicationContext;
  render: () => unknown;
  readonly updateComplete: Promise<boolean>;
};

type TestGatewayController = {
  applySnapshot: (
    snapshot: ApplicationGatewaySnapshot,
    binding: { initial: boolean; sourceChanged: boolean },
  ) => void;
};

function applyPageGatewaySnapshot(
  page: TestPage & { gateway: TestGatewayController },
  snapshot: ApplicationGatewaySnapshot,
) {
  page.gateway.applySnapshot(snapshot, { initial: false, sourceChanged: false });
}

function gatewayWithClient(
  client: GatewayBrowserClient,
  connected: boolean,
): ApplicationContext["gateway"] {
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: connected ? "connected" : "stopped",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  return {
    snapshot,
    eventLog: [],
    subscribe: () => () => undefined,
    subscribeEvents: () => () => undefined,
    subscribeEventLog: () => () => undefined,
  } as unknown as ApplicationContext["gateway"];
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
    basePath: "",
    gateway: gatewayWithClient(client, options.connected ?? false),
    agents: {
      state: { agentsList, agentsLoading: false, agentsError: null },
      ensureList: options.ensureList ?? vi.fn(async () => agentsList),
      subscribe,
    },
    agentIdentity: { get: () => undefined, ensure: vi.fn(async () => undefined), subscribe },
    agentSelection: createSelection(),
    settingsAgentSelection: createSelection(),
    channels: { subscribe },
    runtimeConfig: {
      state: { configSnapshot: {}, configLoading: false },
      ensureLoaded: vi.fn(async () => undefined),
      subscribe,
    },
    overlays: {
      snapshot: { updateRunning: false, updateReconciliationPending: false },
      subscribe,
    },
    sessions: {
      state: { result: null, loading: false },
      list: vi.fn(async () => null),
      listSnapshot: () => ({ result: null, agentId: null, loading: false, error: null }),
      subscribeList: () => () => undefined,
      refreshList: vi.fn(async () => undefined),
      subscribe,
    },
    workboard: { subscribe },
    navigate: vi.fn(),
    preload: vi.fn(async () => undefined),
  } as unknown as ApplicationContext;
}

function contextWithMutableGateway(
  client: GatewayBrowserClient,
  options: { agentsList?: unknown; selectedAgentId?: string | null } = {},
) {
  const context = contextWithClient(client, { connected: true, ...options });
  let currentSnapshot = context.gateway.snapshot;
  const listeners = new Set<(snapshot: ApplicationGatewaySnapshot) => void>();
  const gateway = {
    ...context.gateway,
    get snapshot() {
      return currentSnapshot;
    },
    subscribe: (listener: (snapshot: ApplicationGatewaySnapshot) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as ApplicationContext["gateway"];
  Object.defineProperty(context, "gateway", { value: gateway });
  return {
    context,
    emitConnected(connected: boolean) {
      currentSnapshot = { ...currentSnapshot, phase: connected ? "connected" : "stopped" };
      for (const listener of listeners) {
        listener(currentSnapshot);
      }
    },
  };
}

function createPage(tagName: string, context: ApplicationContext): TestPage {
  const page = document.createElement(tagName) as TestPage;
  page.context = context;
  page.render = () => nothing;
  return page;
}

async function replaceContext(
  page: TestPage,
  replacementClient: GatewayBrowserClient,
  options: { connected?: boolean; agentsList?: unknown; selectedAgentId?: string | null } = {},
): Promise<void> {
  const previous = page.context.gateway.snapshot;
  // End the old connection through its real metadata owner before replacing the test source.
  createGatewayMetadataObserver(() => true).synchronize(previous, {
    ...previous,
    phase: "stopped",
  });
  page.remove();
  page.context = contextWithClient(replacementClient, options);
  document.body.append(page);
  await page.updateComplete;
}

function usageRouteData(
  context: ApplicationContext,
  result: UsageRouteData["result"],
  gatewaySnapshot = context.gateway.snapshot,
): UsageRouteData {
  return {
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
    providerUsage: settledEmptyProviderUsage,
    loadedAtMs: Date.now(),
    error: null,
  };
}

function skillsRouteData(
  context: ApplicationContext,
  report: SkillsRouteData["report"],
  gatewaySnapshot = context.gateway.snapshot,
): SkillsRouteData {
  return {
    gateway: context.gateway,
    gatewaySnapshot,
    agents: context.agents,
    selectedAgentId: context.settingsAgentSelection.state.selectedId,
    selectionIntentRevision: context.settingsAgentSelection.intentRevision,
    report,
    error: null,
  };
}

function skillReport(name: string): NonNullable<SkillsRouteData["report"]> {
  return {
    workspaceDir: "/tmp/workspace",
    managedSkillsDir: "/tmp/skills",
    skills: [createSkill({ name, skillKey: name })],
  };
}

function mountSkillsPage(context: ApplicationContext, initialRoute?: SkillsRouteData) {
  const provider = createSolidApplicationContextProvider(context);
  const [routeData, setRouteData] = createSignal(initialRoute, { ownedWrite: true });
  const mounted = mountSolid(
    () =>
      createComponent(SkillsPage, {
        get routeData() {
          return routeData();
        },
        surface: "settings",
      }),
    { wrapper: provider.wrapper },
  );
  let currentContext = context;
  flush();
  return {
    get page() {
      return mounted.container.querySelector<HTMLElement>("openclaw-skills-page")!;
    },
    setRouteData,
    replaceContext(next: ApplicationContext) {
      const previous = currentContext.gateway.snapshot;
      createGatewayMetadataObserver(() => true).synchronize(previous, {
        ...previous,
        phase: "stopped",
      });
      currentContext = next;
      provider.setContext(next);
      flush();
    },
  };
}

function linkedSkillReport() {
  return {
    ...skillReport("Repo Skill"),
    skills: [
      createSkill({
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
      }),
    ],
  } as SkillsRouteData["report"];
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("gateway source replacement across reconnect with a reused client", () => {
  it("rejects usage route data from an earlier same-client gateway epoch", async () => {
    const freshResult = usageResult("fresh");
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.usage") {
        return freshResult;
      }
      return {};
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const context = contextWithClient(client, { connected: true });
    const staleResult = usageResult("stale");
    const page = createPage("openclaw-usage-page", context) as TestPage & {
      routeData: UsageRouteData;
      usageResult: UsageRouteData["result"];
    };
    page.routeData = usageRouteData(context, staleResult, { ...context.gateway.snapshot });

    document.body.append(page);
    await page.updateComplete;
    await waitForFast(() => expect(page.usageResult).toBe(freshResult));

    expect(page.usageResult).not.toBe(staleResult);
  });

  it("retries a usage load interrupted by a same-client disconnect", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const interrupted = deferred<UsageRouteData["result"]>();
    const freshResult = usageResult("fresh");
    let usageRequestCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.usage") {
        return {};
      }
      usageRequestCount += 1;
      return usageRequestCount === 1 ? interrupted.promise : freshResult;
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const context = contextWithClient(client, { connected: true });
    const page = createPage("openclaw-usage-page", context) as TestPage & {
      routeData: UsageRouteData;
      usageResult: UsageRouteData["result"];
      gateway: TestGatewayController;
      refreshPolicy: UsageRefreshPolicy;
    };
    page.routeData = usageRouteData(context, usageResult("cached"));

    document.body.append(page);
    await page.updateComplete;
    page.refreshPolicy.request("manual");
    await waitForFast(() => expect(usageRequestCount).toBe(1));
    applyPageGatewaySnapshot(page, {
      ...context.gateway.snapshot,
      phase: "stopped",
    });
    applyPageGatewaySnapshot(page, context.gateway.snapshot);

    await waitForFast(() =>
      expect(request.mock.calls.filter(([method]) => method === "sessions.usage")).toHaveLength(2),
    );
    await waitForFast(() => expect(page.usageResult).toBe(freshResult));
    interrupted.resolve(usageResult("stale"));
    await Promise.resolve();
    await Promise.resolve();
    expect(page.usageResult).toBe(freshResult);
  });

  it("gates same-client usage reconnects by payload age and page visibility", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.usage") {
        return usageResult();
      }
      if (method === "usage.status") {
        return { providers: [] };
      }
      return { daily: [] };
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const harness = contextWithMutableGateway(client);
    const result = usageResult();
    const page = createPage("openclaw-usage-page", harness.context) as TestPage & {
      routeData: UsageRouteData;
      readonly usageResult: UsageRouteData["result"];
      readonly usageLoading: boolean;
      refreshPolicy: UsageRefreshPolicy;
    };
    page.routeData = usageRouteData(harness.context, result);

    document.body.append(page);
    await page.updateComplete;
    expect(page.usageResult).toBe(result);

    harness.emitConnected(false);
    harness.emitConnected(true);
    expect(request).not.toHaveBeenCalled();

    page.refreshPolicy.setLastLoadedAtMs(Date.now() - USAGE_PAYLOAD_TTL_MS);
    visibility.mockReturnValue("hidden");
    harness.emitConnected(false);
    harness.emitConnected(true);
    expect(request).not.toHaveBeenCalled();

    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    await waitForFast(() => expect(page.usageLoading).toBe(false));
    const initialMethods = request.mock.calls.map(([method]) => method);
    expect(initialMethods).toHaveLength(2);
    expect(initialMethods).toEqual(expect.arrayContaining(["sessions.usage", "usage.status"]));

    page.refreshPolicy.request("manual");
    await waitForFast(() => expect(page.usageLoading).toBe(false));
    expect(request).toHaveBeenCalledTimes(4);

    const failedRefresh = deferred<never>();
    request.mockImplementationOnce(() => failedRefresh.promise);
    page.refreshPolicy.setLastLoadedAtMs(Date.now() - USAGE_PAYLOAD_TTL_MS);
    page.refreshPolicy.request("manual");
    expect(request).toHaveBeenCalledTimes(6);
    page.refreshPolicy.request("focus");
    failedRefresh.reject(new Error("connection interrupted"));
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(8));
    await waitForFast(() => expect(page.usageLoading).toBe(false));
  });

  it("discards Model Providers work from a replaced source that reuses its client", async () => {
    const staleAuth = deferred<unknown>();
    let authCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "models.authStatus") {
        authCalls += 1;
        return authCalls === 1 ? staleAuth.promise : { ts: 2, providers: [] };
      }
      if (method === "models.list") {
        return { models: [] };
      }
      if (method === "config.get") {
        return { config: {}, hash: "hash" };
      }
      if (method === "usage.status") {
        return { updatedAt: 2, providers: [] };
      }
      if (method === "sessions.usage") {
        return { aggregates: { byProvider: [] } };
      }
      return {};
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const agentsList = { defaultId: "main", agents: [{ id: "main" }] };
    const page = createModelProvidersPage(
      contextWithClient(client, { connected: true, agentsList, selectedAgentId: "main" }),
    );
    page.routeData = createEmptyModelProvidersRouteData(page.context);
    mountModelProvidersPage(page);
    await waitForFast(() => expect(authCalls).toBe(1));

    const previous = page.context.gateway.snapshot;
    createGatewayMetadataObserver(() => true).synchronize(previous, {
      ...previous,
      phase: "stopped",
    });
    unmountModelProvidersPage(page);
    page.context = contextWithClient(client, {
      connected: true,
      agentsList,
      selectedAgentId: "main",
    });
    mountModelProvidersPage(page);
    await page.updateComplete;
    await waitForFast(() => expect(page.state.data?.authStatus?.ts).toBe(2));

    staleAuth.resolve({ ts: 1, providers: [] });
    await Promise.resolve();
    await Promise.resolve();
    expect(page.state.data?.authStatus?.ts).toBe(2);
  });

  it("rejects Model Providers route data from an earlier same-client gateway epoch", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "models.authStatus") {
        return { ts: 2, providers: [] };
      }
      if (method === "models.list") {
        return { models: [] };
      }
      if (method === "config.get") {
        return { config: {}, hash: "fresh" };
      }
      if (method === "usage.status") {
        return { updatedAt: 2, providers: [] };
      }
      if (method === "sessions.usage") {
        return { aggregates: { byProvider: [] } };
      }
      return {};
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const context = contextWithClient(client, {
      connected: true,
      selectedAgentId: "main",
    });
    const staleData = { authStatus: { ts: 1, providers: [] } } as unknown as ModelProvidersData;
    const page = createModelProvidersPage(context);
    page.routeData = {
      gateway: context.gateway,
      gatewaySnapshot: { ...context.gateway.snapshot },
      data: staleData,
      client,
      agentId: "main",
      selectionIntentRevision: context.settingsAgentSelection.intentRevision,
    };

    mountModelProvidersPage(page);
    await waitForFast(() => expect(page.state.data?.authStatus?.ts).toBe(2));
    expect(page.state.data).not.toBe(staleData);
  });

  it("hydrates linked skill verdicts without reloading accepted route data", async () => {
    const verdict = {
      registry: "https://clawhub.ai",
      ok: true,
      decision: "pass",
      reasons: [],
      requestedSlug: "agentreceipt",
      requestedVersion: "1.2.3",
      securityStatus: "clean",
    };
    const request = vi.fn(async (method: string) => {
      if (method === "skills.library.list") {
        return emptySkillLibrary;
      }
      if (method === "skills.securityVerdicts") {
        return { schema: "openclaw.skills.security-verdicts.v1", items: [verdict] };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const context = contextWithClient(client, {
      connected: true,
      agentsList: { defaultId: "main", agents: [{ id: "main" }] },
      selectedAgentId: "main",
    });
    const mounted = mountSkillsPage(context, skillsRouteData(context, linkedSkillReport()));
    await waitForSolid(() =>
      expect(mounted.page.querySelector(".plugins-item")?.textContent).toContain("Clean"),
    );
    expect(mounted.page.textContent).toContain("Repo Skill");
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledWith("skills.library.list", { scope: "all" });
    expect(request).toHaveBeenCalledWith("skills.securityVerdicts", { agentId: "main" });
  });

  it("discards pending route verdicts when the connected gateway lifecycle ends", async () => {
    const pending = deferred<{ schema: string; items: unknown[] }>();
    const request = vi.fn(async (method: string) => {
      if (method === "skills.library.list") {
        return emptySkillLibrary;
      }
      if (method === "skills.securityVerdicts") {
        return pending.promise;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const harness = contextWithMutableGateway(client, {
      agentsList: { defaultId: "main", agents: [{ id: "main" }] },
      selectedAgentId: "main",
    });
    const mounted = mountSkillsPage(
      harness.context,
      skillsRouteData(harness.context, linkedSkillReport()),
    );
    await waitForSolid(() =>
      expect(mounted.page.querySelector(".plugins-item")?.textContent).toContain("Refreshing"),
    );
    harness.emitConnected(false);
    pending.resolve({
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
    });
    await pending.promise;
    await waitForSolid(() => expect(mounted.page.querySelector(".plugins-item")).toBeNull());
    expect(mounted.page.textContent).not.toContain("Clean");
    expect(mounted.page.textContent).not.toContain("Refreshing");
    expect(mounted.page.querySelector('[role="alert"]')).toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledWith("skills.library.list", { scope: "all" });
    expect(request).toHaveBeenCalledWith("skills.securityVerdicts", { agentId: "main" });
  });

  it("rejects skills route data from an earlier same-client gateway epoch", async () => {
    const freshReport = skillReport("Fresh skill");
    const request = vi.fn(async (method: string) => {
      if (method === "skills.library.list") {
        return emptySkillLibrary;
      }
      if (method === "skills.status") {
        return freshReport;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const context = contextWithClient(client, {
      connected: true,
      agentsList: { defaultId: "main", agents: [{ id: "main" }] },
      selectedAgentId: "main",
    });
    const mounted = mountSkillsPage(
      context,
      skillsRouteData(context, skillReport("Stale skill"), { ...context.gateway.snapshot }),
    );
    await waitForSolid(() => expect(mounted.page.textContent).toContain("Fresh skill"));
    expect(mounted.page.textContent).not.toContain("Stale skill");
  });

  it("clears sessions loaded by the previous provider", async () => {
    const client = {} as GatewayBrowserClient;
    const context = () => createSessionsContext(gatewayWithClient(client, false), createSessions());
    const page = await createSessionsPage(context());
    const row = { key: "old", sessionId: "old-session", kind: "direct" as const };
    page.result = sessionsResult([row], 1);
    page.selectedSessions = new Map([[row.key, row]]);

    const previous = page.context.gateway.snapshot;
    createGatewayMetadataObserver(() => true).synchronize(previous, {
      ...previous,
      phase: "stopped",
    });
    page.remove();
    page.context = context();
    reconnectPage(page);
    await page.updateComplete;

    expect(page.result).toBeNull();
    expect(page.selectedSessions.size).toBe(0);
  });

  it("clears usage loaded by the previous provider", async () => {
    const snapshot = cacheSnapshot("fresh");
    const result = { ...snapshot.result, sessions: [{ key: "old", usage: null }] };
    const providerUsage = {
      updatedAt: 1,
      providers: [{ provider: "old", displayName: "Old provider", windows: [] }],
    };
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.usage") {
        return result;
      }
      if (method === "usage.status") {
        return providerUsage;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const page = createPage(
      "openclaw-usage-page",
      contextWithClient(client, { connected: true }),
    ) as TestPage & {
      loadUsage: () => Promise<void>;
      readonly usageResult: UsageRouteData["result"];
      readonly usageCostSummary: UsageRouteData["costSummary"];
      readonly providerUsageSummary: unknown;
      usageSelectedSessions: string[];
    };
    document.body.append(page);
    await page.updateComplete;
    await page.loadUsage();
    expect(page.usageResult).toBe(result);
    expect(page.usageCostSummary).toMatchObject({
      totals: result.totals,
      daily: result.aggregates.costDaily,
    });
    expect(page.providerUsageSummary).toBe(providerUsage);
    page.usageSelectedSessions = ["old"];

    await replaceContext(page, client);

    expect(page.usageResult).toBeNull();
    expect(page.usageCostSummary).toBeNull();
    expect(page.providerUsageSummary).toBeNull();
    expect(page.usageSelectedSessions).toEqual([]);
  });

  it("clears skills and cached cards loaded by the previous provider", async () => {
    const report = skillReport("Old provider skill");
    report.skills[0]!.skillCard = { present: true, path: "/tmp/skill-card.md", sizeBytes: 20 };
    const request = vi.fn(async (method: string) => {
      if (method === "skills.library.list") {
        return emptySkillLibrary;
      }
      if (method === "skills.skillCard") {
        return { skillKey: "Old provider skill", content: "# Previous provider card" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const context = contextWithClient(client, {
      connected: true,
      agentsList: { defaultId: "main", agents: [{ id: "main" }] },
      selectedAgentId: "main",
    });
    const mounted = mountSkillsPage(context, skillsRouteData(context, report));
    await waitForSolid(() =>
      expect(
        mounted.page.querySelector('[aria-label="Open Old provider skill details"]'),
      ).not.toBeNull(),
    );
    mounted.page
      .querySelector<HTMLButtonElement>('[aria-label="Open Old provider skill details"]')!
      .click();
    await waitForSolid(() =>
      expect(mounted.page.querySelector("#skill-detail-tab-card")).not.toBeNull(),
    );
    mounted.page
      .querySelector<HTMLElement>("#skill-detail-tab-card")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    await waitForSolid(() => expect(mounted.page.textContent).toContain("Previous provider card"));
    mounted.replaceContext(contextWithClient(client));
    await waitForSolid(() => expect(mounted.page.textContent).not.toContain("Old provider skill"));
    expect(mounted.page.textContent).not.toContain("Previous provider card");
    expect(mounted.page.querySelector("#skill-detail-panel")).toBeNull();
  });

  it("discards an agent list from a replaced skills source that reuses its client", async () => {
    const pending = deferred<AgentsListResult | null>();
    const ensureList = vi.fn(() => pending.promise);
    const request = vi.fn(async (method: string) => {
      if (method === "skills.library.list") {
        return emptySkillLibrary;
      }
      if (method === "skills.status") {
        return skillReport("Replacement agent skill");
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const context = contextWithClient(client, { connected: true, ensureList });
    const mounted = mountSkillsPage(
      context,
      skillsRouteData(context, null, { ...context.gateway.snapshot }),
    );
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
    await waitForSolid(() => expect(mounted.page.textContent).toContain("Replacement agent skill"));
    pending.resolve({
      defaultId: "stale",
      mainKey: "agent:stale:main",
      scope: "all",
      agents: [{ id: "stale" }],
    } as unknown as AgentsListResult);
    await pending.promise;
    flush();
    expect(mounted.page.textContent).toContain("Replacement agent skill");
    expect(request).toHaveBeenCalledWith("skills.status", { agentId: "fresh" });
    expect(request).not.toHaveBeenCalledWith("skills.status", { agentId: "stale" });
  });

  it("clears logs loaded by the previous provider", async () => {
    const client = {} as GatewayBrowserClient;
    const page = createPage("openclaw-logs-page", contextWithClient(client)) as TestPage & {
      logsEntries: unknown[];
      logsFile: string | null;
      logsCursor: number | null;
    };
    document.body.append(page);
    await page.updateComplete;
    page.logsEntries = [{ raw: "old" }];
    page.logsFile = "/old/provider.log";
    page.logsCursor = 42;

    await replaceContext(page, client);

    expect(page.logsEntries).toEqual([]);
    expect(page.logsFile).toBeNull();
    expect(page.logsCursor).toBeNull();
  });

  it("discards diagnostics from a replaced provider that reuses its client", async () => {
    const pending = deferred<unknown>();
    const request = vi.fn(() => pending.promise);
    const client = { request } as unknown as GatewayBrowserClient;
    const context = contextWithClient(client, { connected: true });
    const page = createPage("openclaw-debug-page", context) as TestPage & {
      debugStatus: unknown;
      debugHealth: unknown;
      debugModels: unknown[];
      debugHeartbeat: unknown;
      debugLanes: unknown[];
      debugDiagnosticsError: string | null;
      diagnosticsTask: { readonly status: TaskStatus };
    };
    document.body.append(page);
    await page.updateComplete;

    await waitForFast(() => expect(request).toHaveBeenCalledTimes(4));
    page.debugDiagnosticsError = "old diagnostics failure";
    await replaceContext(page, client);
    pending.resolve({ models: [{ id: "stale" }], stale: true });
    await pending.promise;
    await settleLitElement(page);

    expect(request).toHaveBeenCalledTimes(4);
    expect(page.diagnosticsTask.status).not.toBe(TaskStatus.PENDING);
    expect(page.debugStatus).toBeNull();
    expect(page.debugHealth).toBeNull();
    expect(page.debugModels).toEqual([]);
    expect(page.debugHeartbeat).toBeNull();
    expect(page.debugLanes).toEqual([]);
    expect(page.debugDiagnosticsError).toBeNull();
  });
});
