import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import openrouterPlugin from "../../extensions/openrouter/index.js";
import type { OpenClawConfig } from "../../src/config/config.js";
import { loadProviderUsageSummary } from "../../src/infra/provider-usage.load.js";
import type * as ProviderRuntime from "../../src/plugins/provider-runtime.js";

const resolveUsage = vi.hoisted(() =>
  vi.fn<typeof ProviderRuntime.resolveProviderUsageSnapshotWithPlugin>(),
);

// mock-isolation: Select the real OpenRouter hook without activating unrelated plugins.
vi.mock("../../src/plugins/provider-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/plugins/provider-runtime.js")>()),
  resolveProviderUsageSnapshotWithPlugin: resolveUsage,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  resolveUsage.mockReset();
});

it("loads OpenRouter usage through the default loader and dispatcher-aware transport", async () => {
  const requests: string[] = [];
  await withServer(
    (request, response) => {
      requests.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          data: request.url?.endsWith("/credits")
            ? { total_credits: 10, total_usage: 2 }
            : { limit: 10, usage: 2, label: "synthetic" },
        }),
      );
    },
    async (baseUrl) => {
      const config = {
        models: { providers: { openrouter: { baseUrl: `${baseUrl}/api/v1`, models: [] } } },
      } satisfies OpenClawConfig;
      const provider = await registerSingleProviderPlugin(openrouterPlugin);
      resolveUsage.mockImplementation(async ({ context }) =>
        provider.fetchUsageSnapshot?.(context),
      );
      // A plain wrapper reproduces native fetch's dispatcher incompatibility on every Node version.
      vi.stubGlobal("fetch", () => {
        throw new TypeError("native fetch cannot use the bundled dispatcher");
      });

      const usage = await loadProviderUsageSummary({
        providers: ["openrouter"],
        auth: [{ provider: "openrouter", token: "synthetic-invalid-proof-token" }],
        config,
        env: {},
      });

      expect(usage.providers).toMatchObject([
        {
          provider: "openrouter",
          windows: [{ label: "API key budget", usedPercent: 20 }],
          billing: [
            { type: "balance", label: "Account balance", amount: 8, unit: "USD" },
            { type: "spend", label: "Account usage", amount: 2, unit: "USD" },
            { type: "budget", label: "API key budget", used: 2, limit: 10, unit: "USD" },
          ],
        },
      ]);
      expect(requests.toSorted()).toEqual(["/api/v1/credits", "/api/v1/key"]);
    },
  );
});
