import fs from "node:fs/promises";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { jsonResponse, requestUrl } from "../../test-helpers/http.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createRuntimeEnv } from "../../test-utils/plugin-runtime-env.js";
import { createTestWizardPrompter } from "../../test-utils/plugin-setup-wizard.js";
import { acquireTestPortBlock } from "../../test-utils/port-claims.js";
import { runModelsAuthLoginFlowCore } from "./auth.js";

// Credential ordering is independent of the config merge; keep the real login and disk writer.
vi.mock("../../agents/auth-profiles/profiles.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/auth-profiles/profiles.js")>()),
  promoteAuthProfileInOrder: vi.fn(async () => ({ ok: true, value: { version: 1, profiles: {} } })),
}));
afterEach(() => vi.unstubAllGlobals());

it("removes copied xAI thinking fields from disk through runModelsAuthLoginFlowCore", async () => {
  const gatewayPort = await acquireTestPortBlock({ offsets: [0] });
  onTestFinished(() => gatewayPort.release());
  const state = await createOpenClawTestState({ label: "xai-login-config" });
  onTestFinished(() => state.cleanup());
  const { configPath, workspaceDir } = state;
  const model = {
    id: "grok-4.6",
    name: "Grok fixture",
    reasoning: true,
    thinkingLevelMap: { xhigh: null },
    compat: { supportedReasoningEfforts: ["low", "high"] },
  };
  const other = { ...model, id: "other", name: "Other", thinkingLevelMap: { xhigh: "high" } };
  const provider = (baseUrl: string, models: unknown[], auth?: "oauth") => ({
    api: "openai-responses",
    baseUrl,
    models,
    ...(auth ? { auth } : {}),
  });
  await state.writeConfig({
    gateway: { mode: "local", port: gatewayPort.port },
    plugins: { allow: ["xai"] },
    agents: { defaults: { model: "xai/grok-4.6", workspace: workspaceDir } },
    models: {
      providers: {
        xai: provider("https://cli-chat-proxy.grok.com/v1", [model], "oauth"),
        custom: provider("https://custom.example.invalid/v1", [other]),
      },
    },
  });
  const payload = Buffer.from(JSON.stringify({ sub: "fixture-account" })).toString("base64url");
  const liveModel = {
    id: model.id,
    api_backend: "responses",
    supports_reasoning_effort: true,
    reasoning_efforts: ["low", "high", "xhigh"],
  };
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
        return jsonResponse({ data: [liveModel] });
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
  const row = saved.models.providers.xai.models.find(({ id }: { id: string }) => id === model.id);
  expect(row.reasoning).toBe(true);
  expect(row).not.toHaveProperty("thinkingLevelMap");
  expect(row.compat ?? {}).not.toHaveProperty("supportedReasoningEfforts");
  expect(saved.models.providers.custom.models).toEqual([other]);
});
