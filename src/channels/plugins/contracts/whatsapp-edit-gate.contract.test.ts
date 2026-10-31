import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import { createTestRegistry } from "../../../test-utils/channel-plugins.js";
import { dispatchChannelMessageAction } from "../message-action-dispatch.js";
import { getBundledChannelPluginAsync } from "./test-helpers/bundled-channel-plugin-loader.js";

const cfg: OpenClawConfig = { channels: { whatsapp: { allowFrom: ["+123"] } } };

const dispatch = (overrides: Partial<Parameters<typeof dispatchChannelMessageAction>[0]>) =>
  dispatchChannelMessageAction({
    cfg,
    channel: "whatsapp",
    action: "edit",
    accountId: "default",
    requesterAccountId: "default",
    conversationReadOrigin: "delegated",
    toolContext: { currentChannelProvider: "whatsapp", currentChannelId: "+123" },
    params: { to: "+999", messageId: "sent-1", message: "updated" },
    ...overrides,
  });

describe("whatsapp edit host gate", () => {
  beforeEach(async () => {
    const plugin = await getBundledChannelPluginAsync("whatsapp");
    if (!plugin) {
      throw new Error("whatsapp plugin is not bundled");
    }
    setActivePluginRegistry(createTestRegistry([{ pluginId: "whatsapp", source: "test", plugin }]));
  });

  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("stops a delegated caller naming another chat before any allowFrom error", async () => {
    await expect(dispatch({})).rejects.toThrow(
      "Delegated whatsapp:edit requires the exact current conversation and account",
    );
  });

  it("lets a direct operator past the host gate to the plugin's allowFrom check", async () => {
    await expect(dispatch({ conversationReadOrigin: "direct-operator" })).rejects.toMatchObject({
      name: "ToolAuthorizationError",
    });
  });
});
