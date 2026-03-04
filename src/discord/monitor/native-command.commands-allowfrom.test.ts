import { ChannelType } from "discord-api-types/v10";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeCommandSpec } from "../../auto-reply/commands-registry.js";
import * as dispatcherModule from "../../auto-reply/reply/provider-dispatcher.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createDiscordNativeCommand } from "./native-command.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

type MockCommandInteraction = {
  user: { id: string; username: string; globalName: string };
  channel: { type: ChannelType; id: string };
  guild: null;
  rawData: { id: string; member: { roles: string[] } };
  options: {
    getString: ReturnType<typeof vi.fn>;
    getNumber: ReturnType<typeof vi.fn>;
    getBoolean: ReturnType<typeof vi.fn>;
  };
  reply: ReturnType<typeof vi.fn>;
  followUp: ReturnType<typeof vi.fn>;
  client: object;
};

function createInteraction(userId = "owner"): MockCommandInteraction {
  return {
    user: {
      id: userId,
      username: "tester",
      globalName: "Tester",
    },
    channel: {
      type: ChannelType.DM,
      id: "dm-1",
    },
    guild: null,
    rawData: {
      id: "interaction-1",
      member: { roles: [] },
    },
    options: {
      getString: vi.fn().mockReturnValue(null),
      getNumber: vi.fn().mockReturnValue(null),
      getBoolean: vi.fn().mockReturnValue(null),
    },
    reply: vi.fn().mockResolvedValue({ ok: true }),
    followUp: vi.fn().mockResolvedValue({ ok: true }),
    client: {},
  };
}

const commandSpec: NativeCommandSpec = {
  name: "status",
  description: "Show status",
  acceptsArgs: false,
};

function createCommand(cfg: OpenClawConfig) {
  return createDiscordNativeCommand({
    command: commandSpec,
    cfg,
    discordConfig: cfg.channels?.discord ?? {},
    accountId: "default",
    sessionPrefix: "discord:slash",
    ephemeralDefault: true,
    threadBindings: createNoopThreadBindingManager("default"),
  });
}

/** Run the command handler; swallow downstream pipeline errors. */
async function runCommand(
  command: ReturnType<typeof createCommand>,
  interaction: MockCommandInteraction,
) {
  try {
    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);
  } catch {
    // Errors from the dispatch pipeline are expected when testing auth gating
    // in isolation — the mock dispatch result lacks full shape.
  }
}

function wasUnauthorized(interaction: MockCommandInteraction): boolean {
  return interaction.reply.mock.calls.some(
    (call: unknown[]) =>
      (call[0] as { content?: string })?.content === "You are not authorized to use this command.",
  );
}

describe("Discord native command commands.allowFrom gating", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects unauthorized sender with ephemeral message when commands.allowFrom is configured", async () => {
    const cfg = {
      channels: {
        discord: {
          dm: { enabled: true, policy: "open" },
        },
      },
      commands: {
        allowFrom: {
          discord: ["allowed-user-id"],
        },
      },
    } as OpenClawConfig;

    const command = createCommand(cfg);
    const interaction = createInteraction("unauthorized-user");

    const dispatchSpy = vi
      .spyOn(dispatcherModule, "dispatchReplyWithDispatcher")
      .mockResolvedValue({} as never);

    await runCommand(command, interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "You are not authorized to use this command.",
        ephemeral: true,
      }),
    );
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it("allows authorized sender when commands.allowFrom is configured", async () => {
    const cfg = {
      channels: {
        discord: {
          dm: { enabled: true, policy: "open" },
        },
      },
      commands: {
        allowFrom: {
          discord: ["allowed-user"],
        },
      },
    } as OpenClawConfig;

    const command = createCommand(cfg);
    const interaction = createInteraction("allowed-user");

    vi.spyOn(dispatcherModule, "dispatchReplyWithDispatcher").mockResolvedValue({} as never);

    await runCommand(command, interaction);

    expect(wasUnauthorized(interaction)).toBe(false);
  });

  it("allows all senders when commands.allowFrom contains wildcard", async () => {
    const cfg = {
      channels: {
        discord: {
          dm: { enabled: true, policy: "open" },
        },
      },
      commands: {
        allowFrom: {
          discord: ["*"],
        },
      },
    } as OpenClawConfig;

    const command = createCommand(cfg);
    const interaction = createInteraction("any-user");

    vi.spyOn(dispatcherModule, "dispatchReplyWithDispatcher").mockResolvedValue({} as never);

    await runCommand(command, interaction);

    expect(wasUnauthorized(interaction)).toBe(false);
  });

  it("allows all senders when commands.allowFrom global wildcard is set", async () => {
    const cfg = {
      channels: {
        discord: {
          dm: { enabled: true, policy: "open" },
        },
      },
      commands: {
        allowFrom: {
          "*": ["*"],
        },
      },
    } as OpenClawConfig;

    const command = createCommand(cfg);
    const interaction = createInteraction("any-user");

    vi.spyOn(dispatcherModule, "dispatchReplyWithDispatcher").mockResolvedValue({} as never);

    await runCommand(command, interaction);

    expect(wasUnauthorized(interaction)).toBe(false);
  });

  it("skips commands.allowFrom check when not configured", async () => {
    const cfg = {
      channels: {
        discord: {
          dm: { enabled: true, policy: "open" },
        },
      },
    } as OpenClawConfig;

    const command = createCommand(cfg);
    const interaction = createInteraction("any-user");

    vi.spyOn(dispatcherModule, "dispatchReplyWithDispatcher").mockResolvedValue({} as never);

    await runCommand(command, interaction);

    expect(wasUnauthorized(interaction)).toBe(false);
  });
});
