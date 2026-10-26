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

it("removes copied xAI thinking fields from disk through runModelsAuthLoginFlowCore", async () => {
  const gatewayPort = await acquireTestPortBlock({ offsets: [0] });
  onTestFinished(() => gatewayPort.release());
  await withStateDirEnv("xai-login-config-", async ({ stateDir }) => {
    const configPath = path.join(stateDir, "openclaw.json");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    const model = createTestModelDefinition("grok-4.6", {
      reasoning: true,
      thinkingLevelMap: { xhigh: null },
      compat: { supportedReasoningEfforts: ["low", "high"] },
    });
    const other = {
      ...model,
      id: "custom-model",
      thinkingLevelMap: { xhigh: "high" },
    };
    const provider = (models: (typeof model)[], baseUrl: string) => ({
      api: "openai-responses",
      baseUrl,
      models,
    });
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
            xai: { ...provider([model], "https://cli-chat-proxy.grok.com/v1"), auth: "oauth" },
            custom: provider([other], "https://custom.example.invalid/v1"),
          },
        },
      }),
    );
    const payload = Buffer.from(
      JSON.stringify({ sub: "fixture-account", exp: Math.floor(Date.now() / 1000) + 86400 }),
    ).toString("base64url");
    const responses = {
      discovery: {
        device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code",
        token_endpoint: "https://auth.x.ai/oauth2/token",
      },
      "/device/code": {
        device_code: "fixture-device",
        user_code: "FIXTURE",
        verification_uri: "https://auth.x.ai/device",
        expires_in: 600,
        interval: 1,
      },
      "/token": {
        access_token: `eyJhbGciOiJub25lIn0.${payload}.signature`,
        refresh_token: "fixture-refresh",
        expires_in: 86400,
      },
      "/models": {
        data: [
          {
            id: model.id,
            api_backend: "responses",
            supports_reasoning_effort: true,
            reasoning_efforts: ["low", "high", "xhigh"],
          },
        ],
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) => {
        const url = requestUrl(input);
        const route = Object.entries(responses).find(([suffix]) =>
          suffix === "discovery" ? url.includes("/.well-known/") : url.endsWith(suffix),
        );
        if (route) {
          return jsonResponse(route[1]);
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
