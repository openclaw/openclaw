import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as httpFixture from "../../../test/helpers/gateway-integration-fixtures.js";
import { writeJsonFile } from "../../../test/helpers/temp-repo.js";
import { createWizardPrompter } from "../../../test/helpers/wizard-prompter.js";
import { clearAuthProfileMigrationDiagnostics } from "../../agents/auth-profiles/legacy-source-diagnostic.js";
import { loadPersistedAuthProfileStore } from "../../agents/auth-profiles/persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../../agents/auth-profiles/runtime-snapshots.js";
import { saveAuthProfileStore } from "../../agents/auth-profiles/store-runtime.js";
import { runModelsAuthLoginFlowCore } from "../../commands/models/auth.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getPluginLoaderCacheState } from "../../plugins/registry-lifecycle.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createProviderBrowserAuthSession } from "../provider-browser-auth.js";
import { createGatewayHttpServer } from "../server-http.js";
import { prepareTailscalePublishedOrigin } from "../tailscale-published-origin.js";

const providerId = "browser-auth-proof";
const profileId = `${providerId}:default`;
const retainedProfile = { type: "api_key" as const, provider: "other", key: "fixture-retained" };
const credential = { type: "api_key", provider: providerId, key: "fixture-code-key" };
const retainedProfiles = { "other:retained": retainedProfile };

async function writeBrowserProvider(workspaceDir: string, authorizationState: string) {
  const pluginDir = path.join(workspaceDir, ".openclaw", "extensions", providerId);
  writeJsonFile(path.join(pluginDir, "openclaw.plugin.json"), {
    id: providerId,
    providers: [providerId],
    configSchema: { type: "object", additionalProperties: false, properties: {} },
  });
  await fs.writeFile(
    path.join(pluginDir, "index.cjs"),
    `module.exports = (api) =>
        api.registerProvider({
          id: ${JSON.stringify(providerId)}, label: "Browser auth proof",
          auth: [{ id: "oauth", label: "Browser", kind: "oauth",
            async run({ oauth }) {
              const state = ${JSON.stringify(authorizationState)};
              const result = await oauth.authorize({
                state, timeoutMs: 60000,
                buildAuthorizationUrl: (redirectUrl) =>
                  "https://provider.example/authorize?redirect_uri=" +
                  encodeURIComponent(redirectUrl + "?state=" + state),
              });
              return { profiles: [{
                profileId: ${JSON.stringify(profileId)},
                credential: { type: "api_key", provider: ${JSON.stringify(providerId)}, key: result.code + "-key" },
              }] };
            },
          }],
        });`,
  );
}

it.each(["complete", "cancel"] as const)("callback receipt: %s", async (outcome) => {
  const state = await createOpenClawTestState({
    label: `browser-auth-${outcome}`,
    env: {
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_OAUTH_DIR: undefined,
      OPENCLAW_GATEWAY_URL: undefined,
      OPENCLAW_GATEWAY_PORT: undefined,
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_GATEWAY_PASSWORD: undefined,
    },
  });
  const authorizationState = `browser-${outcome}`;
  const opened = createDeferredCore<string>();
  const allowPersistence = createDeferredCore();
  const cancellation = new AbortController();
  const browser = createProviderBrowserAuthSession({
    signal: cancellation.signal,
    openUrl: async (url) => opened.resolve(url),
  });
  const withdrawOrigin = prepareTailscalePublishedOrigin({
    origin: "https://gateway.example",
    mode: "serve",
  });
  const config: OpenClawConfig = {
    agents: { entries: { main: { workspace: state.workspaceDir } } },
    plugins: { allow: [providerId], entries: { [providerId]: { enabled: true } } },
  };
  const hooks = vi.fn(async () => false);
  const server = createGatewayHttpServer({
    clients: new Set(),
    controlUiEnabled: false,
    controlUiBasePath: "",
    handleHooksRequest: hooks,
    resolvedAuth: { mode: "token", token: "fixture-gateway-token", allowTailscale: false },
    getRuntimeConfig: () => config,
  });
  let login: ReturnType<typeof runModelsAuthLoginFlowCore> | undefined;
  try {
    getPluginLoaderCacheState().clear();
    resetPluginRuntimeStateForTest();
    await writeBrowserProvider(state.workspaceDir, authorizationState);
    const localOrigin = await httpFixture.listenLoopback(server);
    await state.writeConfig(config);
    saveAuthProfileStore({ version: 1, profiles: retainedProfiles }, undefined, {
      sharedStoreWrite: true,
      filterExternalAuthProfiles: false,
      syncExternalCli: false,
    });
    const refreshAfterLogin = vi.fn(async () => {
      expect(loadPersistedAuthProfileStore()?.profiles[profileId]).toEqual(credential);
    });
    login = runModelsAuthLoginFlowCore({
      provider: providerId,
      method: "oauth",
      agent: "main",
      config,
      credentialOnly: true,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      prompter: createWizardPrompter(),
      isRemote: true,
      signal: browser.signal,
      assertCurrent: browser.assertCurrent,
      browserAuthorization: browser.authorize,
      beforePersistentEffect: async () => {
        await allowPersistence.promise;
        browser.assertCurrent();
      },
      refreshAfterLogin,
    });
    const failure = login.catch((error: unknown) => error);
    const authorizationUrl = await Promise.race([
      opened.promise,
      login.then(() => {
        throw new Error("Provider login completed before opening its browser URL.");
      }),
    ]);
    const redirect = new URL(authorizationUrl).searchParams.get("redirect_uri");
    expect(redirect).toBe(
      `https://gateway.example/oauth/provider/callback?state=${authorizationState}`,
    );
    const callback = new URL(redirect!);
    callback.searchParams.set("code", "fixture-code");
    const callbackUrl = `${localOrigin}${callback.pathname}${callback.search}`;
    if (outcome === "cancel") {
      cancellation.abort(new Error("Chat cancelled sign-in."));
      await expect(failure).resolves.toEqual(new Error("Chat cancelled sign-in."));
    }
    const response = await fetch(callbackUrl);
    expect(hooks).not.toHaveBeenCalled();
    expect(response.status).toBe(outcome === "complete" ? 200 : 410);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    const receipt = await response.text();
    if (outcome === "complete") {
      expect(receipt).toContain("Sign-in response received.");
      expect(receipt).toContain("Return to OpenClaw for the sign-in result.");
    }
    expect(loadPersistedAuthProfileStore()?.profiles).toEqual(retainedProfiles);
    const replay = await fetch(callbackUrl);
    expect(replay.status).toBe(410);
    await replay.text();
    allowPersistence.resolve();
    if (outcome === "complete") {
      await expect(login).resolves.toMatchObject({
        profiles: [{ profileId, provider: providerId, mode: "api_key" }],
        authRefresh: "refreshed",
      });
    }
    expect(refreshAfterLogin.mock.calls).toEqual(outcome === "complete" ? [["main"]] : []);
    expect(loadPersistedAuthProfileStore()?.profiles).toEqual({
      ...retainedProfiles,
      ...(outcome === "complete" ? { [profileId]: credential } : {}),
    });
  } finally {
    browser.close();
    allowPersistence.resolve();
    await login?.catch(() => {});
    withdrawOrigin();
    if (server.listening) {
      await httpFixture.closeHttpServer(server);
    }
    getPluginLoaderCacheState().clear();
    resetPluginRuntimeStateForTest();
    clearRuntimeAuthProfileStoreSnapshots();
    clearAuthProfileMigrationDiagnostics();
    await state.cleanup();
  }
});
