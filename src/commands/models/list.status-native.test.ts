import { describe, expect, it } from "vitest";
import { jsonStatus, mocks, statusConfig } from "./list.status.test-support.js";

describe("native runtime model status", () => {
  it.each([
    { runtime: "muse", signedIn: true, missing: [] },
    { runtime: "muse", signedIn: false, missing: ["meta"] },
    { runtime: "openclaw", signedIn: true, missing: ["meta"] },
  ])(
    "scopes Muse login status to its runtime ($runtime, $signedIn)",
    async ({ runtime, signedIn, missing }) => {
      const cfg = statusConfig("meta/muse-spark-1.3");
      mocks.loadConfig.mockReturnValue({
        ...cfg,
        agents: {
          defaults: {
            ...cfg.agents.defaults,
            models: { "meta/muse-spark-1.3": { agentRuntime: { id: runtime } } },
          },
        },
        models: {
          providers: {
            meta: {
              baseUrl: "https://api.meta.ai/v1",
              api: "openai-responses",
              auth: "api-key",
              models: [],
            },
          },
        },
      });
      mocks.store.profiles = {};
      mocks.resolveEnvApiKey.mockReturnValue(null);
      mocks.resolveRuntimeSyntheticAuthProviderRefs.mockReturnValue(["muse"]);
      mocks.resolveProviderSyntheticAuthWithPlugin.mockImplementation(
        ({ provider }: { provider: string }) =>
          provider === "muse" && signedIn
            ? {
                apiKey: "synthetic-muse-presence",
                source: "Muse native login",
                mode: "oauth",
                nativeAuth: { runtime: "muse", mode: "oauth" },
              }
            : undefined,
      );
      const { payload } = await jsonStatus();
      expect(payload.auth.missingProvidersInUse).toEqual(missing);
      expect(payload.auth.runtimeAuthRoutes).toEqual(
        runtime === "muse"
          ? [
              {
                provider: "meta",
                runtime: "muse",
                authProvider: "muse",
                status: signedIn ? "usable" : "missing",
                effective: signedIn
                  ? { kind: "synthetic", detail: "Muse native login" }
                  : { kind: "missing", detail: "missing" },
              },
            ]
          : [],
      );
      expect(mocks.store.profiles).toEqual({});
      expect(JSON.stringify(payload)).not.toContain("synthetic-muse-presence");
    },
  );
});
