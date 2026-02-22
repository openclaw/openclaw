import { beforeEach, describe, expect, it, vi } from "vitest";
import { runChannelLogin, runChannelLogout } from "./channel-auth.js";

const mocks = vi.hoisted(() => ({
  resolveChannelDefaultAccountId: vi.fn(),
  getChannelPlugin: vi.fn(),
  normalizeChannelId: vi.fn(),
  loadConfig: vi.fn(),
  resolveMessageChannelSelection: vi.fn(),
  setVerbose: vi.fn(),
  login: vi.fn(),
  logoutAccount: vi.fn(),
  resolveAccount: vi.fn(),
}));

vi.mock("../channels/plugins/helpers.js", () => ({
  resolveChannelDefaultAccountId: mocks.resolveChannelDefaultAccountId,
}));

vi.mock("../channels/plugins/index.js", () => ({
  getChannelPlugin: mocks.getChannelPlugin,
  normalizeChannelId: mocks.normalizeChannelId,
}));

vi.mock("../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock("../infra/outbound/channel-selection.js", () => ({
  resolveMessageChannelSelection: mocks.resolveMessageChannelSelection,
}));

vi.mock("../globals.js", () => ({
  setVerbose: mocks.setVerbose,
}));

describe("channel-auth", () => {
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  const plugin = {
    auth: { login: mocks.login },
    gateway: { logoutAccount: mocks.logoutAccount },
    config: { resolveAccount: mocks.resolveAccount },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.normalizeChannelId.mockReturnValue("whatsapp");
    mocks.getChannelPlugin.mockReturnValue(plugin);
    mocks.loadConfig.mockReturnValue({ channels: {} });
    mocks.resolveMessageChannelSelection.mockResolvedValue({
      channel: "whatsapp",
      configured: ["whatsapp"],
    });
    mocks.resolveChannelDefaultAccountId.mockReturnValue("default-account");
    mocks.resolveAccount.mockReturnValue({ id: "resolved-account" });
    mocks.login.mockResolvedValue(undefined);
    mocks.logoutAccount.mockResolvedValue(undefined);
  });

  it("runs login with explicit trimmed account and verbose flag", async () => {
    await runChannelLogin({ channel: "wa", account: "  acct-1  ", verbose: true }, runtime);

    expect(mocks.setVerbose).toHaveBeenCalledWith(true);
    expect(mocks.resolveChannelDefaultAccountId).not.toHaveBeenCalled();
    expect(mocks.login).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: { channels: {} },
        accountId: "acct-1",
        runtime,
        verbose: true,
        channelInput: "wa",
      }),
    );
  });

  it("auto-picks the single configured channel when opts are empty", async () => {
    await runChannelLogin({}, runtime);

    expect(mocks.resolveMessageChannelSelection).toHaveBeenCalledWith({ cfg: { channels: {} } });
    expect(mocks.normalizeChannelId).toHaveBeenCalledWith("whatsapp");
    expect(mocks.login).toHaveBeenCalledWith(
      expect.objectContaining({
        channelInput: "whatsapp",
      }),
    );
  });

  it("propagates channel ambiguity when channel is omitted", async () => {
    mocks.resolveMessageChannelSelection.mockRejectedValueOnce(
      new Error("Channel is required when multiple channels are configured: telegram, slack"),
    );

    await expect(runChannelLogin({}, runtime)).rejects.toThrow("Channel is required");
    expect(mocks.login).not.toHaveBeenCalled();
  });

  it("throws for unsupported channel aliases", async () => {
    mocks.normalizeChannelId.mockReturnValueOnce(undefined);

    await expect(runChannelLogin({ channel: "bad-channel" }, runtime)).rejects.toThrow(
      "Unsupported channel: bad-channel",
    );
    expect(mocks.login).not.toHaveBeenCalled();
  });

  it("throws when channel does not support login", async () => {
    mocks.getChannelPlugin.mockReturnValueOnce({
      auth: {},
      gateway: { logoutAccount: mocks.logoutAccount },
      config: { resolveAccount: mocks.resolveAccount },
    });

    await expect(runChannelLogin({ channel: "whatsapp" }, runtime)).rejects.toThrow(
      "Channel whatsapp does not support login",
    );
  });

  it("runs logout with resolved account and explicit account id", async () => {
    await runChannelLogout({ channel: "whatsapp", account: " acct-2 " }, runtime);

    expect(mocks.resolveAccount).toHaveBeenCalledWith({ channels: {} }, "acct-2");
    expect(mocks.logoutAccount).toHaveBeenCalledWith({
      cfg: { channels: {} },
      accountId: "acct-2",
      account: { id: "resolved-account" },
      runtime,
    });
    expect(mocks.setVerbose).not.toHaveBeenCalled();
  });

  it("throws when channel does not support logout", async () => {
    mocks.getChannelPlugin.mockReturnValueOnce({
      auth: { login: mocks.login },
      gateway: {},
      config: { resolveAccount: mocks.resolveAccount },
    });

    await expect(runChannelLogout({ channel: "whatsapp" }, runtime)).rejects.toThrow(
      "Channel whatsapp does not support logout",
    );
  });
});
