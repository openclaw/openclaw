// Tests channel-native Codex login command routing and pairing-code delivery.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelsAuthLoginFlowOptions } from "../../commands/models/auth.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildBuiltinChatCommands } from "../commands-registry.shared.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const runModelsAuthLoginFlowMock = vi.hoisted(() => vi.fn());

vi.mock("../../commands/models/auth.js", () => ({
  runModelsAuthLoginFlow: (opts: unknown) => runModelsAuthLoginFlowMock(opts),
}));

const { handleLoginCommand, testing } = await import("./commands-login.js");
const { loadCommandHandlers } = await import("./commands-handlers.runtime.js");

function buildLoginParams(
  commandBody: string,
  overrides: {
    command?: Partial<HandleCommandsParams["command"]>;
    ctx?: Partial<HandleCommandsParams["ctx"]>;
    opts?: HandleCommandsParams["opts"];
    sessionKey?: string;
    sessionEntry?: HandleCommandsParams["sessionEntry"];
    agentId?: string;
  } = {},
): HandleCommandsParams {
  const params = buildCommandTestParams(
    commandBody,
    {
      commands: { text: true, ownerAllowFrom: ["owner"] },
      channels: { slack: { allowFrom: ["owner"] } },
      session: { mainKey: "main" },
    } as OpenClawConfig,
    {
      Provider: "slack",
      Surface: "slack",
      OriginatingChannel: "slack",
      OriginatingTo: "direct:owner",
      AccountId: "workspace-a",
      ChatType: "direct",
      MessageThreadId: "thread-1",
      ...overrides.ctx,
    },
    { workspaceDir: "/tmp/openclaw-login-test" },
  );
  params.sessionKey = overrides.sessionKey ?? "agent:main:slack:channel:C123";
  params.agentId = overrides.agentId;
  params.command = {
    ...params.command,
    channel: "slack",
    channelId: "slack",
    accountId: "workspace-a",
    senderId: "owner",
    senderIsOwner: true,
    isAuthorizedSender: true,
    from: "slack:owner",
    to: "direct:owner",
    ...overrides.command,
  };
  params.opts = overrides.opts;
  if (overrides.sessionEntry !== undefined) {
    params.sessionEntry = overrides.sessionEntry;
  }
  return params;
}

function mockSuccessfulLoginFlow(): void {
  runModelsAuthLoginFlowMock.mockImplementation(async (opts: ModelsAuthLoginFlowOptions) => {
    await opts.prompter.note?.(
      "Open https://auth.openai.com/device and enter code ABCD-EFGH. Never share this code.",
      "Codex login",
    );
    return {
      providerId: "openai",
      methodId: "device-code",
      profiles: [{ profileId: "openai:owner", provider: "openai", mode: "oauth" }],
    };
  });
}

function blockReplyOpts(): NonNullable<HandleCommandsParams["opts"]> {
  return { onBlockReply: vi.fn(async () => {}) };
}

