import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { handleProvidersCommand } from "./commands-providers.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const handleProviderSetupCommandMock = vi.hoisted(() =>
  vi.fn(async () => ({ text: "provider reply" })),
);

vi.mock("../../provider-setup/runtime.js", () => ({
  handleProviderSetupCommand: handleProviderSetupCommandMock,
}));

const cfg = {
  channels: {
    telegram: {
      allowFrom: ["owner"],
      configWrites: true,
    },
  },
} satisfies OpenClawConfig;

function buildTelegramCommandParams(commandBody: string) {
  const params = buildCommandTestParams(commandBody, cfg, {
    Provider: "telegram",
    Surface: "telegram",
    AccountId: "primary",
  });
  params.command = {
    ...params.command,
    channel: "telegram",
    commandBodyNormalized: commandBody,
    rawBodyNormalized: commandBody,
    senderId: "owner",
    senderIsOwner: true,
    isAuthorizedSender: true,
    to: "telegram:owner-dm",
  };
  params.isGroup = false;
  return params;
}

describe("handleProvidersCommand", () => {
  beforeEach(() => {
    handleProviderSetupCommandMock.mockClear();
  });

  it("allows Telegram callback payloads when text commands are disabled", async () => {
    const result = await handleProvidersCommand(
      buildTelegramCommandParams("/providers c missing-callback"),
      false,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toBe("provider reply");
  });

  it("does not allow typed provider subcommands when text commands are disabled", async () => {
    const result = await handleProvidersCommand(
      buildTelegramCommandParams("/providers start"),
      false,
    );

    expect(result).toBeNull();
  });

  it("does not allow typed provider dashboard when text commands are disabled", async () => {
    const result = await handleProvidersCommand(buildTelegramCommandParams("/providers"), false);

    expect(result).toBeNull();
  });

  it("uses the originating Telegram chat instead of native slash targets", async () => {
    const params = buildTelegramCommandParams("/providers start");
    params.ctx.OriginatingTo = "telegram:owner-dm";
    params.command.to = "slash:owner";

    await handleProvidersCommand(params, true);

    expect(handleProviderSetupCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "telegram:owner-dm",
      }),
    );
  });
});
