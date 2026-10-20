import fs from "node:fs/promises";
import path from "node:path";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { ModelProviderConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as embeddedStateLock from "../../infra/embedded-state-lock.js";
import { acquireGatewayLock, type GatewayLockOptions } from "../../infra/gateway-lock.js";

const acquireNativeStateLock = embeddedStateLock.acquireEmbeddedStateLock;
afterEach(() => vi.restoreAllMocks());

type ProbeModule = typeof import("./list.probe.js");
type ProbeParams = Parameters<ProbeModule["runAuthProbes"]>[0];
type RunnerParams = Parameters<
  typeof import("../../agents/isolated-completion.js").runIsolatedCompletion
>[0];
const mocks = vi.hoisted(() => ({
  credential: "profile" as "profile" | "literal" | "marker",
  allowInferenceImport: false,
  runner: vi.fn<(params: RunnerParams) => Promise<{ text: string }>>(),
  readCatalog: vi.fn<() => Promise<Array<{ provider: string; id: string }>>>(),
  upsert: vi.fn(async (params: { profileId: string; credential: unknown }) => ({
    version: 1,
    profiles: { [params.profileId]: params.credential },
  })),
}));
const profileIds = () => (mocks.credential === "marker" ? [] : ["openai:profile"]);
const envKey = { apiKey: "envkey", source: "OPENAI_API_KEY" };

// The factory must remain unloaded until a probe actually dispatches inference.
// mock-isolation: Probe tests use fixture-owned credentials, catalog rows, and inference dispatch without provider calls.
vi.doMock("../../agents/isolated-completion.js", () => {
  assert(mocks.allowInferenceImport, "isolated-completion should stay lazy for probe imports");
  return { runIsolatedCompletion: mocks.runner };
});
// mock-isolation: Credentials and catalog rows are fixture-owned; inference never starts.
vi.doMock("../../agents/auth-profiles.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/auth-profiles.js")>()),
  externalCliDiscoveryScoped: () => undefined,
  ensureAuthProfileStoreAsync: async () => ({
    version: 1,
    order: {},
    profiles: Object.fromEntries(
      profileIds().map((id) => [
        id,
        {
          type: "api_key",
          provider: "openai",
          key: "test-profile-key",
        },
      ]),
    ),
  }),
  listProfilesForProvider: profileIds,
  resolveAuthProfileDisplayLabel: ({ profileId }: { profileId: string }) => profileId,
  resolveAuthProfileEligibility: () => ({ eligible: true }),
  upsertAuthProfileWithLock: mocks.upsert,
}));
// mock-isolation: Probe tests use fixture-owned credentials, catalog rows, and inference dispatch without provider calls.
vi.doMock("../../agents/model-auth.js", () => ({
  hasUsableCustomProviderApiKey: () => mocks.credential !== "profile",
  resolveEnvApiKey: () => (mocks.credential === "marker" ? envKey : null),
  resolveProviderEntryApiKeyBinding: vi.fn(),
  resolveProviderEntryApiKeyProfileReference: () =>
    mocks.credential === "literal"
      ? { kind: "literal", apiKey: "test", source: "models.json" }
      : { kind: mocks.credential === "marker" ? "marker" : "none" },
  resolveUsableCustomProviderApiKey: () => {
    assert(mocks.credential === "marker", "only markers use runtime credential resolution");
    return envKey;
  },
}));
// mock-isolation: Probe tests use fixture-owned credentials, catalog rows, and inference dispatch without provider calls.
vi.doMock("../../agents/prepared-model-catalog.js", () => ({
  readPreparedModelCatalog: mocks.readCatalog,
}));
const probe = await importFreshModule<ProbeModule>(
  import.meta.url,
  `./list.probe.js?scope=${Math.random().toString(36).slice(2)}`,
);
mocks.allowInferenceImport = true;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.credential = "profile";
  mocks.runner.mockReset().mockImplementation(async (params) => {
    params.onRequestComplete?.(13);
    return { text: "OK" };
  });
  mocks.readCatalog.mockReset().mockResolvedValue([{ provider: "openai", id: "gpt-5.5" }]);
});
afterAll(() => {
  vi.doUnmock("../../agents/isolated-completion.js");
  vi.doUnmock("../../agents/auth-profiles.js");
  vi.doUnmock("../../agents/model-auth.js");
  vi.doUnmock("../../agents/prepared-model-catalog.js");
});

function providerConfig(overrides: Partial<ModelProviderConfig>): ModelProviderConfig {
  return { baseUrl: "https://api.openai.com/v1", models: [], ...overrides };
}
const config = (provider: ModelProviderConfig): OpenClawConfig => ({
  models: { providers: { openai: provider } },
});
function probeInput(cfg: OpenClawConfig, options: Partial<ProbeParams["options"]>): ProbeParams {
  return {
    cfg,
    agentId: "probe-agent",
    agentDir: "/tmp/openclaw-probe-agent",
    workspaceDir: "/tmp/openclaw-probe-workspace",
    providers: ["openai"],
    modelCandidates: ["openai/gpt-5.5"],
    options: { provider: "openai", timeoutMs: 5_000, concurrency: 1, maxTokens: 8, ...options },
  };
}

