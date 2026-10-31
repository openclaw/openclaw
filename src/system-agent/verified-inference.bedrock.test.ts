import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fingerprintAwsSdkRuntimeOwner } from "../agents/execution-auth-binding.js";
import { resolveApiKeyForProviderCore } from "../agents/model-auth-provider.js";
import * as modelAuth from "../agents/model-auth.js";
import * as configModule from "../config/config.js";
import { createConfigFileSnapshot } from "../config/io.snapshot-shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as pluginArtifactIdentity from "../plugins/plugin-runtime-artifact-identity.js";
import { resolveSystemAgentConfiguredRouteFromConfig } from "./inference-route.js";
import {
  createSystemAgentPluginMetadataTestSnapshot,
  type SystemAgentPluginMetadataTestSnapshot,
} from "./system-agent.test-helpers.js";
import {
  createSystemAgentVerifiedInferenceBinding,
  resolveSystemAgentVerifiedInferenceRoute,
  type SystemAgentVerifiedInferenceBinding,
} from "./verified-inference.js";
import { mockPluginRegistry, requireFingerprint } from "./verified-inference.test-support.js";

vi.mock("../plugins/providers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/providers.js")>()),
  resolveOwningPluginIdsForModelRefs: () => [],
  resolveOwningPluginIdsForProviderRef: () => [],
}));

let metadata: SystemAgentPluginMetadataTestSnapshot;
beforeAll(() => {
  metadata = createSystemAgentPluginMetadataTestSnapshot();
});

beforeEach(() => {
  mockPluginRegistry([]);
  vi.spyOn(pluginArtifactIdentity, "fingerprintPluginRuntimeArtifact").mockImplementation(
    (record) => `${record.pluginId}-runtime-v1`,
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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
) {
  return metadata.run(() =>
    createSystemAgentVerifiedInferenceBinding({
      configuredRoute: route,
      executionRoute: route,
      auth,
    }),
  );
}

async function revalidate(binding: SystemAgentVerifiedInferenceBinding, config: OpenClawConfig) {
  const reader = vi.spyOn(configModule, "readConfigFileSnapshot").mockResolvedValue(
    createConfigFileSnapshot({
      path: "/tmp/openclaw.json",
      exists: true,
      valid: true,
      raw: null,
      parsed: config,
      sourceConfig: config,
      runtimeConfig: config,
      issues: [],
      warnings: [],
      legacyIssues: [],
    }),
  );
  try {
    return await metadata.run(() => resolveSystemAgentVerifiedInferenceRoute(binding));
  } finally {
    reader.mockRestore();
  }
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
      // Call through to the real provider auth resolver; the spy only records
      // how the owner check asked for SDK selection.
      const resolveAuth = vi.spyOn(modelAuth, "resolveApiKeyForProviderCore");
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
      const sdkOwnerLookup = expect.objectContaining({
        provider: route.provider,
        modelId,
        modelApi,
        allowAuthProfileFallback: false,
      });

      // Missing model facts cannot be re-resolved to the executed owner.
      for (const missing of ["modelId", "modelApi"] as const) {
        resolveAuth.mockClear();
        await expect(
          createBinding(route, { ...successfulAuth, [missing]: undefined }),
        ).rejects.toThrow("no longer the active route owner");
        expect(resolveAuth).not.toHaveBeenCalled();
      }

      // Initial binding and later reuse re-resolve the same SDK owner with the
      // run's model facts and without implicit auth-profile fallback.
      resolveAuth.mockClear();
      const binding = await createBinding(route, successfulAuth);
      expect(resolveAuth).toHaveBeenCalledTimes(1);
      expect(resolveAuth).toHaveBeenLastCalledWith(sdkOwnerLookup);
      expect(resolveAuth.mock.lastCall?.[0]).not.toHaveProperty("profileId");
      resolveAuth.mockClear();
      await expect(revalidate(binding, bedrockConfig)).resolves.toBe(binding.execution);
      expect(resolveAuth).toHaveBeenLastCalledWith(sdkOwnerLookup);
      expect(resolveAuth.mock.lastCall?.[0]).not.toHaveProperty("profileId");

      // Token rotation is owner drift before binding and before reuse.
      vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "synthetic-bedrock-owner-b");
      await expect(createBinding(route, successfulAuth)).rejects.toThrow(
        "no longer the active route owner",
      );
      await expect(revalidate(binding, bedrockConfig)).resolves.toBeNull();

      // Credential removal leaves no observable owner.
      vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "");
      await expect(revalidate(binding, bedrockConfig)).resolves.toBeNull();
    },
  );
});
