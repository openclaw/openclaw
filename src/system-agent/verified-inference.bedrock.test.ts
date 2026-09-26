import { beforeAll, describe, expect, it, vi } from "vitest";
import { fingerprintAwsSdkRuntimeOwner } from "../agents/execution-auth-binding.js";
import { resolveApiKeyForProviderCore } from "../agents/model-auth-provider.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSystemAgentConfiguredRouteFromConfig } from "./inference-route.js";
import {
  createSystemAgentPluginMetadataTestSnapshot,
  type SystemAgentPluginMetadataTestSnapshot,
} from "./system-agent.test-helpers.js";
import {
  createSystemAgentVerifiedInferenceBinding,
  resolveSystemAgentVerifiedInferenceRoute,
  type SystemAgentVerifiedInferenceBinding,
  type SystemAgentVerifiedInferenceDeps,
} from "./verified-inference.js";
import { pluginArtifactDeps, requireFingerprint } from "./verified-inference.test-support.js";

vi.mock("../plugins/providers.js", () => ({
  resolveOwningPluginIdsForModelRefs: () => [],
  resolveOwningPluginIdsForProviderRef: () => [],
}));

let metadata: SystemAgentPluginMetadataTestSnapshot;
beforeAll(() => {
  metadata = createSystemAgentPluginMetadataTestSnapshot();
});

async function requireRoute(config: OpenClawConfig) {
  const route = await metadata.run(
    () => resolveSystemAgentConfiguredRouteFromConfig(config),
    config,
  );
  if (!route || route.runner !== "embedded") {
    throw new Error("missing test embedded route");
  }
  return route;
}

function createBinding(
  route: Awaited<ReturnType<typeof requireRoute>>,
  auth: Parameters<typeof createSystemAgentVerifiedInferenceBinding>[0]["auth"],
  deps: SystemAgentVerifiedInferenceDeps = {},
) {
  return metadata.run(() =>
    createSystemAgentVerifiedInferenceBinding({
      configuredRoute: route,
      executionRoute: route,
      auth,
      deps,
    }),
  );
}

function revalidate(
  binding: SystemAgentVerifiedInferenceBinding,
  config: OpenClawConfig,
  deps: SystemAgentVerifiedInferenceDeps,
) {
  return metadata.run(() =>
    resolveSystemAgentVerifiedInferenceRoute(binding, {
      ...deps,
      readConfigFileSnapshot: vi.fn(async () => ({ exists: true, valid: true, config })) as never,
    }),
  );
}

describe("verified Bedrock SDK inference binding", () => {
  it.each([undefined, "aws-sdk"] as const)(
    "binds and revalidates Bedrock SDK auth with provider auth %s, but rejects owner drift",
    async (providerAuth) => {
      const modelId = "us.anthropic.claude-sonnet-4-6";
      const modelApi = "bedrock-converse-stream";
      const bedrockConfig = {
        agents: { defaults: { model: `amazon-bedrock/${modelId}` } },
        models: {
          providers: {
            "amazon-bedrock": {
              baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
              api: modelApi,
              ...(providerAuth ? { auth: providerAuth } : {}),
              models: [],
            },
          },
        },
      } satisfies OpenClawConfig;
      const route = await requireRoute(bedrockConfig);
      const resolveAuth = vi.fn(resolveApiKeyForProviderCore);
      const deps = { ...pluginArtifactDeps(), resolveApiKeyForProvider: resolveAuth };
      try {
        vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "synthetic-bedrock-owner-a");
        vi.stubEnv("AWS_ACCESS_KEY_ID", "");
        vi.stubEnv("AWS_SECRET_ACCESS_KEY", "");
        vi.stubEnv("AWS_SESSION_TOKEN", "");
        vi.stubEnv("AWS_PROFILE", "");
        const auth = await resolveApiKeyForProviderCore({
          provider: route.provider,
          cfg: route.runConfig,
          agentDir: route.agentDir,
          modelId,
          modelApi,
          allowAuthProfileFallback: false,
        });
        expect(auth.mode).toBe("aws-sdk");
        const successfulAuth = {
          agentHarnessId: "openclaw",
          modelId,
          modelApi,
          runtimeOwnerKind: "aws-sdk" as const,
          runtimeOwnerId: "openclaw",
          runtimeOwnerFingerprint: requireFingerprint(
            fingerprintAwsSdkRuntimeOwner({
              provider: route.provider,
              backendId: "openclaw",
              auth,
            }),
          ),
        };
        for (const missing of ["modelId", "modelApi"] as const) {
          resolveAuth.mockClear();
          await expect(
            createBinding(route, { ...successfulAuth, [missing]: undefined }, deps),
          ).rejects.toThrow("no longer the active route owner");
          expect(resolveAuth).not.toHaveBeenCalled();
        }

        const binding = await createBinding(route, successfulAuth, deps);
        expect(resolveAuth).toHaveBeenLastCalledWith(
          expect.objectContaining({ modelId, modelApi, allowAuthProfileFallback: false }),
        );
        resolveAuth.mockClear();
        await expect(revalidate(binding, bedrockConfig, deps)).resolves.toBe(binding.execution);
        expect(resolveAuth).toHaveBeenLastCalledWith(
          expect.objectContaining({ modelId, modelApi, allowAuthProfileFallback: false }),
        );

        vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "synthetic-bedrock-owner-b");
        await expect(createBinding(route, successfulAuth, deps)).rejects.toThrow(
          "no longer the active route owner",
        );
        await expect(revalidate(binding, bedrockConfig, deps)).resolves.toBeNull();

        vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "");
        await expect(revalidate(binding, bedrockConfig, deps)).resolves.toBeNull();
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("refuses to mint an AWS SDK owner without exact principal proof", async () => {
    const bedrockConfig = {
      agents: {
        defaults: { model: "amazon-bedrock/us.anthropic.claude-sonnet-4-6" },
      },
      models: {
        providers: {
          "amazon-bedrock": {
            baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
            api: "bedrock-converse-stream",
            auth: "aws-sdk",
            models: [],
          },
        },
      },
    } satisfies OpenClawConfig;
    const route = await requireRoute(bedrockConfig);
    const auth = { source: "aws-sdk default chain", mode: "aws-sdk" as const };
    const fingerprint = () =>
      fingerprintAwsSdkRuntimeOwner({
        provider: route.provider,
        backendId: route.agentHarnessRuntimeOverride ?? "openclaw",
        auth,
      });
    try {
      vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "");
      vi.stubEnv("AWS_ACCESS_KEY_ID", "");
      vi.stubEnv("AWS_SECRET_ACCESS_KEY", "");
      vi.stubEnv("AWS_SESSION_TOKEN", "");
      vi.stubEnv("AWS_PROFILE", "work");
      expect(fingerprint()).toBeUndefined();

      vi.stubEnv("AWS_PROFILE", "");
      expect(fingerprint()).toBeUndefined();

      await expect(createBinding(route, {})).rejects.toThrow(
        "did not report one exact execution owner",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
