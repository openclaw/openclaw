// Anchored system-agent operation grammar tests.
import { describe, expect, it } from "vitest";
import { isPersistentSystemAgentOperation, parseSystemAgentOperation } from "./operations.js";

describe("parseSystemAgentOperation", () => {
  it("parses typed model writes", () => {
    expect(parseSystemAgentOperation("set default model openai/gpt-5.2")).toEqual({
      kind: "set-default-model",
      model: "openai/gpt-5.2",
    });
    expect(parseSystemAgentOperation("configure models openai/gpt-5.2")).toEqual({
      kind: "set-default-model",
      model: "openai/gpt-5.2",
    });
  });

  it("parses interactive model provider setup", () => {
    expect(parseSystemAgentOperation("configure model provider")).toEqual({
      kind: "model-setup",
    });
    expect(parseSystemAgentOperation("setup model provider")).toEqual({
      kind: "model-setup",
    });
    expect(parseSystemAgentOperation("model setup workspace /tmp/work")).toEqual({
      kind: "model-setup",
      workspace: "/tmp/work",
    });
  });

  it("parses verbal agent switching", () => {
    expect(parseSystemAgentOperation("talk to work agent")).toEqual({
      kind: "open-tui",
      agentId: "work",
    });
  });

  it("routes ambiguous model requests to the AI instead of guessing", () => {
    expect(parseSystemAgentOperation("models please").kind).toBe("none");
    expect(parseSystemAgentOperation("why did my gateway stop").kind).toBe("none");
    expect(parseSystemAgentOperation("should I talk to my agent about this?").kind).toBe("none");
    expect(parseSystemAgentOperation("set me up with telegram").kind).toBe("none");
    expect(parseSystemAgentOperation("can I set the default model gpt-5.5 later?").kind).toBe(
      "none",
    );
  });

  it("parses gateway lifecycle operations", () => {
    expect(parseSystemAgentOperation("gateway status")).toEqual({ kind: "gateway-status" });
    expect(parseSystemAgentOperation("restart gateway")).toEqual({ kind: "gateway-restart" });
    expect(parseSystemAgentOperation("start gateway")).toEqual({ kind: "gateway-start" });
    expect(parseSystemAgentOperation("stop gateway")).toEqual({ kind: "gateway-stop" });
  });

  it("parses config and doctor repair operations", () => {
    expect(parseSystemAgentOperation("validate config")).toEqual({ kind: "config-validate" });
    expect(parseSystemAgentOperation("config set gateway.port 19001")).toEqual({
      kind: "config-set",
      path: "gateway.port",
      value: "19001",
    });
    expect(
      parseSystemAgentOperation("config set-ref gateway.auth.token env GATEWAY_TOKEN"),
    ).toEqual({
      kind: "config-set-ref",
      path: "gateway.auth.token",
      source: "env",
      id: "GATEWAY_TOKEN",
    });
    expect(parseSystemAgentOperation("doctor fix")).toEqual({ kind: "doctor-fix" });
  });

  it("parses plugin management operations", () => {
    expect(parseSystemAgentOperation("plugins list")).toEqual({ kind: "plugin-list" });
    expect(parseSystemAgentOperation("list plugin")).toEqual({ kind: "plugin-list" });
    expect(parseSystemAgentOperation("plugins search calendar sync")).toEqual({
      kind: "plugin-search",
      query: "calendar sync",
    });
    expect(parseSystemAgentOperation("install npm plugin @openclaw/discord")).toEqual({
      kind: "plugin-install",
      spec: "npm:@openclaw/discord",
    });
    expect(parseSystemAgentOperation("plugin install clawhub:openclaw-demo")).toEqual({
      kind: "plugin-install",
      spec: "clawhub:openclaw-demo",
    });
    expect(parseSystemAgentOperation("plugin uninstall openclaw-demo")).toEqual({
      kind: "plugin-uninstall",
      pluginId: "openclaw-demo",
    });
    expect(parseSystemAgentOperation("plugin install npm:@example/plugin")).toEqual({
      kind: "none",
      message:
        "OpenClaw installs only ClawHub, bundled, or official-catalog plugins. Use `openclaw plugins install <spec>` in a trusted shell to review an arbitrary executable source.",
    });
  });

  it("parses config read and schema lookups", () => {
    expect(parseSystemAgentOperation("config get gateway.port")).toEqual({
      kind: "config-get",
      path: "gateway.port",
    });
    expect(parseSystemAgentOperation("config schema channels.telegram")).toEqual({
      kind: "config-schema",
      path: "channels.telegram",
    });
    expect(parseSystemAgentOperation("config schema")).toEqual({ kind: "config-schema" });
    // Read-only: no approval gate.
    expect(isPersistentSystemAgentOperation({ kind: "config-get", path: "gateway.port" })).toBe(
      false,
    );
    expect(isPersistentSystemAgentOperation({ kind: "config-schema" })).toBe(false);
  });

  it("parses channel listing and connect requests", () => {
    expect(parseSystemAgentOperation("channels")).toEqual({ kind: "channel-list" });
    expect(parseSystemAgentOperation("list channels")).toEqual({ kind: "channel-list" });
    expect(parseSystemAgentOperation("connect telegram")).toEqual({
      kind: "channel-setup",
      channel: "telegram",
    });
    expect(parseSystemAgentOperation("connect to WhatsApp")).toEqual({
      kind: "channel-setup",
      channel: "whatsapp",
    });
    expect(parseSystemAgentOperation("link discord channel")).toEqual({
      kind: "channel-setup",
      channel: "discord",
    });
    // Starting the wizard is not a write; the wizard collects explicit answers.
    expect(isPersistentSystemAgentOperation({ kind: "channel-setup", channel: "telegram" })).toBe(
      false,
    );
    expect(isPersistentSystemAgentOperation({ kind: "channel-list" })).toBe(false);
  });

  it("parses anchored setup switches and channel info", () => {
    for (const input of [
      "open setup wizard",
      "setup wizard",
      "menu setup",
      "use the setup wizard",
      "use the wizard",
    ]) {
      expect(parseSystemAgentOperation(input)).toEqual({ kind: "open-setup", target: "guided" });
    }
    for (const input of ["open classic wizard", "open classic setup wizard", "classic setup"]) {
      expect(parseSystemAgentOperation(input)).toEqual({ kind: "open-setup", target: "classic" });
    }
    expect(parseSystemAgentOperation("open channel wizard")).toEqual({
      kind: "open-setup",
      target: "channels",
    });
    expect(parseSystemAgentOperation("open channel wizard for Slack")).toEqual({
      kind: "open-setup",
      target: "channels",
      channel: "slack",
    });
    expect(parseSystemAgentOperation("channel info Slack")).toEqual({
      kind: "channel-info",
      channel: "slack",
    });
    expect(parseSystemAgentOperation("about Telegram channel")).toEqual({
      kind: "channel-info",
      channel: "telegram",
    });
    expect(parseSystemAgentOperation("please open the setup wizard soon").kind).toBe("none");
    expect(parseSystemAgentOperation("channel info slack please").kind).toBe("none");
  });
});
