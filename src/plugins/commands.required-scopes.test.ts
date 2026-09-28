import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executePluginCommand, matchPluginCommand, registerPluginCommand } from "./commands.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";

function requirePluginCommandMatch(commandBody: string) {
  const match = matchPluginCommand(commandBody);
  if (!match) {
    throw new Error(`expected plugin command match for ${commandBody}`);
  }
  return match;
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
    { name: "undefined", requiredScopes: [undefined] },
    { name: "null", requiredScopes: [null] },
    { name: "false", requiredScopes: [false] },
    { name: "zero", requiredScopes: [0] },
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
    registerPluginCommand("demo-plugin", {
      name: "pairlike",
      description: "Scoped command",
      requiredScopes: ["operator.pairing"],
      handler,
    });
    const match = requirePluginCommandMatch("/pairlike");

    const result = await executePluginCommand({
      command: match.command,
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

  it("rejects command owners when explicit gateway scopes miss the required scope", async () => {
    const handler = vi.fn(async () => ({ text: "ok" }));
    registerPluginCommand("demo-plugin", {
      name: "pairlike",
      description: "Scoped command",
      requiredScopes: ["operator.pairing"],
      handler,
    });
    const match = requirePluginCommandMatch("/pairlike");

    const result = await executePluginCommand({
      command: match.command,
      channel: "webchat",
      isAuthorizedSender: true,
      senderIsOwner: true,
      commandBody: "/pairlike",
      gatewayClientScopes: ["operator.write"],
      config: {},
    });

    expect(result).toEqual({ text: "⚠️ This command requires gateway scope: operator.pairing." });
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects non-owner scoped plugin commands without gateway scopes", async () => {
    const handler = vi.fn(async () => ({ text: "ok" }));
    registerPluginCommand("demo-plugin", {
      name: "pairlike",
      description: "Scoped command",
      requiredScopes: ["operator.pairing"],
      handler,
    });
    const match = requirePluginCommandMatch("/pairlike");

    const result = await executePluginCommand({
      command: match.command,
      channel: "telegram",
      isAuthorizedSender: true,
      senderIsOwner: false,
      commandBody: "/pairlike",
      config: {},
    });

    expect(result).toEqual({ text: "⚠️ This command requires gateway scope: operator.pairing." });
    expect(handler).not.toHaveBeenCalled();
  });
});
