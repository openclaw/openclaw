/* @vitest-environment jsdom */

import { TaskStatus } from "@lit/task";
import type { SkillsLibraryListResult } from "@openclaw/gateway-protocol";
import { nothing } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../app/context.ts";
import { createGatewayMetadataObserver } from "../app/gateway-observers.ts";
import { clawhubVerdictKey } from "../lib/skills/index.ts";
import { settleLitElement } from "../test-helpers/lit-settle.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import type { ModelProvidersData } from "./model-providers/load.ts";
import { createEmptyModelProvidersRouteData } from "./model-providers/model-providers-page.test-support.ts";
import type { ModelProvidersRouteData } from "./model-providers/route.ts";
import type { SkillsRouteData } from "./skills/skills-page.ts";
import { createSkill } from "./skills/view.test-support.ts";
import type { UsageRefreshPolicy } from "./usage/refresh-policy.ts";
import { cacheSnapshot } from "./usage/usage-page.test-support.ts";
import type { UsageRouteData } from "./usage/usage-page.ts";
import "./cron/cron-page.ts";
import "./debug/debug-page.ts";
import "./logs/logs-page.ts";
import "./model-providers/model-providers-page.ts";
import "./sessions/sessions-page.ts";
import "./skills/skills-page.ts";
import "./tasks/tasks-page.ts";
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

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("gateway source replacement across reconnect with a reused client", () => {
  it("preserves matching usage route data on the first bind", async () => {
    const request = vi.fn();
    const client = { request } as unknown as GatewayBrowserClient;
    const context = contextWithClient(client, { connected: true });
    const result = usageResult("old");
    const routeData = {
      gateway: context.gateway,
      gatewaySnapshot: context.gateway.snapshot,
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
    } satisfies UsageRouteData;
    const page = createPage("openclaw-usage-page", context) as TestPage & {
      routeData: UsageRouteData;
      usageResult: UsageRouteData["result"];
    };
    page.routeData = routeData;

    document.body.append(page);
    await page.updateComplete;

    expect(page.usageResult).toBe(result);
    expect(request).not.toHaveBeenCalled();
  });

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
    page.routeData = {
      gateway: context.gateway,
      gatewaySnapshot: { ...context.gateway.snapshot },
      query: {
        startDate: "2026-07-08",
        endDate: "2026-07-08",
        scope: "family",
        timeZone: "local",
        agentId: null,
      },
      result: staleResult,
      costSummary: null,
      providerUsage: settledEmptyProviderUsage,
      loadedAtMs: Date.now(),
      error: null,
    };

    document.body.append(page);
    await page.updateComplete;
    await waitForFast(() => expect(page.usageResult).toBe(freshResult));

    expect(page.usageResult).not.toBe(staleResult);
  });

  it("keeps loaded usage data across a same-client reconnect", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const request = vi.fn();
    const client = { request } as unknown as GatewayBrowserClient;
    const context = contextWithClient(client, { connected: true });
    const result = usageResult("cached");
    const page = createPage("openclaw-usage-page", context) as TestPage & {
      routeData: UsageRouteData;
      gateway: TestGatewayController;
    };
    page.routeData = {
      gateway: context.gateway,
      gatewaySnapshot: context.gateway.snapshot,
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

    document.body.append(page);
    await page.updateComplete;
    applyPageGatewaySnapshot(page, {
      ...context.gateway.snapshot,
      phase: "stopped",
    });
    applyPageGatewaySnapshot(page, context.gateway.snapshot);
    await Promise.resolve();

    expect(request).not.toHaveBeenCalled();
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
    page.routeData = {
      gateway: context.gateway,
      gatewaySnapshot: context.gateway.snapshot,
      query: {
        startDate: "2026-07-08",
        endDate: "2026-07-08",
        scope: "family",
        timeZone: "local",
        agentId: null,
      },
      result: usageResult("cached"),
      costSummary: null,
      providerUsage: settledEmptyProviderUsage,
      loadedAtMs: Date.now(),
      error: null,
    };

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
      readonly usageLoading: boolean;
      refreshPolicy: UsageRefreshPolicy;
    };
    page.routeData = {
      gateway: harness.context.gateway,
      gatewaySnapshot: harness.context.gateway.snapshot,
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

    document.body.append(page);
    await page.updateComplete;

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
    const page = createPage(
      "openclaw-model-providers-page",
      contextWithClient(client, { connected: true, agentsList, selectedAgentId: "main" }),
    ) as TestPage & {
      data: ModelProvidersData | null;
      routeData: ModelProvidersRouteData;
    };
    page.routeData = createEmptyModelProvidersRouteData(page.context);
    document.body.append(page);
    await waitForFast(() => expect(authCalls).toBe(1));

    await replaceContext(page, client, { connected: true, agentsList, selectedAgentId: "main" });
    await waitForFast(() => expect(page.data?.authStatus?.ts).toBe(2));

    staleAuth.resolve({ ts: 1, providers: [] });
    await Promise.resolve();
    await Promise.resolve();
    expect(page.data?.authStatus?.ts).toBe(2);
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
    const agentsList = { defaultId: "main", agents: [{ id: "main" }] };
    const context = contextWithClient(client, {
      connected: true,
      agentsList,
      selectedAgentId: "main",
    });
    const staleData = { authStatus: { ts: 1, providers: [] } } as unknown as ModelProvidersData;
    const page = createPage("openclaw-model-providers-page", context) as TestPage & {
      routeData: ModelProvidersRouteData;
      data: ModelProvidersData | null;
    };
    page.routeData = {
      gateway: context.gateway,
      gatewaySnapshot: { ...context.gateway.snapshot },
      data: staleData,
      client,
      agentId: "main",
      selectionIntentRevision: context.settingsAgentSelection.intentRevision,
    };

    document.body.append(page);
    await waitForFast(() => expect(page.data?.authStatus?.ts).toBe(2));
    expect(page.data).not.toBe(staleData);
  });

  it("preserves matching skills route data while loading the viewer library", async () => {
    const request = vi.fn(async () => emptySkillLibrary);
    const client = { request } as unknown as GatewayBrowserClient;
    const agentsList = { defaultId: "main", agents: [{ id: "main" }] };
    const context = contextWithClient(client, {
      connected: true,
      agentsList,
      selectedAgentId: "main",
    });
    const report = { skills: [{ skillKey: "old" }] } as unknown as SkillsRouteData["report"];
    const routeData = {
      gateway: context.gateway,
      gatewaySnapshot: context.gateway.snapshot,
      agents: context.agents,
      agentsList,
      selectedAgentId: "main",
      selectionIntentRevision: context.settingsAgentSelection.intentRevision,
      report,
      error: null,
    } as unknown as SkillsRouteData;
    const page = createPage("openclaw-skills-page", context) as TestPage & {
      routeData: SkillsRouteData;
      skillsReport: SkillsRouteData["report"];
    };
    document.body.append(page);
    page.routeData = routeData;
    await page.updateComplete;

    expect(page.skillsReport).toBe(report);
    expect(request).toHaveBeenCalledExactlyOnceWith("skills.library.list", { scope: "all" });
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
    const agentsList = { defaultId: "main", agents: [{ id: "main" }] };
    const context = contextWithClient(client, {
      connected: true,
      agentsList,
      selectedAgentId: "main",
    });
    const report = {
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
    const page = createPage("openclaw-skills-page", context) as TestPage & {
      routeData: SkillsRouteData;
      skillsReport: SkillsRouteData["report"];
      clawhubVerdicts: Record<string, unknown>;
    };
    page.routeData = {
      gateway: context.gateway,
      gatewaySnapshot: context.gateway.snapshot,
      agents: context.agents,
      agentsList,
      selectedAgentId: "main",
      selectionIntentRevision: context.settingsAgentSelection.intentRevision,
      report,
      error: null,
    } as SkillsRouteData;

    document.body.append(page);
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("skills.securityVerdicts", { agentId: "main" }),
    );

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledWith("skills.library.list", { scope: "all" });
    expect(page.skillsReport).toBe(report);
    expect(
      page.clawhubVerdicts[
        clawhubVerdictKey({
          registry: "https://clawhub.ai",
          slug: "agentreceipt",
          version: "1.2.3",
        })
      ],
    ).toEqual(verdict);
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
    const agentsList = { defaultId: "main", agents: [{ id: "main" }] };
    const harness = contextWithMutableGateway(client, { agentsList, selectedAgentId: "main" });
    const report = {
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
    const page = createPage("openclaw-skills-page", harness.context) as TestPage & {
      routeData: SkillsRouteData;
      clawhubVerdicts: Record<string, unknown>;
      clawhubVerdictsLoading: boolean;
      clawhubVerdictsError: string | null;
    };
    page.routeData = {
      gateway: harness.context.gateway,
      gatewaySnapshot: harness.context.gateway.snapshot,
      agents: harness.context.agents,
      agentsList,
      selectedAgentId: "main",
      selectionIntentRevision: harness.context.settingsAgentSelection.intentRevision,
      report,
      error: null,
    } as SkillsRouteData;

    document.body.append(page);
    await waitForFast(() => expect(page.clawhubVerdictsLoading).toBe(true));
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
    await page.updateComplete;

    expect(page.clawhubVerdicts).toEqual({});
    expect(page.clawhubVerdictsLoading).toBe(false);
    expect(page.clawhubVerdictsError).toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledWith("skills.library.list", { scope: "all" });
    expect(request).toHaveBeenCalledWith("skills.securityVerdicts", { agentId: "main" });
  });

  it("defers fallback workspace skills loading until route data is initialized and invalidated", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "skills.library.list") {
        return emptySkillLibrary;
      }
      if (method === "skills.status") {
        return { skills: [] };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const agentsList = {
      defaultId: "main",
      mainKey: "main",
      scope: "global" as const,
      agents: [{ id: "main" }, { id: "research" }],
    };
    const context = contextWithClient(client, {
      connected: true,
      agentsList,
      selectedAgentId: "main",
    });
    const page = createPage("openclaw-skills-page", context) as TestPage & {
      routeData: SkillsRouteData;
    };

    document.body.append(page);
    await page.updateComplete;
    expect(request).toHaveBeenCalledExactlyOnceWith("skills.library.list", { scope: "all" });

    page.routeData = {
      gateway: context.gateway,
      gatewaySnapshot: { ...context.gateway.snapshot },
      agents: context.agents,
      agentsList,
      selectedAgentId: "main",
      selectionIntentRevision: context.settingsAgentSelection.intentRevision,
      report: null,
      error: null,
    };
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("skills.status", { agentId: "main" }),
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects skills route data from an earlier same-client gateway epoch", async () => {
    const freshReport = { skills: [{ skillKey: "fresh" }] } as unknown as SkillsRouteData["report"];
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
    const agentsList = { defaultId: "main", agents: [{ id: "main" }] };
    const context = contextWithClient(client, {
      connected: true,
      agentsList,
      selectedAgentId: "main",
    });
    const staleReport = { skills: [{ skillKey: "stale" }] } as unknown as SkillsRouteData["report"];
    const page = createPage("openclaw-skills-page", context) as TestPage & {
      routeData: SkillsRouteData;
      skillsReport: SkillsRouteData["report"];
    };
    page.routeData = {
      gateway: context.gateway,
      gatewaySnapshot: { ...context.gateway.snapshot },
      agents: context.agents,
      agentsList,
      selectedAgentId: "main",
      selectionIntentRevision: context.settingsAgentSelection.intentRevision,
      report: staleReport,
      error: null,
    } as unknown as SkillsRouteData;

    document.body.append(page);
    await page.updateComplete;
    await waitForFast(() => expect(page.skillsReport).toBe(freshReport));

    expect(page.skillsReport).not.toBe(staleReport);
  });

  it("clears sessions loaded by the previous provider", async () => {
    const client = {} as GatewayBrowserClient;
    const page = createPage("openclaw-sessions-page", contextWithClient(client)) as TestPage & {
      result: unknown;
      selectedKeys: Set<string>;
    };
    document.body.append(page);
    await page.updateComplete;
    page.result = { sessions: [{ key: "old" }] };
    page.selectedKeys = new Set(["old"]);

    await replaceContext(page, client);

    expect(page.result).toBeNull();
    expect(page.selectedKeys.size).toBe(0);
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

  it("clears skills loaded by the previous provider", async () => {
    const client = {} as GatewayBrowserClient;
    const page = createPage("openclaw-skills-page", contextWithClient(client)) as TestPage & {
      skillsReport: unknown;
      skillCardContents: Record<string, string>;
    };
    document.body.append(page);
    await page.updateComplete;
    page.skillsReport = { skills: [{ key: "old" }] };
    page.skillCardContents = { old: "stale" };

    await replaceContext(page, client);

    expect(page.skillsReport).toBeNull();
    expect(page.skillCardContents).toEqual({});
  });

  it("discards an agent list from a replaced skills source that reuses its client", async () => {
    const pending = deferred<SkillsRouteData["agentsList"]>();
    const ensureList = vi.fn(() => pending.promise);
    const request = vi.fn(async () => emptySkillLibrary);
    const client = { request } as unknown as GatewayBrowserClient;
    const context = contextWithClient(client, { connected: true, ensureList });
    const page = createPage("openclaw-skills-page", context) as TestPage & {
      loadAgents: () => Promise<void>;
    };
    document.body.append(page);
    await page.updateComplete;
    const load = page.loadAgents();
    await waitForFast(() => expect(ensureList).toHaveBeenCalled());
    const replacementAgents = {
      defaultId: "fresh",
      mainKey: "agent:fresh:main",
      scope: "all",
      agents: [{ id: "fresh" }],
    } as unknown as NonNullable<SkillsRouteData["agentsList"]>;
    await replaceContext(page, client, { connected: true, agentsList: replacementAgents });

    pending.resolve({
      defaultId: "stale",
      mainKey: "agent:stale:main",
      scope: "all",
      agents: [{ id: "stale" }],
    } as unknown as NonNullable<SkillsRouteData["agentsList"]>);
    await load;

    expect(page.context.agents.state.agentsList).toBe(replacementAgents);
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

  it("clears diagnostics data and errors loaded by the previous provider", async () => {
    const client = {} as GatewayBrowserClient;
    const page = createPage("openclaw-debug-page", contextWithClient(client)) as TestPage & {
      debugStatus: unknown;
      debugHealth: unknown;
      debugModels: unknown[];
      debugHeartbeat: unknown;
      debugDiagnosticsError: string | null;
    };
    document.body.append(page);
    await page.updateComplete;
    page.debugStatus = { version: "old" };
    page.debugHealth = { ok: true };
    page.debugModels = [{ id: "old" }];
    page.debugHeartbeat = { provider: "old" };
    page.debugDiagnosticsError = "old diagnostics failure";

    await replaceContext(page, client);

    expect(page.debugStatus).toBeNull();
    expect(page.debugHealth).toBeNull();
    expect(page.debugModels).toEqual([]);
    expect(page.debugHeartbeat).toBeNull();
    expect(page.debugDiagnosticsError).toBeNull();
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
      diagnosticsTask: { readonly status: TaskStatus };
    };
    document.body.append(page);
    await page.updateComplete;

    await waitForFast(() => expect(request).toHaveBeenCalledTimes(4));
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
  });

  it("clears cron data loaded by the previous provider", async () => {
    const client = {} as GatewayBrowserClient;
    const page = createPage("openclaw-cron-page", contextWithClient(client)) as TestPage & {
      cron: {
        client: GatewayBrowserClient | null;
        connected: boolean;
        cronStatus: unknown;
        cronJobs: unknown[];
      };
    };
    document.body.append(page);
    await page.updateComplete;
    page.cron = {
      ...page.cron,
      cronStatus: { enabled: true },
      cronJobs: [{ id: "old" }],
    };

    await replaceContext(page, client);

    expect(page.cron.cronStatus).toBeNull();
    expect(page.cron.cronJobs).toEqual([]);
  });

  it("clears tasks loaded by the previous provider", async () => {
    const client = {} as GatewayBrowserClient;
    const page = createPage("openclaw-tasks-page", contextWithClient(client)) as TestPage & {
      tasks: unknown[];
      error: string | null;
      cancellingTaskIds: Set<string>;
    };
    document.body.append(page);
    await page.updateComplete;
    page.tasks = [{ taskId: "old" }];
    page.error = "old error";
    page.cancellingTaskIds = new Set(["old"]);

    await replaceContext(page, client);

    expect(page.tasks).toEqual([]);
    expect(page.error).toBeNull();
    expect(page.cancellingTaskIds.size).toBe(0);
  });
});
