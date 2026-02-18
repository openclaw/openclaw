import { describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext } from "./types.js";
import { handleGatewayRequest } from "../server-methods.js";

vi.mock("../../auto-reply/commands-registry.js", () => ({
  listChatCommands: () => [
    {
      key: "ping",
      nativeName: "ping",
      description: "Ping the bot",
      category: "utility",
      acceptsArgs: false,
      args: [
        {
          name: "mode",
          description: "Mode",
          choices: ["off", { value: "low", label: "Low" }],
        },
        {
          name: "dynamic",
          description: "Dynamic",
          choices: () => [],
        },
      ],
    },
    {
      key: "dock:telegram",
      nativeName: undefined,
      description: "Dock Telegram",
      category: undefined,
      acceptsArgs: true,
    },
  ],
}));

const makeContext = (): GatewayRequestContext => ({}) as unknown as GatewayRequestContext;

describe("gateway commands.list", () => {
  it("requires operator.read", async () => {
    const respond = vi.fn();

    await handleGatewayRequest({
      req: { type: "req", id: "1", method: "commands.list" },
      respond,
      client: { connect: { role: "operator", scopes: [] } },
      isWebchatConnect: () => false,
      context: makeContext(),
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "missing scope: operator.read" }),
    );
  });

  it("returns mapped command metadata for operator.read", async () => {
    const respond = vi.fn();

    await handleGatewayRequest({
      req: { type: "req", id: "1", method: "commands.list" },
      respond,
      client: { connect: { role: "operator", scopes: ["operator.read"] } },
      isWebchatConnect: () => false,
      context: makeContext(),
    });

    expect(respond).toHaveBeenCalledWith(true, [
      {
        name: "ping",
        description: "Ping the bot",
        category: "utility",
        acceptsArgs: false,
        args: [
          {
            name: "mode",
            description: "Mode",
            choices: [
              { value: "off", label: "off" },
              { value: "low", label: "Low" },
            ],
          },
          {
            name: "dynamic",
            description: "Dynamic",
            choices: undefined,
          },
        ],
      },
      {
        name: "dock:telegram",
        description: "Dock Telegram",
        category: "general",
        acceptsArgs: true,
        args: undefined,
      },
    ]);
  });
});
