import fs from "node:fs/promises";
import {
  createRuntimeEnv,
  createTestWizardPrompter,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { acquireTestPortBlock, jsonResponse, requestUrl } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createTestModelDefinition } from "../test-runtime-config-helpers.js";
import { runModelsAuthLoginFlowCore } from "./auth.js";

// Credential ordering is independent of the config merge; keep the real login and disk writer.
vi.mock("../../agents/auth-profiles/profiles.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/auth-profiles/profiles.js")>()),
  promoteAuthProfileInOrder: vi.fn(async () => ({ ok: true, value: { version: 1, profiles: {} } })),
}));
afterEach(() => {
  vi.unstubAllGlobals();
});

it("removes copied xAI thinking fields from disk through runModelsAuthLoginFlowCore", async () => {
  const gatewayPort = await acquireTestPortBlock({ offsets: [0] });
  onTestFinished(() => gatewayPort.release());
  await withOpenClawTestState({ label: "xai-login-config" }, async (state) => {
    const model = createTestModelDefinition("grok-4.6", {
      reasoning: true,
      thinkingLevelMap: { xhigh: null },
      compat: { supportedReasoningEfforts: ["low", "high"] },
    });
    const other = { ...model, id: "custom", thinkingLevelMap: { xhigh: "high" } };
    const provider = (models: (typeof model)[], baseUrl: string) => ({
      api: "openai-responses",
      baseUrl,
      models,
    });
    await state.writeConfig({
      gateway: { mode: "local", port: gatewayPort.port },
      plugins: { allow: ["xai"] },
      agents: {
        defaults: { model: "xai/grok-4.6", workspace: state.workspaceDir },
      },
      models: {
        providers: {
          xai: { ...provider([model], "https://cli-chat-proxy.grok.com/v1"), auth: "oauth" },
          custom: provider([other], "https://custom.example.invalid/v1"),
        },
      },
    });
    const responses: Record<string, unknown> = {
      "/.well-known/openid-configuration": {
        device_authorization_endpoint: "https://auth.x.ai/code",
        token_endpoint: "https://auth.x.ai/token",
      },
      "/code": {
        device_code: "device",
        user_code: "code",
        verification_uri: "https://auth.x.ai/device",
        interval: 1,
      },
      "/token": {
        access_token: "fixture-access",
        refresh_token: "fixture-refresh",
        expires_in: 86400,
      },
      "/models": {
        data: [
          {
            id: model.id,
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
        const response = responses[new URL(url).pathname];
        if (response) {
          return jsonResponse(response);
        }
        throw new Error(`Unexpected xAI login request: ${url}`);
      }),
    );
    await runModelsAuthLoginFlowCore({
      provider: "xai",
      method: "oauth",
      agent: "main",
      runtime: createRuntimeEnv(),
      prompter: createTestWizardPrompter(),
      openUrl: async () => {},
    });
    const saved = JSON.parse(await fs.readFile(state.configPath, "utf8"));
    const row = saved.models.providers.xai.models.find(
      (candidate: { id: string }) => candidate.id === model.id,
    );
    expect(row.reasoning).toBe(true);
    expect(row).not.toHaveProperty("thinkingLevelMap");
    expect(row.compat ?? {}).not.toHaveProperty("supportedReasoningEfforts");
    expect(saved.models.providers.custom.models).toEqual([other]);
  });
});
