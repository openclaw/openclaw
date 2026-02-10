/**
 * Tests for plugin command registration, validation, and sessionKey passthrough.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  clearPluginCommands,
  executePluginCommand,
  getPluginCommandSpecs,
  listPluginCommands,
  matchPluginCommand,
  registerPluginCommand,
} from "./commands.js";
import type { PluginCommandContext } from "./types.js";

// Minimal config stub for tests
const testConfig = {} as OpenClawConfig;

function makeCommand(
  name: string,
  handler: (ctx: PluginCommandContext) => Promise<{ text: string }>,
) {
  registerPluginCommand(`test-plugin-${name}`, {
    name,
    description: `Test command: ${name}`,
    handler,
  });
}

afterEach(() => {
  clearPluginCommands();
});

describe("registerPluginCommand", () => {
  it("rejects malformed runtime command shapes", () => {
    const invalidName = registerPluginCommand(
      "demo-plugin",
      // Runtime plugin payloads are untyped; guard at boundary.
      {
        name: undefined as unknown as string,
        description: "Demo",
        handler: async () => ({ text: "ok" }),
      },
    );
    expect(invalidName).toEqual({
      ok: false,
      error: "Command name must be a string",
    });

    const invalidDescription = registerPluginCommand("demo-plugin", {
      name: "demo",
      description: undefined as unknown as string,
      handler: async () => ({ text: "ok" }),
    });
    expect(invalidDescription).toEqual({
      ok: false,
      error: "Command description must be a string",
    });
  });

  it("normalizes command metadata for downstream consumers", () => {
    const result = registerPluginCommand("demo-plugin", {
      name: "  demo_cmd  ",
      description: "  Demo command  ",
      handler: async () => ({ text: "ok" }),
    });
    expect(result).toEqual({ ok: true });
    expect(listPluginCommands()).toEqual([
      {
        name: "demo_cmd",
        description: "Demo command",
        pluginId: "demo-plugin",
      },
    ]);
    expect(getPluginCommandSpecs()).toEqual([
      {
        name: "demo_cmd",
        description: "Demo command",
      },
    ]);
  });
});

describe("executePluginCommand — sessionKey passthrough", () => {
  it("passes sessionKey to the command handler context", async () => {
    let receivedSessionKey: string | undefined;
    makeCommand("checksession", async (ctx) => {
      receivedSessionKey = ctx.sessionKey;
      return { text: "ok" };
    });

    const match = matchPluginCommand("/checksession");
    expect(match).not.toBeNull();

    await executePluginCommand({
      command: match!.command,
      args: match!.args,
      channel: "telegram",
      isAuthorizedSender: true,
      commandBody: "/checksession",
      config: testConfig,
      sessionKey: "agent:main:main",
    });

    expect(receivedSessionKey).toBe("agent:main:main");
  });

  it("passes undefined sessionKey when not provided", async () => {
    let receivedSessionKey: string | undefined = "sentinel";
    makeCommand("nosession", async (ctx) => {
      receivedSessionKey = ctx.sessionKey;
      return { text: "ok" };
    });

    const match = matchPluginCommand("/nosession");
    await executePluginCommand({
      command: match!.command,
      channel: "discord",
      isAuthorizedSender: true,
      commandBody: "/nosession",
      config: testConfig,
    });

    expect(receivedSessionKey).toBeUndefined();
  });

  it("passes different sessionKeys for different channels", async () => {
    const receivedKeys: string[] = [];
    makeCommand("multi", async (ctx) => {
      if (ctx.sessionKey) {
        receivedKeys.push(ctx.sessionKey);
      }
      return { text: "ok" };
    });

    const match1 = matchPluginCommand("/multi");
    expect(match1).not.toBeNull();

    await executePluginCommand({
      command: match1!.command,
      channel: "telegram",
      isAuthorizedSender: true,
      commandBody: "/multi",
      config: testConfig,
      sessionKey: "agent:main:main",
    });

    // matchPluginCommand works after execution completes (registry unlocked)
    const match2 = matchPluginCommand("/multi");
    expect(match2).not.toBeNull();

    await executePluginCommand({
      command: match2!.command,
      channel: "discord",
      isAuthorizedSender: true,
      commandBody: "/multi",
      config: testConfig,
      sessionKey: "agent:main:discord:dm:12345",
    });

    expect(receivedKeys).toEqual(["agent:main:main", "agent:main:discord:dm:12345"]);
  });
});
