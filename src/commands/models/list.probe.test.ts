import fs from "node:fs/promises";
import path from "node:path";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, assert, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { ModelProviderConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { acquireGatewayLock, type GatewayLockOptions } from "../../infra/gateway-lock.js";

let probeModule: typeof import("./list.probe.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type RunnerParams = Parameters<
  typeof import("../../agents/isolated-completion.js").runIsolatedCompletion
>[0];
type ProbeParams = Parameters<typeof probeModule.runAuthProbes>[0];
const providerConfig = (overrides: Partial<ModelProviderConfig> = {}) => ({
  baseUrl: "https://api.openai.com/v1",
  models: [],
  ...overrides,
});
const config = (overrides: Partial<ModelProviderConfig>): OpenClawConfig => ({
  models: { providers: { openai: providerConfig(overrides) } },
});
function probeInput(
  overrides: Omit<Partial<ProbeParams>, "options"> & { options?: Partial<ProbeParams["options"]> },
): ProbeParams {
  return {
    cfg: {},
    agentId: "probe-agent",
    agentDir: "/tmp/openclaw-probe-agent",
    workspaceDir: "/tmp/openclaw-probe-workspace",
    providers: ["openai"],
    modelCandidates: ["openai/gpt-5.5"],
    ...overrides,
    options: {
      provider: "openai",
      timeoutMs: 5_000,
      concurrency: 1,
      maxTokens: 8,
      ...overrides.options,
    },
  };
}

async function withProbeRuntime(
  credential: "profile" | "literal" | "marker",
  run: (fixture: ReturnType<typeof createMocks> & { probe: typeof probeModule }) => Promise<void>,
) {
  const mocks = createMocks();
  const { runner, upsert, readCatalog } = mocks;
  const profileIds = credential === "marker" ? [] : ["openai:profile"];
  const envKey = { apiKey: "envkey", source: "OPENAI_API_KEY" };
  // mock-isolation: The probe fixture controls request completion without starting inference.
  vi.doMock("../../agents/isolated-completion.js", () => ({ runIsolatedCompletion: runner }));
  vi.doMock("../../agents/auth-profiles.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../agents/auth-profiles.js")>()),
    externalCliDiscoveryScoped: () => undefined,
    ensureAuthProfileStoreAsync: async () => ({
      version: 1,
      order: {},
      profiles: Object.fromEntries(
        profileIds.map((id) => [
          id,
          { type: "api_key", provider: "openai", key: "test-profile-key" },
        ]),
      ),
    }),
    listProfilesForProvider: () => profileIds,
    resolveAuthProfileDisplayLabel: ({ profileId }: { profileId: string }) => profileId,
    resolveAuthProfileEligibility: () => ({ eligible: true }),
    resolveAuthProfileOrder: () => profileIds,
    upsertAuthProfileWithLock: upsert,
  }));
  vi.doMock("../../agents/model-auth.js", () => ({
    hasUsableCustomProviderApiKey: () => credential !== "profile",
    resolveEnvApiKey: () => (credential === "marker" ? envKey : null),
    resolveProviderEntryApiKeyBinding: vi.fn(),
    resolveProviderEntryApiKeyProfileReference: () =>
      credential === "literal"
        ? { kind: "literal", apiKey: "test", source: "models.json" }
        : { kind: credential === "marker" ? "marker" : "none" },
    ...(credential === "marker"
      ? {
          resolveUsableCustomProviderApiKey: () => envKey,
        }
      : {}),
  }));
  // mock-isolation: Catalog candidates are fixture-owned and must not discover installed providers.
  vi.doMock("../../agents/prepared-model-catalog.js", () => ({
    readPreparedModelCatalog: readCatalog,
  }));
  try {
    const probe = await importFreshModule<typeof probeModule>(
      import.meta.url,
      `./list.probe.js?scope=${Math.random().toString(36).slice(2)}`,
    );
    await run({ probe, ...mocks });
  } finally {
    vi.doUnmock("../../agents/isolated-completion.js");
    vi.doUnmock("../../agents/auth-profiles.js");
    vi.doUnmock("../../agents/model-auth.js");
    vi.doUnmock("../../agents/prepared-model-catalog.js");
  }
}

