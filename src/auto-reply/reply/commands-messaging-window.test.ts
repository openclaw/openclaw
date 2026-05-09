import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const replaceConfigFileMock = vi.hoisted(() => vi.fn(async () => undefined));
const resolveConfigWriteDeniedTextMock = vi.hoisted(() => vi.fn<() => string | null>(() => null));

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  replaceConfigFile: replaceConfigFileMock,
  validateConfigObjectWithPlugins: vi.fn((config: OpenClawConfig) => ({
    ok: true,
    config,
    issues: [],
  })),
}));

vi.mock("./config-write-authorization.js", () => ({
  resolveConfigWriteDeniedText: resolveConfigWriteDeniedTextMock,
}));

vi.mock("./channel-context.js", () => ({
  resolveChannelAccountId: vi.fn(() => undefined),
}));

const { handleMessagingWindowCommand } = await import("./commands-messaging-window.js");

function buildParams(
  commandBody: string,
  cfg: OpenClawConfig = { commands: { config: true } },
): ReturnType<typeof buildCommandTestParams> {
  const params = buildCommandTestParams(commandBody, cfg);
  params.command.senderIsOwner = true;
  params.command.isAuthorizedSender = true;
  params.command.channel = "whatsapp";
  params.command.channelId = "whatsapp";
  params.command.surface = "whatsapp";
  return params;
}

