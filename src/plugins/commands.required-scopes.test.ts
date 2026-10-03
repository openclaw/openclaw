import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  const match = matchPluginCommand("/pairlike");
  if (!match) {
    throw new Error("expected scoped plugin command match");
  }
  return match.command;
}

beforeEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
});

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

describe("plugin command required scopes", () => {
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

  it("allows command owners to run scoped plugin commands without gateway scopes", async () => {
    let observedOwnerStatus: boolean | undefined;
    const handler = vi.fn(async (ctx: { senderIsOwner?: boolean }) => {
      observedOwnerStatus = ctx.senderIsOwner;
      return { text: "ok" };
    });
    const result = await executePluginCommand({
      command: registerScopedCommand(handler),
      channel: "telegram",
      isAuthorizedSender: true,
      senderIsOwner: true,
      commandBody: "/pairlike",
      config: {},
    });

    expect(result).toEqual({ text: "ok" });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(observedOwnerStatus).toBe(true);
  });

  it.each([
    {
      name: "command owners with insufficient explicit gateway scopes",
      senderIsOwner: true,
      channel: "webchat",
      gatewayClientScopes: ["operator.write"],
    },
    {
      name: "non-owners without gateway scopes",
      senderIsOwner: false,
      channel: "telegram",
      gatewayClientScopes: undefined,
    },
  ])("rejects $name", async ({ senderIsOwner, channel, gatewayClientScopes }) => {
    const handler = vi.fn(async () => ({ text: "ok" }));
    const result = await executePluginCommand({
      command: registerScopedCommand(handler),
      channel,
      isAuthorizedSender: true,
      senderIsOwner,
      commandBody: "/pairlike",
      gatewayClientScopes,
      config: {},
    });
    expect(result).toEqual({ text: "⚠️ This command requires gateway scope: operator.pairing." });
    expect(handler).not.toHaveBeenCalled();
  });
});
