import fs from "node:fs/promises";
import path from "node:path";
import {
  createRuntimeEnv,
  createTestWizardPrompter,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  acquireTestPortBlock,
  jsonResponse,
  requestUrl,
  withStateDirEnv,
} from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { upsertAuthProfileAsync } from "../../agents/auth-profiles/profiles.js";
import { loadAuthProfileStoreWithoutExternalProfilesAsync } from "../../agents/auth-profiles/store-runtime.js";
import { writeFixtureJson } from "../../cli/cli-fixtures.test-support.js";
import { createTestModelDefinition } from "../test-runtime-config-helpers.js";
import { runModelsAuthLoginFlowCore } from "./auth.js";

// Credential ordering is independent of the config merge; keep the real login and disk writer.
vi.mock("../../agents/auth-profiles/profiles.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/auth-profiles/profiles.js")>()),
  promoteAuthProfileInOrder: vi.fn(async () => ({ ok: true, value: { version: 1, profiles: {} } })),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function stubXaiDeviceCodeFetch(tokens: () => object, catalog?: object) {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input) => {
      const pathname = new URL(requestUrl(input)).pathname;
      switch (pathname) {
        case "/.well-known/openid-configuration":
          return jsonResponse({
            device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code",
            token_endpoint: "https://auth.x.ai/oauth2/token",
          });
        case "/oauth2/device/code":
          return jsonResponse({
            device_code: "fixture-device",
            user_code: "FIXTURE",
            verification_uri: "https://auth.x.ai/device",
            expires_in: 600,
            interval: 1,
          });
        case "/oauth2/token":
          return jsonResponse(tokens());
        case "/v1/models":
          if (catalog) {
            return jsonResponse(catalog);
          }
      }
      throw new Error(`Unexpected xAI fixture request: ${pathname}`);
    }),
  );
}

it("removes copied xAI thinking fields from disk through runModelsAuthLoginFlowCore", async () => {
  const gatewayPort = await acquireTestPortBlock({ offsets: [0] });
  onTestFinished(() => gatewayPort.release());
  await withStateDirEnv("xai-login-config-", async ({ stateDir }) => {
    const configPath = path.join(stateDir, "openclaw.json");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    const model = createTestModelDefinition("grok-4.6", {
      name: "Grok fixture",
      reasoning: true,
      contextWindow: 131072,
      maxTokens: 512,
      thinkingLevelMap: { xhigh: null },
      compat: { supportedReasoningEfforts: ["low", "high"] },
    });
    const other = {
      ...model,
      id: "custom-model",
      name: "Operator model",
      thinkingLevelMap: { xhigh: "high" },
    };
    await writeFixtureJson(configPath, {
      gateway: { mode: "local", port: gatewayPort.port },
      plugins: { allow: ["xai"] },
      agents: {
        defaults: { model: "xai/grok-4.6", workspace: path.join(stateDir, "workspace") },
      },
      models: {
        providers: {
          xai: {
            api: "openai-responses",
            auth: "oauth",
            baseUrl: "https://cli-chat-proxy.grok.com/v1",
            models: [model],
          },
          custom: {
            api: "openai-responses",
            baseUrl: "https://custom.example.invalid/v1",
            models: [other],
          },
        },
      },
    });
    const payload = Buffer.from(
      JSON.stringify({ sub: "fixture-account", exp: Math.floor(Date.now() / 1000) + 86400 }),
    ).toString("base64url");
    stubXaiDeviceCodeFetch(
      () => ({
        access_token: `eyJhbGciOiJub25lIn0.${payload}.signature`,
        refresh_token: "fixture-refresh",
        expires_in: 86400,
      }),
      {
        data: [
          {
            id: model.id,
            api_backend: "responses",
            supports_reasoning_effort: true,
            reasoning_efforts: ["low", "high", "xhigh"],
          },
        ],
      },
    );
    const result = await runModelsAuthLoginFlowCore({
      provider: "xai",
      method: "oauth",
      agent: "main",
      runtime: createRuntimeEnv(),
      prompter: createTestWizardPrompter(),
      openUrl: async () => {},
    });
    expect(result.providerId).toBe("xai");
    const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
    const row = saved.models.providers.xai.models.find(
      (candidate: { id: string }) => candidate.id === model.id,
    );
    expect(row.reasoning).toBe(true);
    expect(row).not.toHaveProperty("thinkingLevelMap");
    expect(row.compat ?? {}).not.toHaveProperty("supportedReasoningEfforts");
    expect(saved.models.providers.custom.models).toEqual([other]);
  });
});

it.each([
  { method: "oauth", force: false },
  { method: "device-code", force: true },
])(
  "preserves only verified xAI account names on $method reconnect (force=$force)",
  async ({ method, force }) => {
    const gatewayPort = await acquireTestPortBlock({ offsets: [0] });
    onTestFinished(() => gatewayPort.release());
    await withStateDirEnv("xai-relogin-name-", async ({ stateDir }) => {
      const configPath = path.join(stateDir, "openclaw.json");
      vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
      await writeFixtureJson(configPath, {
        gateway: { mode: "local", port: gatewayPort.port },
        plugins: { allow: ["xai"] },
        agents: { defaults: { workspace: path.join(stateDir, "workspace") } },
      });
      let subject: string | undefined = "fixture-account";
      let exchanges = 0;
      stubXaiDeviceCodeFetch(() => {
        const payload = Buffer.from(
          JSON.stringify({ sub: subject, email: "fixture@example.test", name: "Provider name" }),
        ).toString("base64url");
        return {
          access_token: "fixture-access-" + ++exchanges,
          refresh_token: "fixture-refresh",
          id_token: ["eyJhbGciOiJub25lIn0", payload, "signature"].join("."),
          expires_in: 86400,
        };
      });
      const login = (forceLogin = false) =>
        runModelsAuthLoginFlowCore({
          provider: "xai",
          method,
          agent: "main",
          force: forceLogin,
          credentialOnly: true,
          runtime: createRuntimeEnv(),
          prompter: createTestWizardPrompter(),
          openUrl: async () => {},
        });
      const initial = await login();
      // The legacy device-code request now resolves to the canonical OAuth method.
      expect(initial.methodId).toBe("oauth");
      const profile = initial.profiles[0];
      if (!profile) {
        throw new Error("Expected xAI login to persist a profile");
      }
      const { profileId } = profile;
      const read = async () =>
        (await loadAuthProfileStoreWithoutExternalProfilesAsync()).profiles[profileId];
      const name = async () => {
        const credential = await read();
        if (!credential) {
          throw new Error("Expected a saved xAI credential");
        }
        await upsertAuthProfileAsync({
          profileId,
          credential: { ...credential, displayName: "Work" },
        });
      };
      await name();
      expect(await read()).toMatchObject({ displayName: "Work" });
      await login(force);
      expect(await read()).toMatchObject({ displayName: "Work", access: "fixture-access-2" });

      subject = "replacement-account";
      await login(force);
      expect(await read()).toMatchObject({
        displayName: "Provider name",
        access: "fixture-access-3",
      });

      await name();
      subject = undefined;
      await login(force);
      expect(await read()).toMatchObject({
        displayName: "Provider name",
        access: "fixture-access-4",
      });
    });
  },
);
