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

it("removes copied xAI thinking fields from disk through runModelsAuthLoginFlowCore", async () => {
  const gatewayPort = await acquireTestPortBlock({ offsets: [0] });
  onTestFinished(() => gatewayPort.release());
  await withStateDirEnv("xai-login-config-", async ({ stateDir }) => {
    const configPath = path.join(stateDir, "openclaw.json");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    const model = {
      id: "grok-4.6",
      name: "Grok fixture",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 131072,
      maxTokens: 512,
      thinkingLevelMap: { xhigh: null },
      compat: { supportedReasoningEfforts: ["low", "high"] },
    };
    const other = {
      ...model,
      id: "custom-model",
      name: "Operator model",
      thinkingLevelMap: { xhigh: "high" },
    };
    await fs.writeFile(
      configPath,
      JSON.stringify({
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
      }),
    );
    const payload = Buffer.from(
      JSON.stringify({ sub: "fixture-account", exp: Math.floor(Date.now() / 1000) + 86400 }),
    ).toString("base64url");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) => {
        const url = requestUrl(input);
        if (url.includes("/.well-known/")) {
          return jsonResponse({
            device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code",
            token_endpoint: "https://auth.x.ai/oauth2/token",
          });
        }
        if (url.endsWith("/device/code")) {
          return jsonResponse({
            device_code: "fixture-device",
            user_code: "FIXTURE",
            verification_uri: "https://auth.x.ai/device",
            expires_in: 600,
            interval: 1,
          });
        }
        if (url.endsWith("/token")) {
          return jsonResponse({
            access_token: `eyJhbGciOiJub25lIn0.${payload}.signature`,
            refresh_token: "fixture-refresh",
            expires_in: 86400,
          });
        }
        if (url.endsWith("/models")) {
          return jsonResponse({
            data: [
              {
                id: model.id,
                api_backend: "responses",
                supports_reasoning_effort: true,
                reasoning_efforts: ["low", "high", "xhigh"],
              },
            ],
          });
        }
        throw new Error(`Unexpected xAI login request: ${url}`);
      }),
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