describe("handleLoginCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testing.clearActiveFlows();
  });

  it("registers /login as a built-in command handler", () => {
    expect(buildBuiltinChatCommands().find((entry) => entry.key === "login")).toMatchObject({
      nativeName: "login",
      nativeProviders: ["telegram"],
      textAliases: ["/login"],
      scope: "both",
    });
    expect(loadCommandHandlers()).toContain(handleLoginCommand);
  });

  it("starts Codex device-code login and emits the pairing code through block delivery", async () => {
    const onBlockReply = vi.fn(async () => {});
    mockSuccessfulLoginFlow();

    const result = await handleLoginCommand(
      buildLoginParams("/login codex", { opts: { onBlockReply } }),
      true,
    );

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "Codex login complete. Try your request again now." },
    });
    expect(onBlockReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("ABCD-EFGH"),
      }),
    );
    expect(runModelsAuthLoginFlowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        method: "device-code",
        agent: "main",
        isRemote: true,
      }),
    );
  });

  it.each(["web", "discord", "slack"] as const)(
    "supports /login codex on the %s command surface",
    async (surface) => {
      const onBlockReply = vi.fn(async () => {});
      mockSuccessfulLoginFlow();

      const result = await handleLoginCommand(
        buildLoginParams("/login codex", {
          ctx: {
            Provider: surface,
            Surface: surface,
            OriginatingChannel: surface,
            OriginatingTo: "direct:conversation-1",
            ChatType: "direct",
          },
          command: {
            channel: surface,
            channelId: surface,
            to: "direct:conversation-1",
          },
          opts: { onBlockReply },
        }),
        true,
      );

      expect(result?.reply?.text).toBe("Codex login complete. Try your request again now.");
      expect(onBlockReply).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("https://auth.openai.com/device"),
        }),
      );
    },
  );

  it("rejects dispatcher-less contexts before starting device-code polling", async () => {
    mockSuccessfulLoginFlow();

    const result = await handleLoginCommand(buildLoginParams("/login openai"), true);

    expect(result?.reply?.text).toBe(
      "Codex login needs a live private response path so the code can be shown before it expires. Use the Web UI or a private chat and send `/login codex` again.",
    );
    expect(runModelsAuthLoginFlowMock).not.toHaveBeenCalled();
  });

  it("rejects grouped shared-channel login before emitting a device code", async () => {
    const onBlockReply = vi.fn(async () => {});
    mockSuccessfulLoginFlow();
    const params = buildLoginParams("/login codex", {
      ctx: {
        Provider: "slack",
        Surface: "slack",
        OriginatingChannel: "slack",
        OriginatingTo: "channel:C123",
        ChatType: "channel",
      },
      command: {
        channel: "slack",
        to: "channel:C123",
      },
      opts: { onBlockReply },
    });
    params.isGroup = true;

    const result = await handleLoginCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: {
        text: "Codex login codes are only sent in a private chat or Web UI session. Open a private chat with OpenClaw and send `/login codex` there.",
      },
    });
    expect(onBlockReply).not.toHaveBeenCalled();
    expect(runModelsAuthLoginFlowMock).not.toHaveBeenCalled();
  });

  it("reauths the active OpenAI profile when the session is pinned", async () => {
    mockSuccessfulLoginFlow();

    await handleLoginCommand(
      buildLoginParams("/login codex", {
        opts: blockReplyOpts(),
        sessionEntry: {
          authProfileOverride: "openai:owner@example.com",
          sessionId: "sess-owner",
          updatedAt: 1,
        },
      }),
      true,
    );

    expect(runModelsAuthLoginFlowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        profileId: "openai:owner@example.com",
      }),
    );
  });

  it("does not pass unrelated pinned profiles into OpenAI login", async () => {
    mockSuccessfulLoginFlow();

    await handleLoginCommand(
      buildLoginParams("/login codex", {
        opts: blockReplyOpts(),
        sessionEntry: {
          authProfileOverride: "anthropic:owner@example.com",
          sessionId: "sess-owner",
          updatedAt: 1,
        },
      }),
      true,
    );

    expect(runModelsAuthLoginFlowMock).toHaveBeenCalledWith(
      expect.not.objectContaining({
        profileId: expect.any(String),
      }),
    );
  });

  it("dedupes an active flow for the same channel thread and provider", async () => {
    let resolveLogin!: () => void;
    runModelsAuthLoginFlowMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLogin = () =>
            resolve({
              providerId: "openai",
              methodId: "device-code",
              profiles: [],
            });
        }),
    );

    const first = handleLoginCommand(
      buildLoginParams("/login codex", { opts: blockReplyOpts() }),
      true,
    );
    const second = await handleLoginCommand(
      buildLoginParams("/login codex", { opts: blockReplyOpts() }),
      true,
    );

    expect(second).toEqual({
      shouldContinue: false,
      reply: {
        text: "A Codex login code is already active for this chat or channel. Complete it, or wait for it to expire before requesting a new one.",
      },
    });
    resolveLogin();
    await first;
  });

  it("rejects non-owner senders before starting login", async () => {
    const result = await handleLoginCommand(
      buildLoginParams("/login codex", {
        command: { senderIsOwner: false },
      }),
      true,
    );

    expect(result).toEqual({
      shouldContinue: false,
      reply: {
        text: "Only a configured OpenClaw owner/admin can start Codex login from this channel.",
      },
    });
    expect(runModelsAuthLoginFlowMock).not.toHaveBeenCalled();
  });

  it("rejects allowlisted senders when no command owner is configured", async () => {
    const params = buildLoginParams("/login codex", {
      command: {
        senderIsOwner: true,
        isAuthorizedSender: true,
      },
    });
    params.cfg = {
      ...params.cfg,
      commands: { text: true },
    } as OpenClawConfig;

    const result = await handleLoginCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: {
        text: "Only a configured OpenClaw owner/admin can start Codex login from this channel.",
      },
    });
    expect(runModelsAuthLoginFlowMock).not.toHaveBeenCalled();
  });

  it("normalizes Codex login aliases to the OpenAI provider", async () => {
    mockSuccessfulLoginFlow();

    await handleLoginCommand(
      buildLoginParams("/login openai-codex", { opts: blockReplyOpts() }),
      true,
    );

    expect(runModelsAuthLoginFlowMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai" }),
    );
  });

  it("returns a friendly error for unsupported providers", async () => {
    const result = await handleLoginCommand(buildLoginParams("/login anthropic"), true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "Unsupported login provider. Use `/login codex`." },
    });
    expect(runModelsAuthLoginFlowMock).not.toHaveBeenCalled();
  });
});
