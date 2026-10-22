// OpenClaw operation parser tests protect direct command routing before model fallback.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { listChannelSetupPlugins } from "../channels/plugins/setup-registry.js";
import { resolveChannelSetupEntries } from "../commands/channel-setup/discovery.js";
import { isStaticallyChannelConfigured } from "../config/channel-configured-shared.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import {
  executeSystemAgentOperation,
  isPersistentSystemAgentOperation,
  parseSystemAgentOperation as parseSystemAgentOperationImpl,
  type SystemAgentOperation,
} from "./operations.js";
import { createSystemAgentTestRuntime } from "./system-agent.runtime.test-support.js";
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
    expectConfigSet('plugins.entries.codex.config.appServer.headers["X-Test"]', '"secret"');
    expectConfigSet('channels.synology-chat.accounts["token=prod"].webhookUrl', '"secret"');
    expectConfigSet('broadcast["token=prod"]', '["telegram"]');
    expectInvalidConfigPath('config set hooks.mappings["token=abcDEF123"].agentId main');
    expectInvalidConfigPath("config set gateway.auth..token very-secret");
    expectInvalidConfigPath("config set gateway.auth.token=very-secret");
    expectInvalidConfigPath("config set gateway.auth.token=very-secret please");
    for (const command of [
      String.raw`config set gateway.auth.token\ very-secret please`,
      "config set gateway.auth.tokenabcDEF123 please",
    ]) {
      expectInvalidConfigPath(command);
    }
    expectConfigSetRef("gateway.auth.token", "env", "GATEWAY_TOKEN");
    expectConfigSetRef("gateway.auth.token", "store", "GATEWAY_TOKEN");
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
      "config get channels.missing.opaque=abcDEF123",
      "config schema gateway.port=abcDEF123",
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
      'create agent ledger purpose "Check arithmetic in synthetic order lists." workspace "/tmp/ledger"',
      "create-agent",
      {
        agentId: "ledger",
        purpose: "Check arithmetic in synthetic order lists.",
        workspace: "/tmp/ledger",
      },
    );
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

// mock-isolation: Setup guidance uses synthetic plugins without loading installed channel runtimes.
vi.mock("../channels/plugins/setup-registry.js", () => ({ listChannelSetupPlugins: vi.fn() }));
vi.mock("../commands/channel-setup/discovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/channel-setup/discovery.js")>()),
  resolveChannelSetupEntries: vi.fn(),
}));
vi.mock("../config/channel-configured-shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/channel-configured-shared.js")>()),
  isStaticallyChannelConfigured: vi.fn(),
}));

function expectSetupOperation(
  input: string,
  operation: ReturnType<typeof parseSystemAgentOperation>,
) {
  expect(parseSystemAgentOperation(input)).toEqual(operation);
}
function expectLines(lines: string[], expected: string[]) {
  for (const text of expected) {
    expect(lines.join("\n")).toContain(text);
  }
}

