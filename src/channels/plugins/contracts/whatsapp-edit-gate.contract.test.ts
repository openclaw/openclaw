import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import type { PluginRuntime } from "../../../plugins/runtime/types.js";
import { loadBundledPluginFacade } from "../../../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../../../test-utils/channel-plugins.js";
import { dispatchChannelMessageAction } from "../message-action-dispatch.js";
import { getBundledChannelPluginAsync } from "./test-helpers/bundled-channel-plugin-loader.js";

const currentChat = "+15555550100";
const otherChat = "+15555550101";
const otherChatJid = "15555550101@s.whatsapp.net";
const cfg: OpenClawConfig = { channels: { whatsapp: { allowFrom: [currentChat] } } };
const editMessage = vi.fn(async () => undefined);

const dispatch = (overrides: Partial<Parameters<typeof dispatchChannelMessageAction>[0]>) =>
  dispatchChannelMessageAction({
    cfg,
    channel: "whatsapp",
    action: "edit",
    accountId: "default",
    requesterAccountId: "default",
    conversationReadOrigin: "delegated",
    toolContext: { currentChannelProvider: "whatsapp", currentChannelId: currentChat },
    params: { to: otherChat, messageId: "sent-1", message: "updated" },
    ...overrides,
  });

describe("whatsapp edit host gate", () => {
  beforeEach(async () => {
    const plugin = await getBundledChannelPluginAsync("whatsapp");
    if (!plugin) {
      throw new Error("whatsapp plugin is not bundled");
    }
    setActivePluginRegistry(createTestRegistry([{ pluginId: "whatsapp", source: "test", plugin }]));
    editMessage.mockClear();
    const { setWhatsAppRuntime } = await loadBundledPluginFacade<{
      setWhatsAppRuntime: (runtime: PluginRuntime) => void;
    }>({ pluginId: "whatsapp", artifactBasename: "runtime-setter-api.js" });
    setWhatsAppRuntime({
      channel: {
        runtimeContexts: { get: () => ({ getActiveListener: () => ({ editMessage }) }) },
      },
    } as unknown as PluginRuntime);
  });

  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("stops a delegated caller naming another chat before any allowFrom error", async () => {
    await expect(dispatch({})).rejects.toThrow(
      "Delegated whatsapp:edit requires the exact current conversation and account",
    );
  });

  it("rejects a scheduled edit, since whatsapp keeps edit targets under the host gate", async () => {
    await expect(
      dispatch({
        messageActionAuthorization: {
          scheduled: { policy: { version: 1, mode: "trusted" }, assertCurrent: () => {} },
        },
      }),
    ).rejects.toThrow("Scheduled whatsapp:edit requires provider-owned target authorization.");
    expect(editMessage).not.toHaveBeenCalled();
  });

  it("carries a direct operator's edit of an allowed chat to the active listener", async () => {
    const result = await dispatch({
      cfg: { channels: { whatsapp: { allowFrom: [otherChat] } } },
      conversationReadOrigin: "direct-operator",
    });
    expect(result?.details).toEqual({
      ok: true,
      submitted: true,
      confirmed: false,
      messageId: "sent-1",
    });
    expect(editMessage).toHaveBeenCalledExactlyOnceWith(
      otherChatJid,
      "sent-1",
      "updated",
      undefined,
    );
  });

  it("re-reads allowFrom on every dispatch, so a removed chat stops the next edit", async () => {
    const dispatchOperator = (allowFrom: string[]) =>
      dispatch({
        cfg: { channels: { whatsapp: { allowFrom } } },
        conversationReadOrigin: "direct-operator",
      });

    await dispatchOperator([otherChat]);
    editMessage.mockClear();

    await expect(dispatchOperator([currentChat])).rejects.toMatchObject({
      name: "ToolAuthorizationError",
    });
    expect(editMessage).not.toHaveBeenCalled();
  });
});
