// Internal hook event key validation tests.
import { describe, expect, it, vi } from "vitest";
import {
  isKnownInternalHookEventKey,
  type AgentBootstrapHookContext,
  type GatewayStartupHookEvent,
  type InternalHookEvent,
} from "./internal-hook-types.js";

describe("isKnownInternalHookEventKey", () => {
  it("accepts every emitted type:action key", () => {
    for (const key of [
      "agent:bootstrap",
      "command:new",
      "command:reset",
      "command:stop",
      "gateway:pre-restart",
      "gateway:shutdown",
      "gateway:startup",
      "message:preprocessed",
      "message:received",
      "message:sent",
      "message:transcribed",
      "session:auto-reset",
      "session:compact:after",
      "session:compact:before",
      "session:patch",
    ]) {
      expect(isKnownInternalHookEventKey(key), key).toBe(true);
    }
  });

  it("accepts bare family keys that subscribe to every action", () => {
    for (const family of ["command", "session", "agent", "gateway", "message"]) {
      expect(isKnownInternalHookEventKey(family), family).toBe(true);
    }
  });

  it("rejects typos, bare actions, and unknown families", () => {
    for (const key of [
      "command:nwe",
      "message:recieved",
      "startup", // bare action without its family
      "gateway:started",
      "session:compact", // partial multi-segment action
      "webhook:received",
      "",
      "COMMAND:NEW",
    ]) {
      expect(isKnownInternalHookEventKey(key), key).toBe(false);
    }
  });
});

describe("isAgentBootstrapEvent", () => {
  it.each([
    {
      name: "returns true for agent:bootstrap events with expected context",
      event: {
        type: "agent",
        action: "bootstrap",
        sessionKey: "test-session",
        context: {
          workspaceDir: "/tmp",
          bootstrapFiles: [],
        } satisfies AgentBootstrapHookContext,
        timestamp: new Date(0),
        messages: [],
      },
      expected: true,
    },
  ] satisfies Array<{
    name: string;
    event: InternalHookEvent;
    expected: boolean;
  }>)("$name", async ({ event, expected }) => {
    const { isAgentBootstrapEvent } = await import("./internal-hook-types.js");
    expect(isAgentBootstrapEvent(event)).toBe(expected);
  });
});

describe("isGatewayStartupEvent", () => {
  it.each([
    {
      name: "returns true for gateway:startup events with expected context",
      event: {
        type: "gateway",
        action: "startup",
        sessionKey: "gateway:startup",
        context: {
          cfg: {},
        } satisfies GatewayStartupHookEvent["context"],
        timestamp: new Date(0),
        messages: [],
      },
      expected: true,
    },
  ] satisfies Array<{
    name: string;
    event: InternalHookEvent;
    expected: boolean;
  }>)("$name", async ({ event, expected }) => {
    const { isGatewayStartupEvent } = await import("./internal-hook-types.js");
    expect(isGatewayStartupEvent(event)).toBe(expected);
  });
});

describe("hook facade", () => {
  it("classifies bootstrap events without loading the hook runtime", async () => {
    vi.resetModules();
    const runtime = vi.fn(() => {
      throw new Error("internal hook runtime loaded");
    });
    // mock-isolation: A throwing runtime trap proves the facade uses only the event owner.
    vi.doMock("./internal-hooks.js", runtime);
    try {
      const { isAgentBootstrapEvent } = await import("./hooks.js");
      const event: InternalHookEvent = {
        type: "agent",
        action: "bootstrap",
        sessionKey: "test-session",
        context: { workspaceDir: "/tmp", bootstrapFiles: [] },
        timestamp: new Date(0),
        messages: [],
      };
      expect(isAgentBootstrapEvent(event)).toBe(true);
      expect(runtime).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("./internal-hooks.js");
      vi.resetModules();
    }
  });
});
