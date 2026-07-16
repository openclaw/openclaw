/* @vitest-environment jsdom */

import { nothing } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionUsageTimeSeries } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { SessionLogEntry } from "./types.ts";
import "./usage-page.ts";

type TestUsagePage = HTMLElement & {
  context: ApplicationContext;
  client: GatewayBrowserClient | null;
  connected: boolean;
  usageSelectedSessions: string[];
  usageTimeSeries: SessionUsageTimeSeries | null;
  usageTimeSeriesLoading: boolean;
  usageTimeSeriesError: string | null;
  usageSessionLogs: SessionLogEntry[] | null;
  usageSessionLogsLoading: boolean;
  usageSessionLogsError: string | null;
  loadSessionTimeSeries: (sessionKey: string) => Promise<void>;
  loadSessionLogs: (sessionKey: string) => Promise<void>;
  render: () => unknown;
  readonly updateComplete: Promise<boolean>;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function contextWithClient(client: GatewayBrowserClient): ApplicationContext {
  const subscribe = () => () => undefined;
  const snapshot = {
    client,
    connected: true,
    reconnecting: false,
    hello: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  } as ApplicationGatewaySnapshot;
  return {
    basePath: "",
    gateway: {
      snapshot,
      subscribe,
    },
    agents: {
      state: { agentsList: null, agentsLoading: false, agentsError: null },
      ensureList: vi.fn(async () => null),
      subscribe,
    },
    agentSelection: {
      state: { selectedId: null, scopeId: null },
      set: vi.fn(),
      setScope: vi.fn(),
      subscribe,
    },
    navigate: vi.fn(),
    preload: vi.fn(async () => undefined),
  } as unknown as ApplicationContext;
}

async function createPage(client: GatewayBrowserClient): Promise<TestUsagePage> {
  const page = document.createElement("openclaw-usage-page") as TestUsagePage;
  page.context = contextWithClient(client);
  page.render = () => nothing;
  document.body.append(page);
  await page.updateComplete;
  page.client = client;
  page.connected = true;
  page.usageSelectedSessions = ["agent:main:detail"];
  return page;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("UsagePage detail requests", () => {
  it("surfaces a time-series failure and clears it while retrying", async () => {
    const retry = deferred<SessionUsageTimeSeries>();
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("timeline unavailable"))
      .mockReturnValueOnce(retry.promise);
    const page = await createPage({ request } as unknown as GatewayBrowserClient);

    await page.loadSessionTimeSeries("agent:main:detail");
    expect(page.usageTimeSeriesError).toBe("timeline unavailable");
    expect(page.usageTimeSeriesLoading).toBe(false);
    expect(page.usageTimeSeries).toBeNull();

    const retryLoad = page.loadSessionTimeSeries("agent:main:detail");
    expect(page.usageTimeSeriesError).toBeNull();
    expect(page.usageTimeSeriesLoading).toBe(true);
    const result = { points: [] } as unknown as SessionUsageTimeSeries;
    retry.resolve(result);
    await retryLoad;

    expect(page.usageTimeSeries).toBe(result);
    expect(page.usageTimeSeriesError).toBeNull();
    expect(page.usageTimeSeriesLoading).toBe(false);
  });

  it("surfaces a session-log failure and clears it after a successful retry", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("logs unavailable"))
      .mockResolvedValueOnce({
        logs: [{ timestamp: 1, role: "user", content: "hello" }],
      });
    const page = await createPage({ request } as unknown as GatewayBrowserClient);

    await page.loadSessionLogs("agent:main:detail");
    expect(page.usageSessionLogsError).toBe("logs unavailable");
    expect(page.usageSessionLogsLoading).toBe(false);
    expect(page.usageSessionLogs).toBeNull();

    await page.loadSessionLogs("agent:main:detail");
    expect(page.usageSessionLogs).toEqual([{ timestamp: 1, role: "user", content: "hello" }]);
    expect(page.usageSessionLogsError).toBeNull();
    expect(page.usageSessionLogsLoading).toBe(false);
  });
});