describe("handleMessagingWindowCommand", () => {
  beforeEach(() => {
    readConfigFileSnapshotMock.mockReset();
    replaceConfigFileMock.mockClear();
    resolveConfigWriteDeniedTextMock.mockReset().mockReturnValue(null);
    readConfigFileSnapshotMock.mockResolvedValue({
      valid: true,
      parsed: {},
    });
  });

  it("shows global, channel, and effective inbound debounce windows", async () => {
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: true,
      parsed: {
        messages: {
          inbound: {
            debounceMs: 1000,
            byChannel: { whatsapp: 5000 },
          },
        },
      },
    });

    const result = await handleMessagingWindowCommand(buildParams("/messaging_window"), true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("global: 1s");
    expect(result?.reply?.text).toContain("whatsapp: 5s");
    expect(result?.reply?.text).toContain("effective for whatsapp: 5s");
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
  });

  it("sets the global inbound debounce window", async () => {
    const result = await handleMessagingWindowCommand(
      buildParams("/messaging_window global 3s"),
      true,
    );

    expect(result?.reply?.text).toContain("global set to 3s");
    expect(replaceConfigFileMock).toHaveBeenCalledWith({
      nextConfig: { messages: { inbound: { debounceMs: 3000 } } },
      afterWrite: { mode: "auto" },
    });
  });

  it("sets the global inbound debounce window with Telegram-friendly shorthand", async () => {
    const result = await handleMessagingWindowCommand(buildParams("/messaging_window 3s"), true);

    expect(result?.reply?.text).toContain("global set to 3s");
    expect(replaceConfigFileMock).toHaveBeenCalledWith({
      nextConfig: { messages: { inbound: { debounceMs: 3000 } } },
      afterWrite: { mode: "auto" },
    });
  });

  it("sets the current channel inbound debounce window", async () => {
    const result = await handleMessagingWindowCommand(
      buildParams("/messaging_window channel current 2500ms"),
      true,
    );

    expect(result?.reply?.text).toContain("whatsapp set to 2500ms");
    expect(replaceConfigFileMock).toHaveBeenCalledWith({
      nextConfig: { messages: { inbound: { byChannel: { whatsapp: 2500 } } } },
      afterWrite: { mode: "auto" },
    });
  });

  it("sets the current channel inbound debounce window with shorthand", async () => {
    const result = await handleMessagingWindowCommand(
      buildParams("/messaging_window current 2500ms"),
      true,
    );

    expect(result?.reply?.text).toContain("whatsapp set to 2500ms");
    expect(replaceConfigFileMock).toHaveBeenCalledWith({
      nextConfig: { messages: { inbound: { byChannel: { whatsapp: 2500 } } } },
      afterWrite: { mode: "auto" },
    });
  });

  it("sets the current channel via safe fallback when channelId is missing", async () => {
    const params = buildParams("/messaging_window current 4s");
    params.command.channel = "custom-sms";
    params.command.channelId = undefined;
    params.command.surface = "custom-sms";

    const result = await handleMessagingWindowCommand(params, true);

    expect(result?.reply?.text).toContain("custom-sms set to 4s");
    expect(resolveConfigWriteDeniedTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: "channel", scope: { channelId: "custom-sms" } },
      }),
    );
    expect(replaceConfigFileMock).toHaveBeenCalledWith({
      nextConfig: { messages: { inbound: { byChannel: { "custom-sms": 4000 } } } },
      afterWrite: { mode: "auto" },
    });
  });

  it("authorizes global writes against safe external origin channels", async () => {
    const params = buildParams("/messaging_window 4s");
    params.command.channel = "custom-sms";
    params.command.channelId = undefined;
    params.command.surface = "custom-sms";

    const result = await handleMessagingWindowCommand(params, true);

    expect(result?.reply?.text).toContain("global set to 4s");
    expect(resolveConfigWriteDeniedTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "custom-sms",
        target: { kind: "global" },
      }),
    );
    expect(replaceConfigFileMock).toHaveBeenCalledWith({
      nextConfig: { messages: { inbound: { debounceMs: 4000 } } },
      afterWrite: { mode: "auto" },
    });
  });

  it("sets a named channel inbound debounce window with shorthand", async () => {
    const result = await handleMessagingWindowCommand(
      buildParams("/messaging_window telegram 5s"),
      true,
    );

    expect(result?.reply?.text).toContain("telegram set to 5s");
    expect(resolveConfigWriteDeniedTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: "channel", scope: { channelId: "telegram" } },
      }),
    );
    expect(replaceConfigFileMock).toHaveBeenCalledWith({
      nextConfig: { messages: { inbound: { byChannel: { telegram: 5000 } } } },
      afterWrite: { mode: "auto" },
    });
  });

  it("sets a safe external channel id even when it is not bundled", async () => {
    const result = await handleMessagingWindowCommand(
      buildParams("/messaging_window custom-sms 4s"),
      true,
    );

    expect(result?.reply?.text).toContain("custom-sms set to 4s");
    expect(resolveConfigWriteDeniedTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: "channel", scope: { channelId: "custom-sms" } },
      }),
    );
    expect(replaceConfigFileMock).toHaveBeenCalledWith({
      nextConfig: { messages: { inbound: { byChannel: { "custom-sms": 4000 } } } },
      afterWrite: { mode: "auto" },
    });
  });

  it("rejects unsafe external channel ids", async () => {
    const result = await handleMessagingWindowCommand(
      buildParams("/messaging_window ../telegram 4s"),
      true,
    );

    expect(result?.reply?.text).toContain("Unknown channel: ../telegram");
    expect(resolveConfigWriteDeniedTextMock).not.toHaveBeenCalled();
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
  });

  it("requires commands.config before writing the messaging window", async () => {
    const result = await handleMessagingWindowCommand(
      buildParams("/messaging_window global 3s", {}),
      true,
    );

    expect(result?.reply?.text).toContain("/messaging_window is disabled");
    expect(result?.reply?.text).toContain("commands.config=true");
    expect(resolveConfigWriteDeniedTextMock).not.toHaveBeenCalled();
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
  });

  it("resets a channel override without touching the global window", async () => {
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: true,
      parsed: {
        messages: {
          inbound: {
            debounceMs: 1000,
            byChannel: { whatsapp: 5000, telegram: 2000 },
          },
        },
      },
    });

    const result = await handleMessagingWindowCommand(
      buildParams("/messaging_window reset channel whatsapp"),
      true,
    );

    expect(result?.reply?.text).toContain("whatsapp set to unset");
    expect(replaceConfigFileMock).toHaveBeenCalledWith({
      nextConfig: {
        messages: {
          inbound: {
            debounceMs: 1000,
            byChannel: { telegram: 2000 },
          },
        },
      },
      afterWrite: { mode: "auto" },
    });
  });

  it("does not write when config-write policy denies the command", async () => {
    resolveConfigWriteDeniedTextMock.mockReturnValueOnce("Config writes are disabled");

    const result = await handleMessagingWindowCommand(
      buildParams("/messaging_window global 3s"),
      true,
    );

    expect(result?.reply?.text).toBe("Config writes are disabled");
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
  });
});
