import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { executePluginCommand, matchPluginCommand, registerPluginCommand } from "./commands.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";

function registerScopedCommand(handler: Parameters<typeof registerPluginCommand>[1]["handler"]) {
  registerPluginCommand("demo-plugin", {
    name: "pairlike",
    description: "Scoped command",
    requiredScopes: ["operator.pairing"],
    handler,
  });
  return expectDefined(matchPluginCommand("/pairlike"), "scoped plugin command match").command;
}

beforeEach(() => setActivePluginRegistry(createEmptyPluginRegistry()));

afterEach(resetPluginRuntimeStateForTest);

const sparseRequiredScopes: unknown[] = [];
sparseRequiredScopes.length = 1;

it.each([
  { name: "empty string", requiredScopes: [""] },
  { name: "sparse array", requiredScopes: sparseRequiredScopes },
])(
  "rejects a falsy invalid required scope $name at registration and direct execution",
  async ({ requiredScopes }) => {
    const handler = vi.fn(async () => ({ text: "must not run" }));
    const command = {
      name: "voice",
      description: "Voice command",
      handler,
      requiredScopes,
    };
    const scope = requiredScopes[0];
    expect(registerPluginCommand("demo-plugin", command as never)).toEqual({
      ok: false,
      error:
        typeof scope === "string"
          ? `Command requiredScopes contains unknown operator scope: ${scope}`
          : "Command requiredScopes contains unknown operator scope",
    });
    expect(matchPluginCommand("/voice")).toBeNull();
    await expect(
      executePluginCommand({
        command: { ...command, pluginId: "demo-plugin" } as never,
        channel: "telegram",
        isAuthorizedSender: true,
        commandBody: "/voice",
        config: {},
      }),
    ).resolves.toEqual({ text: "⚠️ This command has invalid gateway scope configuration." });
    expect(handler).not.toHaveBeenCalled();
  },
);

it.each([
  [true, "telegram", undefined, true],
  [true, "webchat", ["operator.write"], false],
  [false, "telegram", undefined, false],
] satisfies Array<[boolean, string, string[] | undefined, boolean]>)(
  "enforces required scopes: owner=%s channel=%s scopes=%j allowed=%s",
  async (senderIsOwner, channel, gatewayClientScopes, allowed) => {
    const handler = vi.fn(async (ctx: { senderIsOwner?: boolean }) => ({
      text: ctx.senderIsOwner === true ? "owner" : "not-owner",
    }));
    const result = await executePluginCommand({
      command: registerScopedCommand(handler),
      channel,
      isAuthorizedSender: true,
      senderIsOwner,
      commandBody: "/pairlike",
      gatewayClientScopes,
      config: {},
    });
    expect(result).toEqual({
      text: allowed ? "owner" : "⚠️ This command requires gateway scope: operator.pairing.",
    });
    expect(handler).toHaveBeenCalledTimes(allowed ? 1 : 0);
  },
);
