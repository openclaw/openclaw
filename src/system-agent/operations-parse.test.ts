// OpenClaw operation parser tests protect direct command routing before model fallback.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import {
  isPersistentSystemAgentOperation,
  parseSystemAgentOperation as parseSystemAgentOperationImpl,
  type SystemAgentOperation,
} from "./operations.js";
import {
  createSystemAgentPluginMetadataTestSnapshot,
  type SystemAgentPluginMetadataTestSnapshot,
} from "./system-agent.test-helpers.js";

let pluginMetadata: SystemAgentPluginMetadataTestSnapshot | undefined;

const parseSystemAgentOperation: typeof parseSystemAgentOperationImpl = (...args) =>
  pluginMetadata!.run(() => parseSystemAgentOperationImpl(...args));

function expectOperation<K extends SystemAgentOperation["kind"]>(
  command: string,
  kind: K,
  fields?: Omit<Extract<SystemAgentOperation, { kind: K }>, "kind">,
) {
  expect(parseSystemAgentOperation(command)).toEqual({ kind, ...fields });
}

function expectConfigSet(path: string, value: string) {
  expectOperation(`config set ${path} ${value}`, "config-set", { path, value });
}

function expectConfigSetRef(path: string, source: "env" | "store", id: string) {
  expectOperation(`config set-ref ${path} ${source} ${id}`, "config-set-ref", { path, source, id });
}

function expectInvalidConfigPath(command: string) {
  expectOperation(command, "none", {
    message: "Invalid config path. Check its quoting or escaping and try again.",
  });
}

beforeAll(() => {
  const config = {};
  setRuntimeConfigSnapshot(config, config);
  pluginMetadata = createSystemAgentPluginMetadataTestSnapshot(config);
});

afterAll(() => {
  clearRuntimeConfigSnapshot();
});

