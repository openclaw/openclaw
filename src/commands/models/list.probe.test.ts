import fs from "node:fs";
import path from "node:path";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as embeddedStateLock from "../../infra/embedded-state-lock.js";
import { captureNativeSignalBridge } from "../../infra/embedded-state-lock.test-support.js";
import * as gatewayLockProcessModule from "../../infra/gateway-lock-process.js";
import { acquireGatewayLock, type GatewayLockOptions } from "../../infra/gateway-lock.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";

const acquireNativeStateLock = embeddedStateLock.acquireEmbeddedStateLock;
const createNativeBridge = embeddedStateLock.createEmbeddedStateSignalBridge;

type ProbeModule = typeof import("./list.probe.js");
type ProbeParams = Parameters<ProbeModule["runAuthProbes"]>[0];
type RunnerParams = Parameters<
  typeof import("../../agents/isolated-completion.js").runIsolatedCompletion
>[0];
const mocks = vi.hoisted(() => ({
  allowInferenceImport: false,
  runner: vi.fn<(params: RunnerParams) => Promise<{ text: string }>>(),
}));

// The factory must remain unloaded until a probe actually dispatches inference.
// mock-isolation: Probe tests use fixture-owned credentials, catalog rows, and inference dispatch without provider calls.
vi.doMock("../../agents/isolated-completion.js", () => {
  assert(mocks.allowInferenceImport, "isolated-completion should stay lazy for probe imports");
  return { runIsolatedCompletion: mocks.runner };
});
// Keep real persisted credentials, but never discover host CLI or provider credentials.
vi.doMock("../../agents/auth-profiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/auth-profiles.js")>();
  return {
    ...actual,
    externalCliDiscoveryScoped: () => ({ mode: "none", allowKeychainPrompt: false }),
    ensureAuthProfileStoreAsync: actual.ensureAuthProfileStoreWithoutExternalProfilesAsync,
  };
});
const authProfiles = await import("../../agents/auth-profiles.js");
const probe = await importFreshModule<ProbeModule>(
  import.meta.url,
  `./list.probe.js?scope=${Math.random().toString(36).slice(2)}`,
);
mocks.allowInferenceImport = true;
let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
beforeEach(async () => {
  vi.clearAllMocks();
  state = await createOpenClawTestState({
    prepareProfileCatalog: true,
    env: { OPENAI_API_KEY: undefined },
  });
  await state.writeAuthProfiles({
    version: 1,
    profiles: {
      "openai:profile": { type: "api_key", provider: "openai", key: "test-profile-key" },
    },
  });
  mocks.runner.mockReset().mockImplementation(async (params) => {
    params.onRequestComplete?.(13);
    return { text: "OK" };
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await state.cleanup();
});
afterAll(() => {
  vi.doUnmock("../../agents/isolated-completion.js");
  vi.doUnmock("../../agents/auth-profiles.js");
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
    agentId: "main",
    agentDir: state.agentDir(),
    workspaceDir: state.workspaceDir,
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

function useStateLock() {
  vi.spyOn(gatewayLockProcessModule, "readGatewayLockProcessStartTime").mockImplementation(
    () => 123_456,
  );
  const lockOptions: GatewayLockOptions = {
    allowInTests: true,
    env: state.env,
    lockDir: state.path("locks"),
    timeoutMs: 100,
  };
  vi.spyOn(embeddedStateLock, "acquireEmbeddedStateLock").mockImplementation((params) =>
    acquireNativeStateLock({ ...params, options: lockOptions }),
  );
  return lockOptions;
}

it("refuses CLI probes while a live Gateway owns canonical state", async () => {
  const lockOptions = useStateLock();
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

it("releases direct state ownership before propagating a rejected no-tail operation", async () => {
  const options = useStateLock();
  const signals = captureNativeSignalBridge(createNativeBridge);
  vi.spyOn(embeddedStateLock, "createEmbeddedStateSignalBridge").mockImplementationOnce(
    signals.create,
  );
  const original = new Error("synthetic direct probe failure");
  try {
    await expect(
      probe.withAuthProbeStateOwnership({ mode: "exclusive" }, async () => {
        throw original;
      }),
    ).rejects.toBe(original);
    expect(fs.existsSync(path.join(options.lockDir!, "gateway.state.lock"))).toBe(false);
    expect([signals.listenerCount("SIGINT"), signals.listenerCount("SIGTERM")]).toEqual([0, 0]);
  } finally {
    signals.dispose();
  }
});

it.each([false, true])("reports request-only timing (provider config: %s)", async (configured) => {
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

it("isolates runtime-resolved marker credentials without writing a synthetic profile", async () => {
  const upsert = vi.spyOn(authProfiles, "upsertAuthProfileWithLock");
  await state.writeAuthProfiles({ version: 1, profiles: {} });
  vi.stubEnv("OPENAI_API_KEY", "envkey");
  const provider = providerConfig({
    api: "openai-responses",
    apiKey: ["OPENAI", "API", "KEY"].join("_"),
  });
  await probe.runAuthProbes(probeInput(config(provider), { includeDirectKeys: true }));
  const call = mocks.runner.mock.calls[0]?.[0];
  assert(call?.agentDir);
  expect(call.agentDir).not.toBe(state.agentDir());
  expect(call).toMatchObject({
    preparedModelRuntimeMode: "isolated-read-only",
    config: { models: { providers: { openai: provider } }, auth: { order: { openai: [] } } },
  });
  expect(call.agentDir).toContain("openclaw-auth-probe-");
  expect(call.authProfileId).toBeUndefined();
  expect(upsert).not.toHaveBeenCalled();
});
