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
  parseSystemAgentOperation as parse,
  type SystemAgentOperation,
} from "./operations.js";
import { createSystemAgentTestRuntime } from "./system-agent.runtime.test-support.js";
import {
  createSystemAgentPluginMetadataTestSnapshot,
  type SystemAgentPluginMetadataTestSnapshot,
} from "./system-agent.test-helpers.js";

let metadata: SystemAgentPluginMetadataTestSnapshot;
beforeAll(() => {
  const config = {};
  setRuntimeConfigSnapshot(config, config);
  metadata = createSystemAgentPluginMetadataTestSnapshot(config);
});
afterAll(clearRuntimeConfigSnapshot);
const parseOperation = (input: string) => metadata.run(() => parse(input));

describe("operation grammar", () => {
  it.each([
    ["set default model openai/gpt-5.2", "set-default-model", { model: "openai/gpt-5.2" }],
    [
      "set default model openai/gpt-5.2 for agent агент✨",
      "set-default-model",
      { model: "openai/gpt-5.2", agentId: "агент✨" },
    ],
    ["configure model provider", "model-setup", {}],
    ["model setup workspace /tmp/work", "model-setup", { workspace: "/tmp/work" }],
    ["talk to work agent", "open-tui", { agentId: "work" }],
    ["gateway status", "gateway-status", {}],
    ["restart gateway", "gateway-restart", {}],
    ["start gateway", "gateway-start", {}],
    ["stop gateway", "gateway-stop", {}],
    ["validate config", "config-validate", {}],
    ["doctor fix", "doctor-fix", {}],
    ["plugins list", "plugin-list", {}],
    ["plugins search calendar sync", "plugin-search", { query: "calendar sync" }],
    ["install npm plugin @openclaw/discord", "plugin-install", { spec: "npm:@openclaw/discord" }],
    ["plugin install clawhub:openclaw-demo", "plugin-install", { spec: "clawhub:openclaw-demo" }],
    ["plugin install @composio/composio", "plugin-install", { spec: "@composio/composio" }],
    ["plugin uninstall openclaw-demo", "plugin-uninstall", { pluginId: "openclaw-demo" }],
    [
      'create agent Work name "QA" role writer purpose "Check sums." workspace "/tmp/my work" model openai/gpt-5.2',
      "create-agent",
      {
        agentId: "work",
        name: "QA",
        role: "writer",
        purpose: "Check sums.",
        workspace: "/tmp/my work",
        model: "openai/gpt-5.2",
      },
    ],
    ["add agent ops", "create-agent", { agentId: "ops" }],
    ["create team", "create-team", {}],
    [
      'create team coordinator lead prefix docs workspace "/tmp/my team"',
      "create-team",
      { coordinatorId: "lead", prefix: "docs", workspaceRoot: "/tmp/my team" },
    ],
    [
      "setup workspace /tmp/work model openai/gpt-5.5",
      "setup",
      { workspace: "/tmp/work", model: "openai/gpt-5.5" },
    ],
    ["channels", "channel-list", {}],
    ["connect to WhatsApp", "channel-setup", { channel: "whatsapp" }],
    ["configure skills", "skills-setup", {}],
    ["web search provider setup", "search-setup", {}],
    ["configure gateway", "gateway-config-setup", {}],
    ["import memory", "memory-import", {}],
    ["open setup wizard", "open-setup", { target: "guided" }],
    ["open classic wizard", "open-setup", { target: "classic" }],
    ["open search wizard", "open-setup", { target: "search" }],
    ["open gateway wizard", "open-setup", { target: "gateway" }],
    ["open channel wizard", "open-setup", { target: "channels" }],
    ["open channel wizard for Slack", "open-setup", { target: "channels", channel: "slack" }],
    ["about Telegram channel", "channel-info", { channel: "telegram" }],
    ["channel info Slack", "channel-info", { channel: "slack" }],
  ] as const)("routes %s", (input, kind, fields) => {
    expect(parseOperation(input)).toEqual({ kind, ...fields });
  });

  it.each([
    "models please",
    "set me up with telegram",
    "can I set the default model gpt-5.5 later?",
    "configure search with brave",
    "import memory from codex",
    "please open the setup wizard soon",
    "channel info slack please",
  ])("does not guess an operation for %s", (input) => {
    expect(parseOperation(input).kind).toBe("none");
  });
  it.each([
    ["create agent editor role unknown", "Unknown agent role"],
    ["plugin install npm:@example/plugin", "trusted shell"],
  ])("explains rejected command %s", (input, message) => {
    expect(parseOperation(input)).toMatchObject({
      kind: "none",
      message: expect.stringContaining(message),
    });
  });
  it.each([
    ["gateway.port", "19001"],
    ['channels.modelByChannel["token=prod"].chat', '"openai/gpt-5.5"'],
    ['channels.synology-chat.accounts["prod.guild"].webhookUrl', '"secret"'],
    [String.raw`channels.synology-chat.accounts.prod\ guild.webhookUrl`, '"secret"'],
    ['plugins.entries.codex.config.appServer.headers["X-Test"]', '"secret"'],
    ['broadcast["token=prod"]', '["telegram"]'],
  ])("preserves config write path %s", (path, value) => {
    expect(parseOperation(`config set ${path} ${value}`)).toEqual({
      kind: "config-set",
      path,
      value,
    });
  });
  it.each(["env", "store"])("parses a %s SecretRef", (source) => {
    expect(parseOperation(`config set-ref gateway.auth.token ${source} GATEWAY_TOKEN`)).toEqual({
      kind: "config-set-ref",
      path: "gateway.auth.token",
      source,
      id: "GATEWAY_TOKEN",
    });
  });
  it.each([
    'config set hooks.mappings["token=abcDEF123"].agentId main',
    "config set gateway.auth..token very-secret",
    "config set gateway.auth.token=very-secret",
    String.raw`config set gateway.auth.token\ very-secret please`,
    "config set gateway.auth.tokenabcDEF123 please",
    "config set-ref gateway.auth.token=abcDEF123 env GATEWAY_TOKEN",
    "config set-ref gateway.auth.token env 123:actual-gateway-token",
    "config get gateway.auth.tokenabcDEF123",
    "config get channels.missing.opaque=abcDEF123",
    "config schema gateway.port=abcDEF123",
    "config unset",
    "config unset gateway..port",
    "config unset gateway[",
  ])("keeps malformed or sensitive paths off model fallback: %s", (input) => {
    expect(parseOperation(input)).toEqual({
      kind: "none",
      message: "Invalid config path. Check its quoting or escaping and try again.",
    });
  });
  it.each([
    ["config get gateway.port", { kind: "config-get", path: "gateway.port" }, false],
    [
      "config get channels.missing.opaque",
      { kind: "config-get", path: "channels.missing.opaque" },
      false,
    ],
    [
      'config get channels.telegram.accounts["prod=us"].botToken',
      { kind: "config-get", path: 'channels.telegram.accounts["prod=us"].botToken' },
      false,
    ],
    [
      "config schema channels.telegram",
      { kind: "config-schema", path: "channels.telegram" },
      false,
    ],
    ["config schema", { kind: "config-schema" }, false],
    ["config schema .", { kind: "config-schema", path: "." }, false],
    [
      'config unset agents.defaults.models["openai/gpt-5.2"].params.fastMode',
      { kind: "config-unset", path: 'agents.defaults.models["openai/gpt-5.2"].params.fastMode' },
      true,
    ],
    ["connect telegram", { kind: "channel-setup", channel: "telegram" }, false],
    ["channels", { kind: "channel-list" }, false],
    ["configure skills", { kind: "skills-setup" }, false],
    ["configure search", { kind: "search-setup" }, false],
    ["configure gateway", { kind: "gateway-config-setup" }, false],
    ["import memory", { kind: "memory-import" }, false],
  ] satisfies Array<[string, SystemAgentOperation, boolean]>)(
    "classifies persistence for %s",
    (input, expected, persistent) => {
      const operation = parseOperation(input);
      expect(operation).toEqual(expected);
      expect(isPersistentSystemAgentOperation(operation)).toBe(persistent);
    },
  );
});

