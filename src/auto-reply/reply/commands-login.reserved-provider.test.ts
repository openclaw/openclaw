import fs from "node:fs/promises";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ReplyPayload } from "../types.js";
import {
  blockReplyOpts,
  buildLoginParams,
  dispatchLoginCommand,
  loginResult as successfulLogin,
  runModelsAuthLoginFlowMock,
  setupLoginCommandTests,
} from "./commands-login.harness-test-support.js";

const refreshAuthRuntime = vi.hoisted(() => vi.fn<() => Promise<void>>());
// mock-isolation: /login refresh must not publish auth state to a running Gateway.
vi.mock("../../gateway/model-auth-refresh.js", () => ({
  refreshModelAuthStateAfterMutation: refreshAuthRuntime,
}));

const { withOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");

function buildOwnerParams(
  body: string,
  config: OpenClawConfig,
  opts: ReturnType<typeof blockReplyOpts> = {},
) {
  const params = buildLoginParams(body, {
    opts: { ...blockReplyOpts(), getProviderLoginConfig: () => config, ...opts },
  });
  params.cfg = config;
  return params;
}

function loginChoiceCommand(reply: ReplyPayload | undefined, label: string): string {
  const button = reply?.presentation?.blocks
    .flatMap((block) => (block.type === "buttons" ? block.buttons : []))
    .find((entry) => entry.label === label);
  if (button?.action?.type !== "command") {
    throw new Error(`Expected ${label} in the login choices.`);
  }
  return button.action.command;
}

setupLoginCommandTests();

it.each([
  { provider: "refresh", label: "Refresh" },
  { provider: "access", label: "Access" },
])(
  "dispatches the manifest menu for $provider without shadowing reserved commands",
  async ({ provider, label }) => {
    await withOpenClawTestState({ label: "login-reserved-provider" }, async (state) => {
      const pluginId = "reserved-login";
      const pluginFile = await state.writeText(
        `${pluginId}/index.cjs`,
        "module.exports = { register() {} };\n",
      );
      await state.writeJson(`${pluginId}/openclaw.plugin.json`, {
        id: pluginId,
        configSchema: { type: "object", additionalProperties: false, properties: {} },
        providers: ["refresh", "access"],
        providerAuthChoices: ["refresh", "access"].flatMap((id) =>
          ["device-code", "oauth"].map((method) => ({
            provider: id,
            method,
            choiceId: method === "device-code" ? id : `${id}-browser`,
            choiceLabel: `${id} ${method}`,
            groupId: id,
            groupLabel: id === "refresh" ? "Refresh" : "Access",
            appGuidedAuth: method,
            credentialOnly: true,
            channelLogin: {},
          })),
        ),
      });
      const config: OpenClawConfig = {
        ...buildLoginParams("/login").cfg,
        plugins: {
          allow: [pluginId],
          load: { paths: [pluginFile] },
          entries: { [pluginId]: { enabled: true } },
        },
      };
      await state.writeConfig(config);
      const before = await fs.readFile(state.configPath, "utf8");
      const delivery = blockReplyOpts();
      const command = (body: string) =>
        dispatchLoginCommand(buildOwnerParams(body, config, delivery));
      const menu = await command("/login");
      const providerCommand = loginChoiceCommand(menu.reply, label);
      expect(providerCommand).toBe(`/login oauth/${pluginId}/${provider}`);
      const methods = await command(providerCommand);
      const methodCommand = loginChoiceCommand(methods.reply, `${provider} device-code`);
      expect(methodCommand).toBe(`/login ${pluginId}/${provider}`);
      expect(runModelsAuthLoginFlowMock).not.toHaveBeenCalled();
      runModelsAuthLoginFlowMock.mockResolvedValueOnce(successfulLogin(`${provider}:owner`));
      await command(methodCommand);
      expect(runModelsAuthLoginFlowMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ ownerPluginId: pluginId, provider, method: "device-code" }),
      );
      const refreshed = await command("/login refresh");
      expect(refreshed.reply?.text).toBe(
        "Sign-in status refreshed. Send /models to see available models.",
      );
      expect(refreshAuthRuntime).toHaveBeenCalledOnce();
      expect(runModelsAuthLoginFlowMock).toHaveBeenCalledOnce();
      expect(await fs.readFile(state.configPath, "utf8")).toBe(before);
    });
  },
);
