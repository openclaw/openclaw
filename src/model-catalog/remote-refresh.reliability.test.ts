import { readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { CatalogWorkerTaskPool } from "../agents/prepared-model-catalog-worker.pool.js";
import { createGatewayUpdateLifecycle } from "../infra/update-check-lifecycle.js";
import { createGatewayUpdateCheck } from "../infra/update-startup-scheduler.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import * as bundledStamp from "./bundled-catalog-stamp.js";
import { refreshRemoteModelCatalog } from "./remote-refresh.js";

const guards = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
  fetchConfiguredLocalOriginWithSsrFGuard: vi.fn(),
}));
const engine = vi.hoisted(() => ({ failSetup: false }));
const refreshMock = vi.hoisted(() => ({
  impl: undefined as undefined | ((...args: unknown[]) => Promise<unknown>),
}));

vi.mock("../infra/net/fetch-guard.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/net/fetch-guard.js")>(
    "../infra/net/fetch-guard.js",
  );
  return {
    ...actual,
    fetchWithSsrFGuard: guards.fetchWithSsrFGuard,
    fetchConfiguredLocalOriginWithSsrFGuard: guards.fetchConfiguredLocalOriginWithSsrFGuard,
  };
});

vi.mock("../infra/database-engine/context.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/database-engine/context.js")>(
    "../infra/database-engine/context.js",
  );
  return {
    ...actual,
    getDatabaseEngineSelection: () => {
      if (engine.failSetup) {
        throw new Error("catalog worker setup failed");
      }
      return actual.getDatabaseEngineSelection();
    },
  };
});

// mock-isolation: exercise catalog scheduling without starting package-update discovery.
vi.mock("../infra/update-startup.js", () => ({
  runGatewayUpdateCheck: vi.fn(async () => undefined),
  resolveCheckIntervalMs: () => 60 * 60_000,
}));

vi.mock("./remote-refresh.js", async () => {
  const actual = await vi.importActual<typeof import("./remote-refresh.js")>("./remote-refresh.js");
  refreshMock.impl = (...args: unknown[]) =>
    actual.refreshRemoteModelCatalog(
      ...(args as Parameters<typeof actual.refreshRemoteModelCatalog>),
    );
  return {
    ...actual,
    refreshRemoteModelCatalog: vi.fn((...args: unknown[]) => refreshMock.impl?.(...args)),
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const bundle = {
  schemaVersion: 2,
  generatedAt: 1_753_500_000_000,
  minVersion: "2026.7.0",
  sourceCommit: "abc123",
  providers: { anthropic: {} },
  models: [{ id: "claude-test", provider: "anthropic", pricing: { status: "unknown" } }],
};
const policyConfig = {
  tools: { web: { fetch: { ssrfPolicy: { allowRfc2544BenchmarkRange: true } } } },
};

function databaseOptions() {
  return { path: path.join(tempDirs.make("openclaw-refresh-"), "state.sqlite") };
}

function okGuard(url: string) {
  return {
    response: new Response(JSON.stringify(bundle), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    finalUrl: url,
    release: vi.fn(async () => undefined),
  };
}

async function listCatalogTempDirs(root: string): Promise<string[]> {
  const found: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      continue;
    }
    let names: string[];
    try {
      names = await readdir(current);
    } catch {
      continue;
    }
    for (const name of names) {
      const filename = path.join(current, name);
      if (name.startsWith("openclaw-model-catalog-")) {
        found.push(filename);
      }
      pending.push(filename);
    }
  }
  return found;
}

describe("remote model catalog refresh reliability", () => {
  beforeEach(() => {
    engine.failSetup = false;
    guards.fetchWithSsrFGuard.mockReset();
    guards.fetchConfiguredLocalOriginWithSsrFGuard.mockReset();
    vi.mocked(refreshRemoteModelCatalog).mockImplementation(
      (...args: unknown[]) =>
        refreshMock.impl?.(...args) as ReturnType<typeof refreshRemoteModelCatalog>,
    );
    vi.spyOn(bundledStamp, "bundledCatalogGeneratedAt").mockReturnValue(bundle.generatedAt - 1);
  });

  afterEach(async () => {
    await closeStateDatabaseForTest();
    vi.restoreAllMocks();
  });

  it("passes the configured fetch policy into the default catalog refresh", async () => {
    guards.fetchWithSsrFGuard.mockRejectedValue(new Error("blocked benchmark range"));
    const result = await refreshRemoteModelCatalog({
      config: policyConfig,
      databaseOptions: databaseOptions(),
      force: true,
    });
    expect(result.status).toBe("error");
    expect(guards.fetchWithSsrFGuard).toHaveBeenCalledTimes(1);
    expect(guards.fetchWithSsrFGuard.mock.calls[0]?.[0]).toMatchObject({
      requireHttps: true,
      policy: { allowRfc2544BenchmarkRange: true },
    });
    expect(guards.fetchConfiguredLocalOriginWithSsrFGuard).not.toHaveBeenCalled();
  });

  it("keeps a successful default refresh on one guarded fetch", async () => {
    guards.fetchWithSsrFGuard.mockImplementation(async (params: { url: string }) =>
      okGuard(params.url),
    );
    const result = await refreshRemoteModelCatalog({
      config: {},
      databaseOptions: databaseOptions(),
      force: true,
    });
    expect(result).toMatchObject({ status: "updated", providers: 1, models: 1 });
    expect(guards.fetchWithSsrFGuard).toHaveBeenCalledTimes(1);
    expect(guards.fetchWithSsrFGuard.mock.calls[0]?.[0]).toMatchObject({ requireHttps: true });
    expect(guards.fetchWithSsrFGuard.mock.calls[0]?.[0].policy).toBeUndefined();
  });

  it("stops a failing catalog refresh after a bounded number of retries", async () => {
    vi.mocked(refreshRemoteModelCatalog).mockResolvedValue({
      status: "fresh",
      providers: 1,
      models: 1,
      generatedAt: bundle.generatedAt,
      nextCheckInMs: 0,
    });
    const clock = createGatewaySchedulerClock(Date.parse("2026-01-17T10:00:00Z"));
    const check = createGatewayUpdateCheck({
      lifecycle: createGatewayUpdateLifecycle(createTestGatewayScheduler(clock.clock)),
      getConfig: () => ({}),
      applyRemoteCatalogUpdate: async () => {
        throw new Error("catalog adoption failed");
      },
      log: { info: vi.fn() },
      isNixMode: false,
    });
    vi.mocked(refreshRemoteModelCatalog).mockClear();
    check.start();
    try {
      await clock.advanceBy(0);
      expect(refreshRemoteModelCatalog).toHaveBeenCalledTimes(1);
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await clock.advanceBy(1_000);
      }
      expect(vi.mocked(refreshRemoteModelCatalog).mock.calls.length).toBeGreaterThan(1);
      expect(vi.mocked(refreshRemoteModelCatalog).mock.calls.length).toBeLessThanOrEqual(3);
    } finally {
      await check.stop();
    }
  });

  it("removes the catalog temp directory when worker setup fails", async () => {
    const stateDir = tempDirs.make("openclaw-catalog-worker-");
    engine.failSetup = true;
    const pool = new CatalogWorkerTaskPool({ OPENCLAW_STATE_DIR: stateDir }, () => undefined);
    try {
      await expect(pool.run({}, {})).rejects.toThrow(/catalog worker setup failed/);
    } finally {
      await pool.close().catch(() => undefined);
    }
    await vi.waitFor(
      async () => {
        expect(await listCatalogTempDirs(stateDir)).toEqual([]);
      },
      { timeout: 5_000, interval: 20 },
    );
  });
});
