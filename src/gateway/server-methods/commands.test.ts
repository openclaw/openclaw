import { afterEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({})),
  listSkillCommandsForAgents: vi.fn(() => []),
  loadSessionEntry: vi.fn((sessionKey: string) => ({ canonicalKey: sessionKey })),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: hoisted.loadConfig,
}));

vi.mock("../../auto-reply/skill-commands.js", () => ({
  listSkillCommandsForAgents: hoisted.listSkillCommandsForAgents,
}));

vi.mock("../session-utils.js", () => ({
  loadSessionEntry: hoisted.loadSessionEntry,
}));

import { clearPluginCommands, registerPluginCommand } from "../../plugins/commands.js";
import { commandsHandlers } from "./commands.js";

const noop = () => false;

type CommandsListPayload = {
  commands?: Array<{
    key?: string;
    name?: string;
    slash?: string;
    scope?: string;
    source?: string;
    args?: Array<{
      name?: string;
      choices?: Array<{ value?: string; label?: string }>;
    }>;
  }>;
};

async function runCommandsList(params: Record<string, unknown>) {
  const respond = vi.fn();
  await commandsHandlers["commands.list"]({
    params,
    respond,
    context: {} as unknown as Parameters<(typeof commandsHandlers)["commands.list"]>[0]["context"],
    client: null,
    req: { id: "req-1", type: "req", method: "commands.list" },
    isWebchatConnect: noop,
  });
  return respond;
}

describe("commands.list", () => {
  afterEach(() => {
    clearPluginCommands();
    vi.clearAllMocks();
  });

  it("returns structured slash command metadata", async () => {
    const respond = await runCommandsList({});
    expect(respond).toHaveBeenCalledTimes(1);
    const [ok, payload] = respond.mock.calls[0] as [boolean, CommandsListPayload];
    expect(ok).toBe(true);
    const commands = payload?.commands ?? [];
    expect(commands.length).toBeGreaterThan(0);

    const help = commands.find((command) => command.key === "help");
    expect(help?.name).toBe("help");
    expect(help?.slash).toBe("/help");
    expect(help?.scope).toBe("both");
    expect(help?.source).toBe("core");

    const compact = commands.find((command) => command.key === "compact");
    expect(compact?.scope).toBe("text");

    const tts = commands.find((command) => command.key === "tts");
    const actionArg = tts?.args?.find((arg) => arg.name === "action");
    const values = (actionArg?.choices ?? []).map((choice) => choice.value);
    expect(values).toContain("on");
    expect(values).toContain("status");
  });

  it("includes plugin commands by default and supports includePlugins=false", async () => {
    const registered = registerPluginCommand("test-plugin", {
      name: "hello",
      description: "Say hi.",
      acceptsArgs: false,
      handler: async () => ({ text: "hi" }),
    });
    expect(registered.ok).toBe(true);

    const withPlugins = await runCommandsList({});
    const withPayload = withPlugins.mock.calls[0]?.[1] as CommandsListPayload | undefined;
    const withList = withPayload?.commands ?? [];
    const plugin = withList.find((command) => command.key === "plugin:hello");
    expect(plugin?.name).toBe("hello");
    expect(plugin?.scope).toBe("text");
    expect(plugin?.source).toBe("plugin");

    const withoutPlugins = await runCommandsList({ includePlugins: false });
    const withoutPayload = withoutPlugins.mock.calls[0]?.[1] as CommandsListPayload | undefined;
    const withoutList = withoutPayload?.commands ?? [];
    expect(withoutList.some((command) => command.key === "plugin:hello")).toBe(false);
  });

  it("uses sessionKey to resolve skill commands for the routed agent", async () => {
    hoisted.loadSessionEntry.mockReturnValue({ canonicalKey: "agent:ops:discord:dm:u1" });
    await runCommandsList({ sessionKey: "main" });
    expect(hoisted.loadSessionEntry).toHaveBeenCalledWith("main");
    expect(hoisted.listSkillCommandsForAgents).toHaveBeenCalledWith(
      expect.objectContaining({
        agentIds: ["ops"],
      }),
    );
  });

  it("rejects invalid params", async () => {
    const respond = await runCommandsList({ unknown: true });
    const [ok, payload, error] = respond.mock.calls[0] as [
      boolean,
      CommandsListPayload | undefined,
      { code?: string; message?: string } | undefined,
    ];
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(error?.code).toBe("INVALID_REQUEST");
    expect(error?.message ?? "").toContain("invalid commands.list params");
  });
});