describe("system agent setup-flow operations", () => {
  it("parses channel listing and connect requests", () => {
    expectSetupOperation("channels", { kind: "channel-list" });
    expectSetupOperation("list channels", { kind: "channel-list" });
    expectSetupOperation("connect telegram", { kind: "channel-setup", channel: "telegram" });
    expectSetupOperation("connect to WhatsApp", { kind: "channel-setup", channel: "whatsapp" });
    expectSetupOperation("link discord channel", { kind: "channel-setup", channel: "discord" });
    // Starting the wizard is not a write; the wizard collects explicit answers.
    expect(isPersistentSystemAgentOperation({ kind: "channel-setup", channel: "telegram" })).toBe(
      false,
    );
    expect(isPersistentSystemAgentOperation({ kind: "channel-list" })).toBe(false);
  });

  it("parses hosted skills, web-search, and Gateway setup requests", () => {
    for (const input of ["configure skills", "setup skills", "set up skills"]) {
      expect(parseSystemAgentOperation(input)).toEqual({ kind: "skills-setup" });
    }
    for (const input of [
      "configure search",
      "configure web search",
      "setup search",
      "web search provider setup",
    ]) {
      expect(parseSystemAgentOperation(input)).toEqual({ kind: "search-setup" });
    }
    expect(parseSystemAgentOperation("open search wizard")).toEqual({
      kind: "open-setup",
      target: "search",
    });
    for (const input of ["configure gateway", "set up gateway", "gateway settings"]) {
      expect(parseSystemAgentOperation(input)).toEqual({ kind: "gateway-config-setup" });
    }
    expect(parseSystemAgentOperation("open gateway wizard")).toEqual({
      kind: "open-setup",
      target: "gateway",
    });
    expect(isPersistentSystemAgentOperation({ kind: "skills-setup" })).toBe(false);
    expect(isPersistentSystemAgentOperation({ kind: "search-setup" })).toBe(false);
    expect(isPersistentSystemAgentOperation({ kind: "gateway-config-setup" })).toBe(false);
    expect(parseSystemAgentOperation("configure search with brave").kind).toBe("none");
  });

  it("parses the exact memory-import grammar", () => {
    for (const input of ["import memory", "import memories", "memory import"]) {
      expect(parseSystemAgentOperation(input)).toEqual({ kind: "memory-import" });
    }
    expect(isPersistentSystemAgentOperation({ kind: "memory-import" })).toBe(false);
    expect(parseSystemAgentOperation("import memory from codex").kind).toBe("none");
  });

  it("parses anchored setup switches and channel info", () => {
    for (const input of [
      "open setup wizard",
      "setup wizard",
      "menu setup",
      "use the setup wizard",
      "use the wizard",
    ]) {
      expectSetupOperation(input, { kind: "open-setup", target: "guided" });
    }
    for (const input of ["open classic wizard", "open classic setup wizard", "classic setup"]) {
      expectSetupOperation(input, { kind: "open-setup", target: "classic" });
    }
    expectSetupOperation("open channel wizard", { kind: "open-setup", target: "channels" });
    expectSetupOperation("open channel wizard for Slack", {
      kind: "open-setup",
      target: "channels",
      channel: "slack",
    });
    expectSetupOperation("channel info Slack", { kind: "channel-info", channel: "slack" });
    expectSetupOperation("about Telegram channel", { kind: "channel-info", channel: "telegram" });
    expect(parseSystemAgentOperation("please open the setup wizard soon").kind).toBe("none");
    expect(parseSystemAgentOperation("channel info slack please").kind).toBe("none");
  });

  it("prints one-shot setup pointers", async () => {
    const { runtime, lines } = createSystemAgentTestRuntime();

    for (const operation of [
      { kind: "open-setup", target: "guided" } as const,
      { kind: "open-setup", target: "classic" } as const,
      { kind: "open-setup", target: "channels", channel: "slack" } as const,
      { kind: "open-setup", target: "search" } as const,
      { kind: "open-setup", target: "gateway" } as const,
    ]) {
      const result = await executeSystemAgentOperation(operation, runtime);
      expect(result.applied).toBe(false);
    }

    expectLines(lines, [
      "openclaw onboard`",
      "openclaw onboard --classic",
      "openclaw channels add --channel slack",
      "openclaw configure --section web",
      "openclaw configure --section gateway",
      "on the machine running OpenClaw",
    ]);
  });

  it("prints one-shot pointers for hosted skills, search, and Gateway setup", async () => {
    const { runtime, lines } = createSystemAgentTestRuntime();

    await executeSystemAgentOperation({ kind: "skills-setup" }, runtime);
    await executeSystemAgentOperation({ kind: "search-setup" }, runtime);
    await executeSystemAgentOperation({ kind: "gateway-config-setup" }, runtime);

    expectLines(lines, [
      "openclaw configure --section skills",
      "openclaw configure --section web",
      "openclaw configure --section gateway",
    ]);
  });

  it("points one-shot memory import at interactive owners", async () => {
    const { runtime, lines } = createSystemAgentTestRuntime();

    await executeSystemAgentOperation({ kind: "memory-import" }, runtime);

    expect(lines.join("\n")).toContain("Memory page in the Control UI");
    expect(lines.join("\n")).toContain("openclaw onboard");
  });

  it("directs one-shot model setup to protected Models controls without a write", async () => {
    const { runtime, lines } = createSystemAgentTestRuntime();

    const result = await executeSystemAgentOperation({ kind: "model-setup" }, runtime);

    expect(result.applied).toBe(false);
    expectLines(lines, [
      "Settings → Models → Connect provider",
      "selected System or agent scope",
      "replacing credentials for a provider already in use",
    ]);
    expect(lines.join("\n")).not.toContain("openclaw onboard");
  });

  it("prints discovered channel metadata and sorted unknown-channel choices", async () => {
    const { runtime, lines } = createSystemAgentTestRuntime();
    const entries: ReturnType<typeof resolveChannelSetupEntries>["entries"] = (
      [
        ["telegram", "Telegram", "bot"],
        ["slack", "Slack", "app"],
      ] as const
    ).map(([id, label, kind]) => ({
      id,
      meta: {
        id,
        label,
        selectionLabel: label,
        blurb: `${label} ${kind} messaging.`,
        docsPath: `/channels/${id}`,
      },
    }));
    vi.mocked(listChannelSetupPlugins).mockReturnValue([
      {
        id: "slack",
        meta: entries[1]!.meta,
        capabilities: { chatTypes: ["direct"] },
        config: { listAccountIds: () => [], resolveAccount: () => ({}) },
      },
    ]);
    vi.mocked(resolveChannelSetupEntries).mockReturnValue({
      entries,
      installedCatalogEntries: [],
      installableCatalogEntries: [],
      installedCatalogById: new Map(),
      installableCatalogById: new Map(),
    });
    vi.mocked(isStaticallyChannelConfigured).mockImplementation(
      (_cfg, channel) => channel === "slack",
    );

    await executeSystemAgentOperation({ kind: "channel-info", channel: "slack" }, runtime);
    expectLines(lines, [
      "Slack (slack)",
      "Slack app messaging.",
      "Configured: yes",
      "Installed: yes",
      "https://docs.openclaw.ai/channels/slack",
      "open channel wizard for slack",
    ]);

    lines.length = 0;
    await executeSystemAgentOperation({ kind: "channel-info", channel: "matrix" }, runtime);
    expect(lines.join("\n")).toContain("Known channels: slack, telegram");
  });
});
