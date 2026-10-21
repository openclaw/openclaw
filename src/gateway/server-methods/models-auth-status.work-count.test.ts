import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveAgentDir } from "../../agents/agent-scope-config.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "../../agents/auth-profiles.js";
import * as authProfileSnapshots from "../../agents/auth-profiles/runtime-snapshots.js";
import { authStore, oauth } from "../../agents/model-catalog-fixtures.test-support.js";
import type { UsageSummary } from "../../infra/provider-usage.types.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { resolveProviderAuthLookupMaps } from "../../secrets/provider-env-vars.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { createOpenAiCodexOauthHealthSummary } from "./models-auth-status.health.test-support.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

// Config publication replaces the object, so every read shares one unchanged config.
const config = {};
const agentDir = resolveAgentDir(config, "main");
const store = authStore({ "openai:default": oauth("openai", 1_000_000) });

const mocks = vi.hoisted(() => ({
  buildAuthHealthSummary: vi.fn(),
  loadDeferredCatalog: vi.fn(),
  readPreparedCatalog: vi.fn(),
  loadProviderUsageSummary: vi.fn(
    async ({ providers }: { providers: string[] }): Promise<UsageSummary> => ({
      updatedAt: 0,
      providers: providers.map((provider) => ({
        provider,
        displayName: provider,
        windows: [{ label: "5h", usedPercent: 10 }],
      })),
    }),
  ),
  listProviderUsagePluginDescriptors: vi.fn(() => [
    { provider: "anthropic", displayName: "Claude" },
    { provider: "deepseek", displayName: "DeepSeek" },
    { provider: "openai", displayName: "OpenAI" },
  ]),
}));

vi.mock("../../agents/auth-health.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/auth-health.js")>()),
  buildAuthHealthSummary: mocks.buildAuthHealthSummary,
}));
// mock-isolation: count provider usage probes without querying real provider accounts.
vi.mock("../../infra/provider-usage.load.js", () => ({
  loadProviderUsageSummary: mocks.loadProviderUsageSummary,
}));
vi.mock("../../plugins/provider-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/provider-runtime.js")>()),
  listProviderUsagePluginDescriptors: mocks.listProviderUsagePluginDescriptors,
}));
vi.mock("../server-model-catalog-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server-model-catalog-auth.js")>()),
  loadDeferredCatalog: mocks.loadDeferredCatalog,
  readPreparedCatalog: mocks.readPreparedCatalog,
}));

import { clearModelAuthStatusUsageCache } from "./models-auth-status-usage-cache.js";
import { modelsAuthStatusHandlers } from "./models-auth-status.js";
import type { ModelAuthStatusResult } from "./models-auth-status.types.js";
import { usageHandlers } from "./usage.js";

const authStatus = modelsAuthStatusHandlers["models.authStatus"]!;
const usageStatus = usageHandlers["usage.status"]!;

function createOptions(method: string) {
  const respond = vi.fn();
  return {
    req: { type: "req", id: method, method, params: {} },
    params: {},
    client: { connect: { scopes: ["operator.admin"] } },
    isWebchatConnect: () => false,
    respond,
    context: { getRuntimeConfig: () => config },
  } as unknown as GatewayRequestHandlerOptions & { respond: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  for (const name of Object.values(
    resolveProviderAuthLookupMaps({ env: {} }).envCandidateMap,
  ).flat()) {
    vi.stubEnv(name, "");
  }
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.clearAllMocks();
  clearModelAuthStatusUsageCache();
  // usage.status resolves the agent directory without the prepared owner; both must agree.
  replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store }]);
  vi.spyOn(authProfileSnapshots, "refreshRuntimeAuthProfileStoreSources").mockResolvedValue();
  mocks.readPreparedCatalog.mockResolvedValue({
    agentId: "main",
    agentDir,
    workspaceDir: "/tmp/workspace",
    config,
    authStore: store,
    metadataSnapshot: createPluginMetadataSnapshotFixture(),
  });
  mocks.buildAuthHealthSummary.mockReturnValue(createOpenAiCodexOauthHealthSummary());
});

afterEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("serves repeated Models page loads from one auth and usage refresh per provider set", async () => {
  // The page reads models.authStatus (refreshable credentials) and usage.status
  // (every usage provider) together; #174741 made each read evict the other's refresh.
  const loadPage = async () => {
    const auth = createOptions("models.authStatus");
    const usage = createOptions("usage.status");
    const scope = new AsyncWorkScope();
    await Promise.all([scope.track(() => authStatus(auth)), scope.track(() => usageStatus(usage))]);
    await scope.drain();
    return {
      auth: auth.respond.mock.calls[0]?.[1] as ModelAuthStatusResult,
      usage: usage.respond.mock.calls[0]?.[1] as UsageSummary,
    };
  };
  // Concurrent cold reads may each prepare a runtime snapshot before one is published.
  await loadPage();
  await loadPage();
  const work = () => ({
    probes: mocks.loadProviderUsageSummary.mock.calls
      .map(([call]) => call.providers)
      .toSorted((left, right) => left.length - right.length),
    healthBuilds: mocks.buildAuthHealthSummary.mock.calls.length,
    descriptorScans: mocks.listProviderUsagePluginDescriptors.mock.calls.length,
    catalogLoads: mocks.loadDeferredCatalog.mock.calls.length,
  });
  const warm = work();
  expect(warm).toMatchObject({
    probes: [["openai"], ["anthropic", "deepseek", "openai"]],
    healthBuilds: 1,
    catalogLoads: 0,
  });
  for (let load = 0; load < 3; load += 1) {
    const page = await loadPage();
    expect(page.auth.providers[0]?.usage?.windows[0]?.usedPercent).toBe(10);
    expect(page.usage.providers).toContainEqual(expect.objectContaining({ provider: "openai" }));
  }
  expect(work()).toEqual(warm);
});