// mock-isolation: Discovery remains synthetic; no installed channel runtimes are loaded.
vi.mock("../channels/plugins/setup-registry.js", () => ({ listChannelSetupPlugins: vi.fn() }));
vi.mock("../commands/channel-setup/discovery.js", async (original) => ({
  ...(await original<typeof import("../commands/channel-setup/discovery.js")>()),
  resolveChannelSetupEntries: vi.fn(),
}));
vi.mock("../config/channel-configured-shared.js", async (original) => ({
  ...(await original<typeof import("../config/channel-configured-shared.js")>()),
  isStaticallyChannelConfigured: vi.fn(),
}));

it.each([
  [
    { kind: "open-setup", target: "guided" },
    ["openclaw onboard`", "on the machine running OpenClaw"],
  ],
  [{ kind: "open-setup", target: "classic" }, ["openclaw onboard --classic"]],
  [
    { kind: "open-setup", target: "channels", channel: "slack" },
    ["openclaw channels add --channel slack"],
  ],
  [{ kind: "open-setup", target: "search" }, ["openclaw configure --section web"]],
  [{ kind: "open-setup", target: "gateway" }, ["openclaw configure --section gateway"]],
  [{ kind: "skills-setup" }, ["openclaw configure --section skills"]],
  [{ kind: "search-setup" }, ["openclaw configure --section web"]],
  [{ kind: "gateway-config-setup" }, ["openclaw configure --section gateway"]],
  [{ kind: "memory-import" }, ["Memory page in the Control UI", "openclaw onboard"]],
  [
    { kind: "model-setup" },
    [
      "Settings → Models → Connect provider",
      "selected System or agent scope",
      "replacing credentials for a provider already in use",
    ],
  ],
] satisfies Array<[SystemAgentOperation, string[]]>)(
  "prints one-shot guidance for %j",
  async (operation, expected) => {
    const { runtime, lines } = createSystemAgentTestRuntime();
    expect((await executeSystemAgentOperation(operation, runtime)).applied).toBe(false);
    for (const text of expected) {
      expect(lines.join("\n")).toContain(text);
    }
    if (operation.kind === "model-setup") {
      expect(lines.join("\n")).not.toContain("openclaw onboard");
    }
  },
);

it("prints channel metadata and sorted unknown-channel choices", async () => {
  const { runtime, lines } = createSystemAgentTestRuntime();
  const entries = (
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
  for (const text of [
    "Slack (slack)",
    "Slack app messaging.",
    "Configured: yes",
    "Installed: yes",
    "https://docs.openclaw.ai/channels/slack",
    "open channel wizard for slack",
  ]) {
    expect(lines.join("\n")).toContain(text);
  }
  lines.length = 0;
  await executeSystemAgentOperation({ kind: "channel-info", channel: "matrix" }, runtime);
  expect(lines.join("\n")).toContain("Known channels: slack, telegram");
});
