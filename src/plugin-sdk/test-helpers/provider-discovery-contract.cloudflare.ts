import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runProviderCatalog } from "../../plugins/provider-discovery.js";
import {
  registerProviderPlugins,
  requireRegisteredProvider,
} from "../../test-utils/plugin-registration.js";
import type { AuthProfileStore } from "../provider-auth.js";
import type { ProviderDiscoveryContractPluginLoader } from "./provider-discovery-contract.types.js";

const mocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(),
  listProfilesForProvider: vi.fn(),
}));

export function describeCloudflareAiGatewayProviderDiscoveryContract(
  load: ProviderDiscoveryContractPluginLoader,
) {
  let provider: Awaited<ReturnType<typeof registerProviderPlugins>>[number];

  describe("cloudflare-ai-gateway provider discovery contract", () => {
    beforeAll(async () => {
      vi.resetModules();
      vi.doMock("openclaw/plugin-sdk/provider-auth", async (importOriginal) => ({
        ...(await importOriginal<typeof import("../provider-auth.js")>()),
        ensureAuthProfileStore: mocks.ensureAuthProfileStore,
        listProfilesForProvider: mocks.listProfilesForProvider,
      }));
      const { default: plugin } = await load();
      provider = requireRegisteredProvider(
        await registerProviderPlugins(plugin),
        "cloudflare-ai-gateway",
      );
    });

    beforeEach(() => {
      mocks.ensureAuthProfileStore.mockReturnValue({ version: 1, profiles: {} });
      mocks.listProfilesForProvider.mockImplementation(
        (store: AuthProfileStore, providerId: string) =>
          Object.entries(store.profiles)
            .filter(([, credential]) => credential.provider === providerId)
            .map(([profileId]) => profileId),
      );
    });

    afterEach(() => {
      vi.restoreAllMocks();
      mocks.ensureAuthProfileStore.mockReset();
      mocks.listProfilesForProvider.mockReset();
    });
    afterAll(() => {
      vi.doUnmock("openclaw/plugin-sdk/provider-auth");
      vi.resetModules();
    });

    const runCatalog = (env: NodeJS.ProcessEnv = {}) =>
      runProviderCatalog({
        provider,
        config: {},
        env,
        resolveProviderApiKey: () => ({ apiKey: undefined }),
        resolveProviderAuth: () => ({
          apiKey: undefined,
          discoveryApiKey: undefined,
          mode: "none",
          source: "none",
        }),
      });

    it("keeps catalog disabled without stored metadata", async () => {
      await expect(runCatalog()).resolves.toBeNull();
    });

    it("keeps env-managed catalog provider-owned", async () => {
      const fetch = vi.spyOn(globalThis, "fetch");
      mocks.ensureAuthProfileStore.mockReturnValue({
        version: 1,
        profiles: {
          "cloudflare-ai-gateway:default": {
            type: "api_key",
            provider: "cloudflare-ai-gateway",
            keyRef: {
              source: "env",
              provider: "default",
              id: "CLOUDFLARE_AI_GATEWAY_API_KEY",
            },
            metadata: { accountId: "acc-123", gatewayId: "gw-456" },
          },
        },
      });

      const result = await runCatalog({ CLOUDFLARE_AI_GATEWAY_API_KEY: "secret-value" });
      expect(result?.outcomes).toEqual([]);
      if (!result || !("provider" in result)) {
        throw new Error("expected Cloudflare AI Gateway provider catalog");
      }
      expect(result.provider).toMatchObject({
        baseUrl: "https://gateway.ai.cloudflare.com/v1/acc-123/gw-456/anthropic",
        api: "anthropic-messages",
        apiKey: "CLOUDFLARE_AI_GATEWAY_API_KEY",
      });
      expect(result.provider.models.map((model) => model.id)).toEqual(["claude-sonnet-4-6"]);
      expect(fetch).not.toHaveBeenCalled();
    });
  });
}
