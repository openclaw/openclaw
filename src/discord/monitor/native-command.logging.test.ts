import { ChannelType } from "discord-api-types/v10";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listNativeCommandSpecs } from "../../auto-reply/commands-registry.js";
import * as dispatcherModule from "../../auto-reply/reply/provider-dispatcher.js";
import type { loadConfig } from "../../config/config.js";
import * as pluginCommandsModule from "../../plugins/commands.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

const { infoMock } = vi.hoisted(() => ({
  infoMock: vi.fn(),
}));

vi.mock("../../logging/subsystem.js", () => {
  const makeLogger = () => ({
    subsystem: "discord/native-command",
    isEnabled: () => true,
    trace: vi.fn(),
    debug: vi.fn(),
    info: infoMock,
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: () => makeLogger(),
  });
  return { createSubsystemLogger: () => makeLogger() };
});

import { createDiscordNativeCommand } from "./native-command.js";

type MockCommandInteraction = {
  user: { id: string; username: string; globalName: string };
  channel: { type: ChannelType; id: string };
  guild: null;
  rawData: { id: string; member: { roles: string[] } };
  options: {
    getString: (name: string) => string | null;
    getNumber: ReturnType<typeof vi.fn>;
    getBoolean: ReturnType<typeof vi.fn>;
  };
  reply: ReturnType<typeof vi.fn>;
  followUp: ReturnType<typeof vi.fn>;
  client: object;
};

function createInteraction(values: Record<string, string>): MockCommandInteraction {
  return {
    user: {
      id: "owner",
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
      getString: (name: string) => values[name] ?? null,
      getNumber: vi.fn().mockReturnValue(null),
      getBoolean: vi.fn().mockReturnValue(null),
    },
    reply: vi.fn().mockResolvedValue({ ok: true }),
    followUp: vi.fn().mockResolvedValue({ ok: true }),
    client: {},
  };
}

describe("Discord native command routing logs", () => {
  beforeEach(() => {
    infoMock.mockClear();
    vi.restoreAllMocks();
  });

  it("does not include the raw prompt in info-level routing logs", async () => {
    const command = listNativeCommandSpecs({ provider: "discord" }).find(
      (entry) => entry.name === "config",
    );
    if (!command) {
      throw new Error("missing native command: config");
    }
    const cfg = {
      channels: {
        discord: {
          dm: { enabled: true, policy: "open" },
        },
      },
    } as ReturnType<typeof loadConfig>;
    const discordConfig = cfg.channels?.discord;
    const nativeCommand = createDiscordNativeCommand({
      command,
      cfg,
      discordConfig,
      accountId: "default",
      sessionPrefix: "discord:slash",
      ephemeralDefault: true,
      threadBindings: createNoopThreadBindingManager("default"),
    });
    const interaction = createInteraction({
      action: "set",
      path: "agents.default.token",
      value: "super-secret-value",
    });

    vi.spyOn(pluginCommandsModule, "matchPluginCommand").mockReturnValue(null);
    vi.spyOn(dispatcherModule, "dispatchReplyWithDispatcher").mockResolvedValue({
      counts: {
        final: 1,
        block: 0,
        tool: 0,
      },
    } as never);

    await (nativeCommand as { run: (interaction: unknown) => Promise<void> }).run(
      interaction as unknown,
    );

    const routedCall = infoMock.mock.calls.find(([message]) => message === "native command routed");
    const routedMeta = routedCall?.[1] as Record<string, unknown> | undefined;

    expect(routedMeta).toBeDefined();
    expect(routedMeta).not.toHaveProperty("prompt");
    expect(routedMeta).toMatchObject({
      commandName: "config",
      accountId: "default",
      channelId: "dm-1",
    });
  });
});