it("maps failover reasons to probe statuses", () => {
  for (const [reason, expected] of [
    ["auth_permanent", "auth"],
    ["auth", "auth"],
    ["rate_limit", "rate_limit"],
    ["overloaded", "rate_limit"],
    ["billing", "billing"],
    ["timeout", "timeout"],
    ["model_not_found", "format"],
    ["format", "format"],
    [undefined, "unknown"],
    [null, "unknown"],
    ["something_else", "unknown"],
  ]) {
    expect(probe.mapFailoverReasonToProbeStatus(reason)).toBe(expected);
  }
});

it("refuses CLI probes while a live Gateway owns canonical state", async () => {
  const stateDir = tempDirs.make("openclaw-model-probe-lock-");
  const lockOptions: GatewayLockOptions = {
    allowInTests: true,
    env: {
      ...process.env,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_STATE_DIR: stateDir,
    },
    lockDir: path.join(stateDir, "gateway-locks"),
    readProcessStartTime: () => 123_456,
    timeoutMs: 100,
  };
  vi.spyOn(embeddedStateLock, "acquireEmbeddedStateLock").mockImplementation((params) =>
    acquireNativeStateLock({ ...params, options: lockOptions }),
  );
  const lock = await acquireGatewayLock({ ...lockOptions, port: 28789 });
  assert(lock, "Expected live Gateway fixture lock");
  try {
    await expect(
      probe.withAuthProbeStateOwnership({ mode: "exclusive" }, async () => undefined),
    ).rejects.toThrow(
      `A Gateway is running for this state directory (pid ${process.pid}, port 28789). Stop the Gateway first (openclaw gateway stop), then rerun models status --probe.`,
    );
  } finally {
    await lock.release();
  }
});

it.each([false, true])("reports request-only timing (provider config: %s)", async (configured) => {
  mocks.readCatalog.mockRejectedValue(new Error("Catalog unavailable"));
  const input = probeInput(
    configured ? config(providerConfig({ agentRuntime: { id: "codex" } })) : {},
    { profileIds: ["openai:profile"] },
  );
  expect((await probe.runAuthProbes(input)).results[0]).toMatchObject({
    status: "ok",
    latencyMs: 13,
  });
  expect(mocks.runner).toHaveBeenCalledWith(
    expect.objectContaining({
      authProfileId: "openai:profile",
      outputTextPolicy: "strict-visible",
      agentHarnessRuntimeOverride: "openclaw",
      thinkLevel: "off",
    }),
  );
  expect(mocks.runner.mock.calls[0]?.[0].preparedModelRuntimeMode).toBeUndefined();
  mocks.runner.mockRejectedValueOnce(
    new Error(configured ? "LLM request timed out." : "Credential preparation failed"),
  );
  const failed = (await probe.runAuthProbes(input)).results[0];
  if (configured) {
    expect(failed).toMatchObject({ status: "timeout" });
  } else {
    expect(failed?.status).not.toBe("ok");
  }
  expect(failed?.latencyMs).toBeUndefined();
});

it.each(["literal", "marker"] as const)(
  "isolates %s credentials from stored profiles",
  async (credential) => {
    mocks.credential = credential;
    const literal = credential === "literal";
    const provider = providerConfig({
      api: "openai-responses",
      apiKey: literal ? "test" : ["OPENAI", "API", "KEY"].join("_"),
      ...(literal ? ({ auth: "oauth", agentRuntime: { id: "codex" } } as const) : {}),
    });
    await probe.runAuthProbes(probeInput(config(provider), { includeDirectKeys: true }));
    const call = literal
      ? mocks.runner.mock.calls.find(([params]) =>
          params.authProfileId?.startsWith("openai:probe-"),
        )?.[0]
      : mocks.runner.mock.calls[0]?.[0];
    assert(call?.agentDir);
    expect(call.agentDir).not.toBe("/tmp/openclaw-probe-agent");
    expect(call).toMatchObject({
      preparedModelRuntimeMode: "isolated-read-only",
      config: { models: { providers: { openai: provider } }, auth: { order: { openai: [] } } },
    });
    if (literal) {
      expect(call).toMatchObject({
        agentHarnessRuntimeOverride: "openclaw",
        onRequestComplete: expect.any(Function),
      });
      expect(mocks.upsert).toHaveBeenCalledWith({
        profileId: call.authProfileId,
        agentDir: call.agentDir,
        credential: expect.objectContaining({ type: "oauth", provider: "openai", access: "test" }),
      });
      await expect(fs.stat(call.agentDir)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(call.agentDir).toContain("openclaw-auth-probe-");
      expect(call.authProfileId).toBeUndefined();
      expect(mocks.upsert).not.toHaveBeenCalled();
    }
  },
);
