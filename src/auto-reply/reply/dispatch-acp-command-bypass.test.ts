import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { shouldBypassAcpDispatchForCommand } from "./dispatch-acp-command-bypass.js";
import { buildTestCtx } from "./test-ctx.js";

describe("shouldBypassAcpDispatchForCommand", () => {
  it("returns false for plain-text ACP turns", () => {
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      BodyForCommands: "write a test",
      BodyForAgent: "write a test",
    });

    expect(shouldBypassAcpDispatchForCommand(ctx, {} as OpenClawConfig)).toBe(false);
  });

  it("returns true for /acp slash commands — regression for #66298", () => {
    // /acp text commands sent inside a thread bound to an ACP session must
    // bypass the ACP dispatch so they reach handleAcpCommand. Otherwise the
    // ACP agent consumes them as conversational input and the session stays
    // open regardless of what the user typed.
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      CommandBody: "/acp close",
      BodyForCommands: "/acp close",
      BodyForAgent: "/acp close",
    });

    expect(shouldBypassAcpDispatchForCommand(ctx, {} as OpenClawConfig)).toBe(true);
  });

  it("returns true for /acp slash commands via native command source", () => {
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      CommandSource: "native",
      CommandBody: "/acp status",
      BodyForCommands: "/acp status",
      BodyForAgent: "/acp status",
    });

    expect(shouldBypassAcpDispatchForCommand(ctx, {} as OpenClawConfig)).toBe(true);
  });

  it("returns true for /acp slash commands even when text commands are disabled", () => {
    // /acp is a session-management command (close/cancel/status/…), mirroring
    // /new and /reset. It must bypass the ACP dispatch even when the surface
    // has commands.text = false — otherwise the user has no way to close a
    // runaway ACP session short of hand-editing thread-bindings.json.
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      CommandBody: "/acp close",
      BodyForCommands: "/acp close",
      BodyForAgent: "/acp close",
      CommandSource: "text",
    });
    const cfg = {
      commands: {
        text: false,
      },
    } as OpenClawConfig;

    expect(shouldBypassAcpDispatchForCommand(ctx, cfg)).toBe(true);
  });

  it("returns false for /acp@otherbot (mention for another bot is intentionally ignored, see command-control.test.ts:901)", () => {
    // Project-wide convention (src/auto-reply/command-control.test.ts:901-912):
    // a `/cmd@bot` mention addressed to someone else's bot is intentionally
    // ignored. `normalizeCommandBody` only strips the `@mention` suffix when
    // it matches `options.botUsername`; otherwise the form is preserved and
    // downstream code must treat it as "not for us". The bypass regex must
    // stay tight (`(?:\s|$)`) so `/acp@otherbot close` does NOT short-circuit
    // ACP dispatch on our bot.
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      CommandBody: "/acp@otherbot close",
      BodyForCommands: "/acp@otherbot close",
      BodyForAgent: "/acp@otherbot close",
    });

    expect(shouldBypassAcpDispatchForCommand(ctx, {} as OpenClawConfig)).toBe(false);
  });

  it("returns false for /reset@otherbot (mention for another bot is intentionally ignored, see command-control.test.ts:901)", () => {
    // Symmetric to the /acp@otherbot case above. Same convention: a
    // `/reset@otherbot foo` form targeted at another bot must not cause our
    // bot to reset its session. Keeping the bypass regex tight (`(?:\s|$)`)
    // lets the message flow through to the normal dispatch, where the wrong-
    // bot form is ignored per `command-control.test.ts:901-912`.
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      CommandBody: "/reset@otherbot continue",
      BodyForCommands: "/reset@otherbot continue",
      BodyForAgent: "/reset@otherbot continue",
    });

    expect(shouldBypassAcpDispatchForCommand(ctx, {} as OpenClawConfig)).toBe(false);
  });

  it("returns false for unrecognized slash commands", () => {
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      CommandBody: "/foo cancel",
      BodyForCommands: "/foo cancel",
      BodyForAgent: "/foo cancel",
    });

    expect(shouldBypassAcpDispatchForCommand(ctx, {} as OpenClawConfig)).toBe(false);
  });

  it("returns true for ACP reset-tail slash commands", () => {
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      CommandSource: "native",
      CommandBody: "/new continue with deployment",
      BodyForCommands: "/new continue with deployment",
      BodyForAgent: "/new continue with deployment",
    });

    expect(shouldBypassAcpDispatchForCommand(ctx, {} as OpenClawConfig)).toBe(true);
  });

  it("returns true for bare ACP reset slash commands", () => {
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      CommandBody: "/reset",
      BodyForCommands: "/reset",
      BodyForAgent: "/reset",
    });

    expect(shouldBypassAcpDispatchForCommand(ctx, {} as OpenClawConfig)).toBe(true);
  });

  it("returns false for unrecognized slash commands when text commands are disabled", () => {
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      CommandBody: "/foo cancel",
      BodyForCommands: "/foo cancel",
      BodyForAgent: "/foo cancel",
      CommandSource: "text",
    });
    const cfg = {
      commands: {
        text: false,
      },
    } as OpenClawConfig;

    expect(shouldBypassAcpDispatchForCommand(ctx, cfg)).toBe(false);
  });

  it("returns false for unauthorized bang-prefixed commands", () => {
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      CommandBody: "!poll",
      BodyForCommands: "!poll",
      BodyForAgent: "!poll",
      CommandAuthorized: false,
    });

    expect(shouldBypassAcpDispatchForCommand(ctx, {} as OpenClawConfig)).toBe(false);
  });

  it("returns false for bang-prefixed commands when text commands are disabled", () => {
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      CommandBody: "!poll",
      BodyForCommands: "!poll",
      BodyForAgent: "!poll",
      CommandAuthorized: true,
      CommandSource: "text",
    });
    const cfg = {
      commands: {
        text: false,
      },
    } as OpenClawConfig;

    expect(shouldBypassAcpDispatchForCommand(ctx, cfg)).toBe(false);
  });

  it("returns true for authorized bang-prefixed commands when text commands are enabled", () => {
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      CommandBody: "!poll",
      BodyForCommands: "!poll",
      BodyForAgent: "!poll",
      CommandAuthorized: true,
      CommandSource: "text",
    });
    const cfg = {
      commands: {
        bash: true,
      },
    } as OpenClawConfig;

    expect(shouldBypassAcpDispatchForCommand(ctx, cfg)).toBe(true);
  });
});
