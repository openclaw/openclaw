import { expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as fetchGuard from "../infra/net/fetch-guard.js";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";
import * as nonInteractiveApiKeys from "./onboard-non-interactive/api-keys.js";
import { setupWizardCommand } from "./onboard.js";
import { createTestRuntime as makeRuntime } from "./test-runtime-config-helpers.js";

export type ConfigSnapshotStub = {
  exists: boolean;
  valid: boolean;
  config: OpenClawConfig;
  sourceConfig?: OpenClawConfig;
  readError?: { code: string | null };
};

export function registerOnboardResetDiscoveryTests({
  mocks,
  expectAuthPreflightError,
}: {
  mocks: {
    readConfigFileSnapshot: MockFn<() => Promise<ConfigSnapshotStub>>;
    handleReset: MockFn<() => Promise<void>>;
    runNonInteractiveSetup: MockFn<() => Promise<void>>;
  };
  expectAuthPreflightError: (
    opts: Parameters<typeof setupWizardCommand>[0],
    getMessage: () => string,
  ) => Promise<void>;
}) {
  const discoveryFailure = () =>
    "No models could be discovered from the custom provider. Check the base URL and credentials, or pass --custom-model-id explicitly.";
  const unresolvedKey = {
    source: "env",
    provider: "default",
    id: "RESET_TEST_KEY",
  } as const;
  function configureProvider(provider: Omit<ModelProviderConfig, "models">) {
    const providers = { local: { ...provider, models: [] } };
    const config: OpenClawConfig = { models: { providers } };
    const snapshot = { exists: true, valid: true, config, sourceConfig: config };
    mocks.readConfigFileSnapshot.mockResolvedValue(snapshot);
    return config;
  }
  const discoveryResponse = (response: Response, finalUrl = "https://example.com/v1/models") => ({
    response,
    finalUrl,
    release: async () => {},
  });
  const mockDiscovery = (ids: string[]) =>
    vi
      .spyOn(fetchGuard, "fetchWithSsrFGuard")
      .mockResolvedValue(discoveryResponse(Response.json({ data: ids.map((id) => ({ id })) })));
  async function runReset(opts: Parameters<typeof setupWizardCommand>[0]) {
    const runtime = makeRuntime();
    const flags = { reset: true, nonInteractive: true, acceptRisk: true, ...opts };
    await setupWizardCommand(flags, runtime);
    return runtime;
  }

  it("rejects empty discovery before reset", async () => {
    vi.spyOn(nonInteractiveApiKeys, "resolveNonInteractiveApiKey").mockResolvedValue(null);
    mockDiscovery([]);
    await expectAuthPreflightError({ customBaseUrl: "https://example.com/v1" }, discoveryFailure);
  });

  it.each([
    ["new endpoint", false, false, false],
    ["replacement endpoint", true, false, false],
    ["no-auth SecretRef", false, true, false],
    ["persisted no-auth SecretRef", false, true, true],
  ] as const)(
    "carries discovery identity through reset (%s)",
    async (_name, replacement, noAuth, persisted) => {
      vi.stubEnv("CUSTOM_API_KEY", undefined);
      if (replacement || noAuth) {
        vi.stubEnv(unresolvedKey.id, undefined);
        configureProvider({
          baseUrl: replacement ? "https://previous.example.com/v1" : "https://example.com/v1",
          ...(persisted ? { auth: "none" as const } : {}),
          ...(noAuth ? { apiKey: unresolvedKey } : {}),
        });
      }
      vi.spyOn(nonInteractiveApiKeys, "resolveNonInteractiveApiKey").mockResolvedValue(null);
      const request = mockDiscovery(["first", "second"]);
      const runtime = await runReset({
        resetScope: "config",
        customBaseUrl: "https://example.com/v1",
        customProviderId: "local",
        customNoAuth: noAuth && !persisted,
      });
      expect(mocks.handleReset).toHaveBeenCalledOnce();
      expect(mocks.runNonInteractiveSetup).toHaveBeenCalledWith(
        expect.objectContaining({
          customProviderId: replacement ? "local-2" : "local",
          customModelIds: ["first", "second"],
          customNoAuth: noAuth,
        }),
        runtime,
      );
      expect(request).toHaveBeenCalledOnce();
      const headers = new Headers(request.mock.calls[0]?.[0].init?.headers);
      expect(headers.has("authorization")).toBe(false);
    },
  );

  it.each([
    ["inline", "fixture-inline-key", "fixture-inline-key", undefined],
    [
      "env",
      { source: "env", provider: "default", id: "CUSTOM_DISCOVERY_TEST_KEY" },
      "fixture-env-key",
      undefined,
    ],
    ["explicit", "fixture-unused-key", "fixture-explicit-key", "fixture-explicit-key"],
  ] as const)(
    "requires surviving discovery credentials before reset (%s)",
    async (_name, apiKey, expectedKey, customApiKey) => {
      const authProfileStore = await import("../agents/auth-profiles/store-runtime.js");
      vi.spyOn(
        authProfileStore,
        "loadAuthProfileStoreWithoutExternalProfilesAsync",
      ).mockResolvedValue({ version: 1, profiles: {} });
      vi.stubEnv("CUSTOM_DISCOVERY_TEST_KEY", "fixture-env-key");
      const config = configureProvider({
        baseUrl: "https://models.example.com/v1",
        apiKey,
      });
      const authoredConfig = structuredClone(config);
      vi.spyOn(nonInteractiveApiKeys, "resolveNonInteractiveApiKey").mockResolvedValue(
        customApiKey ? { key: customApiKey, source: "flag" } : null,
      );
      const request = vi
        .spyOn(fetchGuard, "fetchWithSsrFGuard")
        .mockImplementation(async (params) => {
          const authorized =
            params.url === "https://models.example.com/v1/models" &&
            new Headers(params.init?.headers).get("authorization") === `Bearer ${expectedKey}`;
          return discoveryResponse(
            authorized
              ? Response.json({ data: [{ id: "secured-first" }, { id: "secured-second" }] })
              : new Response(null, { status: 401 }),
            params.url,
          );
        });
      const runtime = await runReset({
        authChoice: "custom-api-key",
        customBaseUrl: "https://models.example.com/v1",
        customProviderId: "local",
        ...(customApiKey ? { customApiKey } : {}),
      });

      if (!customApiKey) {
        for (const mock of [request, mocks.handleReset, mocks.runNonInteractiveSetup]) {
          expect(mock).not.toHaveBeenCalled();
        }
        expect(runtime.error).toHaveBeenCalledWith(
          expect.stringContaining("would remove the configured discovery credential"),
        );
      } else {
        expect(request).toHaveBeenCalledOnce();
        expect(mocks.handleReset).toHaveBeenCalledOnce();
        expect(mocks.runNonInteractiveSetup).toHaveBeenCalledWith(
          expect.objectContaining({
            customApiKey,
            customModelIds: ["secured-first", "secured-second"],
          }),
          runtime,
        );
        expect(request).toHaveBeenCalledBefore(mocks.handleReset);
        expect(mocks.handleReset).toHaveBeenCalledBefore(mocks.runNonInteractiveSetup);
      }
      expect(config).toEqual(authoredConfig);
      const output = JSON.stringify([runtime.log.mock.calls, runtime.error.mock.calls]);
      expect(output).not.toContain(expectedKey);
      if (typeof apiKey === "string") {
        expect(output).not.toContain(apiKey);
      }
    },
  );

  it.each(["inline", "profile"] as const)(
    "does not send a different endpoint's %s credential during reset preflight",
    async (source) => {
      const config = configureProvider({
        baseUrl: "https://previous.example.com/v1",
        apiKey: source === "profile" ? "local:bound" : "fixture-previous-endpoint-key",
      });
      const authoredConfig = structuredClone(config);
      vi.spyOn(nonInteractiveApiKeys, "resolveNonInteractiveApiKey").mockImplementation(
        async ({ provider, allowProfile }) =>
          source === "profile" && provider === "local" && allowProfile !== false
            ? { key: "fixture-previous-endpoint-key", source: "profile" }
            : null,
      );
      const authorizationHeaders: Array<string | null> = [];
      vi.spyOn(fetchGuard, "fetchWithSsrFGuard").mockImplementation(async (params) => {
        authorizationHeaders.push(new Headers(params.init?.headers).get("authorization"));
        return discoveryResponse(new Response(null, { status: 401 }), params.url);
      });

      await expectAuthPreflightError(
        {
          authChoice: "custom-api-key",
          customBaseUrl: "https://replacement.example.com/v1",
          customProviderId: "local",
          resetScope: "config",
        },
        discoveryFailure,
      );

      expect(authorizationHeaders).toEqual([null]);
      expect(config).toEqual(authoredConfig);
    },
  );
}
