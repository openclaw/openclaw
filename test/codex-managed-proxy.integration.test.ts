import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadCodexSubscriptionRoutingTestFixture } from "../extensions/codex/test-api.js";
import { startProxy } from "../src/infra/net/proxy/proxy-lifecycle.js";

const { createCodexSubscriptionRoutingTestFixture, stubCodexInferenceTransportEnv } =
  await loadCodexSubscriptionRoutingTestFixture();

beforeEach(stubCodexInferenceTransportEnv);
afterEach(() => vi.unstubAllEnvs());

it.each(["gateway-only", "proxy", "block"] as const)(
  "prepares subscription sharing only with compatible managed %s routing",
  async (loopbackMode) => {
    const envKeys = [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "http_proxy",
      "https_proxy",
      "no_proxy",
    ];
    const originalEnv = envKeys.map((key) => process.env[key]);
    const fixture = createCodexSubscriptionRoutingTestFixture();
    let proxy: Awaited<ReturnType<typeof startProxy>> | undefined;
    try {
      proxy = await startProxy({
        proxyUrl: "https://proxy.example.invalid:8443",
        loopbackMode,
      });
      if (loopbackMode !== "gateway-only") {
        await expect(fixture.prepare()).rejects.toThrow("compatible proxy and trust configuration");
        expect(fixture.writes).toEqual([]);
        return;
      }
      const prepared = await fixture.prepare();
      expect(prepared.route.upstream).toBe("https://api.openai.com/v1");
      expect(new URL(prepared.route.baseUrl).hostname).toBe("127.0.0.1");
      expect(prepared.config).toMatchObject({
        model_provider: "openclaw_token_sharing",
        model_providers: {
          openclaw_token_sharing: {
            base_url: prepared.route.baseUrl,
            requires_openai_auth: true,
            supports_websockets: false,
          },
        },
      });
      fixture.close();
      expect(() => prepared.route.assertCurrent()).toThrow();
    } finally {
      fixture.close();
      await proxy?.stop();
      expect(envKeys.map((key) => process.env[key])).toEqual(originalEnv);
    }
  },
);