function createMocks() {
  return {
    runner: vi.fn(async (params: RunnerParams) => {
      params.onRequestComplete?.(13);
      return { text: "OK" };
    }),
    upsert: vi.fn(async (params: { profileId: string; credential: unknown }) => ({
      version: 1,
      profiles: { [params.profileId]: params.credential },
    })),
    readCatalog: vi.fn(async () => [{ provider: "openai", id: "gpt-5.5" }]),
  };
}

beforeAll(async () => {
  // mock-isolation: Assert the listing path never loads the inference runtime.
  vi.doMock("../../agents/isolated-completion.js", () => {
    throw new Error("isolated-completion should stay lazy for probe imports");
  });
  try {
    probeModule = await importFreshModule<typeof import("./list.probe.js")>(
      import.meta.url,
      `./list.probe.js?scope=${Math.random().toString(36).slice(2)}`,
    );
  } finally {
    vi.doUnmock("../../agents/isolated-completion.js");
  }
});

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
    expect(probeModule.mapFailoverReasonToProbeStatus(reason)).toBe(expected);
  }
});

describe("runAuthProbes", () => {
  it("refuses direct CLI probes while a live Gateway owns canonical state", async () => {
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
    const gatewayLock = await acquireGatewayLock({ ...lockOptions, port: 28789 });
    assert(gatewayLock, "Expected live Gateway fixture lock");
    try {
      await expect(
        probeModule.withAuthProbeStateOwnership(
          { mode: "exclusive", gatewayLockOptions: lockOptions },
          async () => undefined,
        ),
      ).rejects.toThrow(
        `A Gateway is running for this state directory (pid ${process.pid}, port 28789). Stop the Gateway first (openclaw gateway stop), then rerun models status --probe.`,
      );
    } finally {
      await gatewayLock.release();
    }
  });

  it.each([false, true])(
    "reports request-only probe timing (provider config: %s)",
    async (configured) => {
      await withProbeRuntime("profile", async ({ probe, runner, readCatalog }) => {
        readCatalog.mockRejectedValue(new Error("Catalog unavailable"));
        const input = probeInput({
          cfg: configured ? config({ agentRuntime: { id: "codex" } }) : {},
          options: { profileIds: ["openai:profile"] },
        });
        expect((await probe.runAuthProbes(input)).results[0]).toMatchObject({
          status: "ok",
          latencyMs: 13,
        });
        expect(runner).toHaveBeenCalledWith(
          expect.objectContaining({
            authProfileId: "openai:profile",
            outputTextPolicy: "strict-visible",
            agentHarnessRuntimeOverride: "openclaw",
            thinkLevel: "off",
          }),
        );
        expect(runner.mock.calls[0]?.[0].preparedModelRuntimeMode).toBeUndefined();
        runner.mockRejectedValueOnce(
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
    },
  );

  it.each(["literal", "marker"] as const)(
    "isolates %s credentials from stored profiles",
    async (credential) => {
      await withProbeRuntime(credential, async ({ probe, runner, upsert }) => {
        const literal = credential === "literal";
        const marker = ["OPENAI", "API", "KEY"].join("_");
        const provider = providerConfig({
          api: "openai-responses",
          apiKey: literal ? "test" : marker,
          ...(literal ? ({ auth: "oauth", agentRuntime: { id: "codex" } } as const) : {}),
        });
        await probe.runAuthProbes(
          probeInput({
            cfg: config(provider),
            options: { includeDirectKeys: true },
          }),
        );
        const call = literal
          ? runner.mock.calls.find(([params]) =>
              params.authProfileId?.startsWith("openai:probe-"),
            )?.[0]
          : runner.mock.calls[0]?.[0];
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
          expect(upsert).toHaveBeenCalledWith({
            profileId: call.authProfileId,
            agentDir: call.agentDir,
            credential: expect.objectContaining({
              type: "oauth",
              provider: "openai",
              access: "test",
            }),
          });
          await expect(fs.stat(call.agentDir)).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          expect(call.agentDir).toContain("openclaw-auth-probe-");
          expect(call.authProfileId).toBeUndefined();
          expect(upsert).not.toHaveBeenCalled();
        }
      });
    },
  );
});
