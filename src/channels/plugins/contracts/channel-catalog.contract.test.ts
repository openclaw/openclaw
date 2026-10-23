import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOpenClawCodingToolsInternalAsync } from "../../../agents/agent-tools.js";
import { resolveRuntimeChannelPromptContext } from "../../../agents/runtime-capabilities.js";
import { buildAgentSystemPrompt } from "../../../agents/system-prompt.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../../config/io.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { isPrereleaseSemverVersion } from "../../../infra/npm-registry-spec.js";
import {
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../../plugins/runtime.js";
import { createTestRegistry } from "../../../test-utils/channel-plugins.js";
import { getBundledChannelPluginAsync } from "./test-helpers/bundled-channel-plugin-loader.js";
import {
  describeBundledMetadataOnlyChannelCatalogContract,
  describeChannelCatalogEntryContract,
  describeOfficialFallbackChannelCatalogContract,
} from "./test-helpers/channel-catalog-contract.js";

for (const [channelId, npmSpec, alias] of [
  ["msteams", "@openclaw/msteams", "teams"],
  ["wecom", "@wecom/wecom-openclaw-plugin@2026.7.2", "wework"],
  ["yuanbao", "openclaw-plugin-yuanbao@2.18.2", "yb"],
  ["openclaw-zaloclawbot", "@zalo-platforms/openclaw-zaloclawbot@0.1.4", "zaloclawbot"],
] as const) {
  describeChannelCatalogEntryContract({ channelId, npmSpec, alias });
}

const whatsappPackageJson = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "extensions", "whatsapp", "package.json"), "utf8"),
) as {
  name?: string;
  version?: string;
  openclaw?: { install?: { npmSpec?: string } };
};
const whatsappNpmSpec = whatsappPackageJson.openclaw?.install?.npmSpec ?? whatsappPackageJson.name;
const whatsappVersion = whatsappPackageJson.version;
if (!whatsappNpmSpec || !whatsappVersion) {
  throw new Error("missing package metadata for whatsapp");
}
const whatsappCatalog = {
  pluginId: "whatsapp",
  channelId: "whatsapp",
  packageName: "@openclaw/whatsapp",
  npmSpec: "@openclaw/whatsapp",
  meta: {
    id: "whatsapp",
    label: "WhatsApp",
    selectionLabel: "WhatsApp (QR link)",
    detailLabel: "WhatsApp Web",
    docsPath: "/channels/whatsapp",
    blurb: "works with your own number; recommend a separate phone + eSIM.",
  },
};
describeBundledMetadataOnlyChannelCatalogContract({ ...whatsappCatalog, defaultChoice: "npm" });
describeOfficialFallbackChannelCatalogContract({
  ...whatsappCatalog,
  npmSpec: isPrereleaseSemverVersion(whatsappVersion)
    ? `${whatsappNpmSpec}@${whatsappVersion}`
    : whatsappNpmSpec,
  externalNpmSpec: "@vendor/whatsapp-fork",
  externalLabel: "WhatsApp Fork",
});

describe("ask_user channel catalogs", () => {
  const config: OpenClawConfig = {
    agents: { entries: { main: {} } },
    plugins: { enabled: false },
    tools: { allow: ["ask_user"] },
  };

  beforeEach(async () => {
    setRuntimeConfigSnapshot(config);
    const channels = await Promise.all(
      ["discord", "imessage", "mattermost", "signal", "slack", "telegram", "whatsapp"].map(
        async (pluginId) => {
          const plugin = await getBundledChannelPluginAsync(pluginId);
          if (!plugin) {
            throw new Error(`Missing bundled channel plugin for ${pluginId}`);
          }
          return { pluginId, plugin, source: "test" };
        },
      ),
    );
    setActivePluginRegistry(createTestRegistry(channels));
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    clearRuntimeConfigSnapshot();
  });

  it.each([
    { messageChannel: "webchat", available: true },
    { messageChannel: "discord", available: true },
    { messageChannel: "slack", available: true },
    { messageChannel: "telegram", available: true },
    { messageChannel: "whatsapp", available: false },
    { messageChannel: "imessage", available: false },
    { messageChannel: "signal", available: false },
    { messageChannel: "mattermost", available: false },
    { messageChannel: "unknown-channel", available: false },
    { messageChannel: "webchat", available: false, deny: true },
  ])(
    "uses the inbound $messageChannel capability (available: $available, deny: $deny)",
    async ({ messageChannel, available, deny }) => {
      const tools = await createOpenClawCodingToolsInternalAsync({
        config: deny ? { ...config, tools: { allow: ["ask_user"], deny: ["ask_user"] } } : config,
        sessionKey: "agent:main:run",
        messageChannel,
        messageProvider: "discord",
        toolConstructionPlan: {
          includeBaseCodingTools: false,
          includeShellTools: false,
          includeChannelTools: false,
          includeOpenClawTools: true,
          includePluginTools: false,
        },
      });
      expect(tools.some((tool) => tool.name === "ask_user")).toBe(available);
    },
  );
});

describe("Feishu system prompt button guidance", () => {
  beforeEach(async () => {
    const plugin = await getBundledChannelPluginAsync("feishu");
    if (!plugin) {
      throw new Error("Missing bundled Feishu channel plugin");
    }
    setActivePluginRegistry(createTestRegistry([{ pluginId: "feishu", plugin, source: "test" }]));
  });

  afterEach(() => resetPluginRuntimeStateForTest());

  it.each([{ capabilities: undefined }, { capabilities: ["inlineButtons"] }])(
    "does not advertise unsupported callbacks with capabilities $capabilities",
    ({ capabilities }) => {
      const cfg: OpenClawConfig = {
        channels: {
          feishu: {
            enabled: true,
            appId: "cli_test",
            appSecret: "synthetic-secret",
            ...(capabilities ? { capabilities } : {}),
          },
        },
      };
      const context = resolveRuntimeChannelPromptContext({ cfg, channel: "feishu" });
      const prompt = buildAgentSystemPrompt({
        workspaceDir: "/workspace",
        toolNames: ["message"],
        runtimeInfo: {
          channel: context.runtimeChannel,
          capabilities: context.runtimeCapabilities,
          customInlineButtonHint: context.customInlineButtonHint,
        },
        messageToolHints: context.messageToolHints,
      });

      expect(prompt).not.toContain("feishu.capabilities.inlineButtons");
      expect(prompt).not.toContain('"action":{"type":"callback"');
      expect(prompt).toContain("ask questions in plain text");
    },
  );
});