describe("parseSystemAgentOperation", () => {
  it.each([
    "agents.defaults.fastModeDefault",
    'agents.defaults.models["openai/gpt-5.2"].params.fastMode',
  ])("routes config unset %s as an approval-gated write", (path) => {
    const operation = parseSystemAgentOperation(`config unset ${path}`);
    expect(operation).toEqual({ kind: "config-unset", path });
    expect(isPersistentSystemAgentOperation(operation)).toBe(true);
  });

  it.each(["", "gateway..port", "gateway["])(
    "rejects malformed unset path %s before model fallback",
    (path) => expectInvalidConfigPath(`config unset ${path}`),
  );

  it("parses typed model writes", () => {
    const model = "openai/gpt-5.2";
    expectOperation(`set default model ${model}`, "set-default-model", { model });
    expectOperation(`configure models ${model}`, "set-default-model", { model });
    expectOperation(`set default model ${model} for agent агент✨`, "set-default-model", {
      model,
      agentId: "агент✨",
    });
  });

  it("parses interactive model provider setup", () => {
    expectOperation("configure model provider", "model-setup");
    expectOperation("setup model provider", "model-setup");
    expectOperation("model setup workspace /tmp/work", "model-setup", { workspace: "/tmp/work" });
  });

  it("parses verbal agent switching", () => {
    expectOperation("talk to work agent", "open-tui", { agentId: "work" });
  });

  it("routes ambiguous model requests to the AI instead of guessing", () => {
    for (const command of [
      "models please",
      "why did my gateway stop",
      "should I talk to my agent about this?",
      "set me up with telegram",
      "can I set the default model gpt-5.5 later?",
    ]) {
      expect(parseSystemAgentOperation(command).kind).toBe("none");
    }
  });

  it("parses gateway lifecycle operations", () => {
    expectOperation("gateway status", "gateway-status");
    expectOperation("restart gateway", "gateway-restart");
    expectOperation("start gateway", "gateway-start");
    expectOperation("stop gateway", "gateway-stop");
  });

  it("parses config and doctor repair operations", () => {
    expectOperation("validate config", "config-validate");
    expectConfigSet("gateway.port", "19001");
    expectConfigSet("channels.defaults.groupPolicy", '"open"');
    expectConfigSet("channels.modelByChannel.telegram.chat", '"openai/gpt-5.5"');
    expectConfigSet('channels.modelByChannel["token=prod"].chat', '"openai/gpt-5.5"');
    expectConfigSet('channels.synology-chat.accounts["prod.guild"].webhookUrl', '"secret"');
    expectConfigSet(String.raw`channels.synology-chat.accounts.prod\ guild.webhookUrl`, '"secret"');
    expectConfigSet('channels.synology-chat.accounts["prod=us"].webhookUrl', '"secret"');
    expectConfigSet('plugins.entries.codex.config.appServer.headers["X-Test"]', '"secret"');
    expectConfigSet('channels.synology-chat.accounts["token=prod"].webhookUrl', '"secret"');
    expectConfigSet(String.raw`plugins.entries.codex.config.appServer.headers.X\-Test`, '"secret"');
    expectConfigSet(String.raw`channels.synology-chat.accounts.token\=prod.webhookUrl`, '"secret"');
    expectConfigSet('channels.synology-chat.accounts["token=prod"].webhookPath', '"/hook"');
    expectConfigSet(String.raw`channels.synology-chat.accounts.token\=prod.webhookPath`, '"/hook"');
    expectConfigSetRef('channels.telegram.accounts["prod=us"].botToken', "env", "TELEGRAM_TOKEN");
    expectConfigSetRef(
      String.raw`channels.telegram.accounts.prod\=us.botToken`,
      "env",
      "TELEGRAM_TOKEN",
    );
    expectConfigSet('broadcast["token=prod"]', '["telegram"]');
    expectInvalidConfigPath('config set hooks.mappings["token=abcDEF123"].agentId main');
    expectInvalidConfigPath(
      'config set channels.buzz.groups["gateway.auth.token=ACTUAL_GATEWAY_TOKEN"].enabled true',
    );
    expectInvalidConfigPath("config set gateway.auth..token very-secret");
    expectInvalidConfigPath("config set gateway.auth.token=very-secret");
    expectInvalidConfigPath("config set gateway.auth.token=very-secret please");
    expectInvalidConfigPath('config set channels.synology-chat["webhookUrl=abcDEF123"] please');
    for (const command of [
      String.raw`config set gateway.auth.token\=very-secret please`,
      String.raw`config set gateway.auth.token\ very-secret please`,
      "config set gateway.auth.tokenabcDEF123 please",
      "config set gateway.auth.token_abcDEF123 please",
      "config set gateway.auth.token$abcDEF123 please",
      'config set gateway.auth["token=very-secret"] please',
      'config set gateway.auth["token very-secret"] please',
      'config set gateway.auth["token:very-secret"] please',
      'config set gateway.auth["token=very-secret"].nested please',
    ]) {
      expectInvalidConfigPath(command);
    }
    expectConfigSetRef("gateway.auth.token", "env", "GATEWAY_TOKEN");
    expectConfigSetRef("gateway.auth.token", "store", "GATEWAY_TOKEN");
    expectInvalidConfigPath("config set-ref gateway.auth.tokenabcDEF123 env GATEWAY_TOKEN");
    expectInvalidConfigPath("config set-ref gateway.auth.token=abcDEF123 env GATEWAY_TOKEN");
    expectInvalidConfigPath("config set-ref gateway.auth.token env 123:actual-gateway-token");
    expectOperation("doctor fix", "doctor-fix");
  });

  it("parses plugin management operations", () => {
    expectOperation("plugins list", "plugin-list");
    expectOperation("list plugin", "plugin-list");
    expectOperation("plugins search calendar sync", "plugin-search", { query: "calendar sync" });
    expectOperation("install npm plugin @openclaw/discord", "plugin-install", {
      spec: "npm:@openclaw/discord",
    });
    expectOperation("plugin install clawhub:openclaw-demo", "plugin-install", {
      spec: "clawhub:openclaw-demo",
    });
    expectOperation("plugin uninstall openclaw-demo", "plugin-uninstall", {
      pluginId: "openclaw-demo",
    });
    expectOperation("plugin install npm:@example/plugin", "none", {
      message:
        "OpenClaw installs only ClawHub, bundled, or official-catalog plugins. Use `openclaw plugins install <spec>` in a trusted shell to review an arbitrary executable source.",
    });
  });

  it.each(["openclaw-demo", "@composio/composio", "community/demo@1.2.3"])(
    "accepts the default ClawHub package %s for assistant installs",
    (spec) => {
      expect(parseSystemAgentOperation(`plugin install ${spec}`)).toEqual({
        kind: "plugin-install",
        spec,
      });
    },
  );

  it("parses config read and schema lookups", () => {
    for (const path of [
      "gateway.port",
      'channels.telegram.accounts["prod=us"].botToken',
      "channels.missing.opaque",
    ]) {
      expectOperation(`config get ${path}`, "config-get", { path });
    }
    expectOperation("config schema channels.telegram", "config-schema", {
      path: "channels.telegram",
    });
    expectOperation("config schema", "config-schema");
    expectOperation("config schema .", "config-schema", { path: "." });
    for (const command of [
      "config get gateway.auth.tokenabcDEF123",
      'config get gateway.auth["token=abcDEF123"]',
      String.raw`config get gateway.auth.token\=abcDEF123`,
      "config get gateway.auth.token abcDEF123",
      "config get channels.missing.opaque=abcDEF123",
      "config schema gateway.port=abcDEF123",
      "config schema gateway.auth.token=abcDEF123",
      'config schema gateway.auth["token=abcDEF123"]',
      "config schema channels.missing.opaque=abcDEF123",
    ]) {
      expectInvalidConfigPath(command);
    }
    // Read-only: no approval gate.
    expect(isPersistentSystemAgentOperation({ kind: "config-get", path: "gateway.port" })).toBe(
      false,
    );
    expect(isPersistentSystemAgentOperation({ kind: "config-schema" })).toBe(false);
  });

  it("parses agent creation requests", () => {
    expectOperation(
      'create agent qa-writer name "QA Writer" role writer workspace /tmp/qa-writer',
      "create-agent",
      {
        agentId: "qa-writer",
        name: "QA Writer",
        role: "writer",
        workspace: "/tmp/qa-writer",
      },
    );
    expectOperation("create agent editor role writer workspace /tmp/editor", "create-agent", {
      agentId: "editor",
      role: "writer",
      workspace: "/tmp/editor",
    });
    expect(parseSystemAgentOperation("create agent editor role unknown")).toMatchObject({
      kind: "none",
      message: expect.stringContaining("Unknown agent role"),
    });
    expectOperation("create team", "create-team");
    expectOperation(
      'create team coordinator lead prefix docs workspace "/tmp/my team"',
      "create-team",
      {
        coordinatorId: "lead",
        prefix: "docs",
        workspaceRoot: "/tmp/my team",
      },
    );
    expectOperation("create agent Work workspace /tmp/work model openai/gpt-5.2", "create-agent", {
      agentId: "work",
      workspace: "/tmp/work",
      model: "openai/gpt-5.2",
    });
    expectOperation("add agent ops", "create-agent", { agentId: "ops" });
    expectOperation("setup workspace /tmp/work model openai/gpt-5.5", "setup", {
      workspace: "/tmp/work",
      model: "openai/gpt-5.5",
    });
    expectOperation("setup agent ops", "create-agent", { agentId: "ops" });
  });
});
