// Tests MCP command configuration, listing, and enablement behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { withTempHome } from "../../config/home-env.test-harness.js";
import { REDACTED_SENTINEL } from "../../config/redact-snapshot.js";
import { OutboundDeliveryError } from "../../infra/outbound/deliver-types.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { handleMcpCommand } from "./commands-mcp.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const mcpServers = vi.hoisted(() => new Map<string, Record<string, unknown>>());
const privateRouteMocks = vi.hoisted(() => ({
  resolvePrivateCommandRouteTargets:
    vi.fn<typeof import("./commands-private-route.js").resolvePrivateCommandRouteTargets>(),
}));
const deliverOutboundPayloads = vi.hoisted(() =>
  vi.fn<typeof import("../../infra/outbound/deliver.js").deliverOutboundPayloadsInternal>(),
);

vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads,
  deliverOutboundPayloadsInternal: deliverOutboundPayloads,
}));
vi.mock("../../infra/outbound/deliver-runtime.js", () => ({
  deliverOutboundPayloads,
  deliverOutboundPayloadsInternal: deliverOutboundPayloads,
}));

vi.mock("../../config/mcp-config.js", () => ({
  listConfiguredMcpServers: vi.fn(async () => ({
    ok: true,
    path: "/tmp/openclaw.json",
    config: {},
    mcpServers: Object.fromEntries(mcpServers),
  })),
}));

vi.mock("../../agents/mcp-config-mutation.js", () => ({
  setConfiguredMcpServer: vi.fn(async ({ name, server }) => {
    mcpServers.set(name, { ...(server as Record<string, unknown>) });
    return {
      ok: true,
      path: "/tmp/openclaw.json",
      config: {},
      mcpServers: Object.fromEntries(mcpServers),
    };
  }),
  unsetConfiguredMcpServer: vi.fn(async ({ name }) => {
    const removed = mcpServers.delete(name);
    return {
      ok: true,
      path: "/tmp/openclaw.json",
      config: {},
      mcpServers: Object.fromEntries(mcpServers),
      removed,
    };
  }),
}));

vi.mock("./commands-private-route.js", async () => {
  const actual = await vi.importActual<typeof import("./commands-private-route.js")>(
    "./commands-private-route.js",
  );
  return {
    ...actual,
    resolvePrivateCommandRouteTargets: privateRouteMocks.resolvePrivateCommandRouteTargets,
  };
});

function expectMcpResult<T>(result: T | null): T {
  if (result === null) {
    throw new Error("expected MCP command result");
  }
  return result;
}

function buildCfg(): OpenClawConfig {
  return { commands: { text: true, mcp: true } };
}

async function runMcp(
  command: string,
  options: {
    owner?: boolean;
    group?: boolean;
    ctx?: Partial<HandleCommandsParams["ctx"]>;
  } = {},
) {
  const params = buildCommandTestParams(command, buildCfg(), options.ctx);
  params.command.senderIsOwner = options.owner ?? true;
  params.isGroup = options.group ?? false;
  return expectMcpResult(await handleMcpCommand(params, true));
}

function expectText(text: string | undefined, present: string[], absent: string[] = []) {
  for (const part of present) {
    expect(text).toContain(part);
  }
  for (const part of absent) {
    expect(text).not.toContain(part);
  }
}

function expectPrivateReply(
  result: Awaited<ReturnType<typeof runMcp>>,
  targets: string[],
  acknowledgement: string,
  absent = ["billing-server"],
) {
  expect(deliverOutboundPayloads.mock.calls.map(([request]) => request.to)).toEqual(targets);
  expectText(result.reply?.text, [acknowledgement], absent);
}

async function showGroupMcpConfig() {
  privateRouteMocks.resolvePrivateCommandRouteTargets.mockResolvedValue([
    { channel: "telegram", to: "owner-1" },
    { channel: "signal", to: "owner-2" },
  ]);
  mcpServers.set("billing-server", { command: "uvx", args: ["private-billing-mcp"] });
  return runMcp("/mcp show", { group: true });
}

describe("handleCommands /mcp", () => {
  afterEach(() => {
    mcpServers.clear();
    privateRouteMocks.resolvePrivateCommandRouteTargets.mockReset();
    deliverOutboundPayloads.mockReset();
    resetPluginRuntimeStateForTest();
  });

  it("writes MCP config and shows it back", async () => {
    await withTempHome("openclaw-command-mcp-home-", async () => {
      const setResult = await runMcp('/mcp set context7={"command":"uvx","args":["context7-mcp"]}');
      expect(setResult.reply?.text).toContain('MCP server "context7" saved');

      const showResult = await runMcp("/mcp show context7");
      expect(showResult.reply?.text).toContain('"command": "uvx"');
      expect(showResult.reply?.text).toContain('"args": [');
    });
  });

  it("blocks authorized non-owner senders from writing MCP config", async () => {
    await withTempHome("openclaw-command-mcp-home-", async () => {
      mcpServers.set("existing", { command: "uvx", args: ["existing-mcp"] });
      const setResult = await runMcp(
        '/mcp set evil={"command":"/bin/sh","args":["-c","id > /tmp/pwned"]}',
        { owner: false },
      );
      expect(setResult).toEqual({
        shouldContinue: false,
        reply: { text: expect.stringContaining("commands.ownerAllowFrom") },
      });
      expect(mcpServers.has("evil")).toBe(false);

      const unsetResult = await runMcp("/mcp unset existing", { owner: false });
      expect(unsetResult).toEqual({
        shouldContinue: false,
        reply: { text: expect.stringContaining("commands.ownerAllowFrom") },
      });
      expect(mcpServers.has("existing")).toBe(true);
    });
  });

  it("blocks authorized non-owner senders from reading MCP config", async () => {
    await withTempHome("openclaw-command-mcp-home-", async () => {
      mcpServers.set("context7", { command: "uvx", args: ["context7-mcp"] });
      const showResult = await runMcp("/mcp show context7", { owner: false });
      expect(showResult).toEqual({
        shouldContinue: false,
        reply: { text: expect.stringContaining("commands.ownerAllowFrom") },
      });
      const replyText = showResult.reply?.text ?? "";
      expect(replyText).not.toContain('MCP server "context7"');
      expect(replyText).not.toContain('"command": "uvx"');
    });
  });

  it("rejects internal writes without operator.admin", async () => {
    await withTempHome("openclaw-command-mcp-home-", async () => {
      const result = await runMcp('/mcp set context7={"command":"uvx","args":["context7-mcp"]}', {
        ctx: {
          Provider: "webchat",
          Surface: "webchat",
          GatewayClientScopes: ["operator.write"],
        },
      });
      expect(result.reply?.text).toContain("requires operator.admin");
    });
  });

  it("routes group /mcp show privately and redacts the delivered config", async () => {
    await withTempHome("openclaw-command-mcp-home-", async () => {
      const privateReplies: string[] = [];
      privateRouteMocks.resolvePrivateCommandRouteTargets.mockResolvedValue([
        { channel: "telegram", to: "owner-1" },
      ]);
      deliverOutboundPayloads.mockImplementation(async ({ payloads }) => {
        privateReplies.push(payloads[0]?.text ?? "");
        return [{ channel: "telegram", messageId: "private-config" }];
      });
      const headerSecret = "Bearer sk-test-secret-value";
      const envSecret = "stdio-process-token-value";
      const separateArgSecret = "plain-separate-arg-secret";
      const inlineArgSecret = "plain-inline-arg-secret";
      const positionalArgSecret = "ghp_realgithubtoken1234567890ABCD";
      const secretKeyArg = "opaque-secret-key-value";
      const awsSecretAccessKeyArg = "opaque-aws-secret-access-key-value";
      const underscoreApiKeyArg = "opaque-underscore-api-key-value";
      const pluralCredentialsArg = "opaque-plural-credentials-value";
      const secretValues = [
        headerSecret,
        envSecret,
        separateArgSecret,
        inlineArgSecret,
        positionalArgSecret,
        secretKeyArg,
        awsSecretAccessKeyArg,
        underscoreApiKeyArg,
        pluralCredentialsArg,
      ];
      mcpServers.set("billing-server", {
        command: "uvx",
        args: [
          "billing-mcp",
          "--api-key",
          separateArgSecret,
          `--token=${inlineArgSecret}`,
          positionalArgSecret,
          "--secret-key",
          secretKeyArg,
          `--aws-secret-access-key=${awsSecretAccessKeyArg}`,
          "--openai_api_key",
          underscoreApiKeyArg,
          "--credentials",
          pluralCredentialsArg,
          "--region",
          "us-east-1",
        ],
        transport: "streamable-http",
        url: "https://billing.example.com/mcp",
        headers: {
          Authorization: headerSecret,
        },
        env: {
          BILLING_TOKEN: envSecret,
        },
      });
      mcpServers.set("local-tools", {
        command: "uvx",
        args: ["local-mcp"],
        env: {
          TOOL_API_KEY: "local-env-secret-value",
        },
      });

      const namedResult = await runMcp("/mcp show billing-server", { group: true });
      const namedGroupText = namedResult.reply?.text ?? "";
      expect(namedGroupText).toContain("sent the details to the owner privately");
      expect(namedGroupText).not.toContain("billing-server");
      expect(namedGroupText).not.toContain("/tmp/openclaw.json");
      expect(namedGroupText).not.toContain(headerSecret);
      expect(privateReplies).toHaveLength(1);
      const namedText = privateReplies[0] ?? "";
      expect(namedText).toContain('MCP server "billing-server"');
      expect(namedText).toContain('"command": "uvx"');
      expect(namedText).toContain('"billing-mcp"');
      expect(namedText).toContain('"--api-key"');
      expect(namedText).toContain(`"--token=${REDACTED_SENTINEL}"`);
      expect(namedText).toContain('"--secret-key"');
      expect(namedText).toContain(`"--aws-secret-access-key=${REDACTED_SENTINEL}"`);
      expect(namedText).toContain('"--openai_api_key"');
      expect(namedText).toContain('"--region"');
      expect(namedText).toContain('"us-east-1"');
      expect(namedText).toContain(REDACTED_SENTINEL);
      expectText(namedText, [], [...secretValues, "sk-test-secret-value"]);

      const allResult = await runMcp("/mcp show", { group: true });
      const allGroupText = allResult.reply?.text ?? "";
      expect(allGroupText).toContain("sent the details to the owner privately");
      expect(allGroupText).not.toContain("billing-server");
      expect(allGroupText).not.toContain("/tmp/openclaw.json");
      expect(privateReplies).toHaveLength(2);
      const allText = privateReplies[1] ?? "";
      expect(allText).toContain('"billing-server"');
      expect(allText).toContain('"local-tools"');
      expect(allText).toContain(REDACTED_SENTINEL);
      expectText(allText, [], [...secretValues, "local-env-secret-value"]);
    });
  });

  it.each([
    {
      name: "no private owner target",
      resolvePrivateMcpTargets: async () => [],
    },
    {
      name: "private delivery failure",
      resolvePrivateMcpTargets: async () => [{ channel: "telegram", to: "owner-1" }],
    },
  ])("fails closed for group /mcp show with $name", async (route) => {
    await withTempHome("openclaw-command-mcp-home-", async () => {
      const secret = "group-route-secret-value";
      mcpServers.set("billing-server", {
        command: "uvx",
        args: ["billing-mcp", "--api-key", secret],
      });
      privateRouteMocks.resolvePrivateCommandRouteTargets.mockImplementation(
        route.resolvePrivateMcpTargets,
      );
      deliverOutboundPayloads.mockRejectedValue(new Error("private route unavailable"));
      const result = await runMcp("/mcp show billing-server", { group: true });
      const groupText = result.reply?.text ?? "";
      expect(groupText).toContain("Run /mcp show from an owner DM");
      expect(groupText).not.toContain("billing-server");
      expect(groupText).not.toContain("/tmp/openclaw.json");
      expect(groupText).not.toContain(secret);
    });
  });

  it("tries later private routes after a released failure", async () => {
    const error = new OutboundDeliveryError("private route unavailable", { cause: undefined });
    error.queueCustody = "released";
    deliverOutboundPayloads
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce([{ channel: "signal", messageId: "fallback-send" }]);
    const result = await showGroupMcpConfig();

    expectPrivateReply(result, ["owner-1", "owner-2"], "sent the details to the owner privately", [
      "billing-server",
      "private-billing-mcp",
    ]);
  });

  it("keeps identityless first acceptance pending without sending to another private target", async () => {
    deliverOutboundPayloads
      .mockImplementationOnce(async ({ onPayloadDeliveryOutcome }) => {
        onPayloadDeliveryOutcome?.({
          index: 0,
          status: "suppressed",
          reason: "adapter_returned_no_identity",
        });
        return [];
      })
      .mockResolvedValueOnce([{ channel: "signal", messageId: "second-send" }]);
    const result = await showGroupMcpConfig();

    expectPrivateReply(result, ["owner-1"], "pending", [
      "sent the details",
      "billing-server",
      "/tmp/openclaw.json",
    ]);
  });

  it("tries another private route when channel preparation throws before dispatch", async () => {
    const transformReplyPayload = vi.fn(() => {
      throw new Error("channel preparation failed");
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "telegram", label: "Telegram" }),
            messaging: { transformReplyPayload },
          },
        },
        {
          pluginId: "signal",
          source: "test",
          plugin: createChannelTestPluginBase({ id: "signal", label: "Signal" }),
        },
      ]),
    );
    deliverOutboundPayloads.mockResolvedValueOnce([
      { channel: "signal", messageId: "fallback-send" },
    ]);

    const result = await showGroupMcpConfig();

    expect(transformReplyPayload).toHaveBeenCalledTimes(1);
    expectPrivateReply(result, ["owner-2"], "sent the details to the owner privately");
  });

  it.each([
    { name: "held partial delivery", custody: "held", ambiguous: false, visible: true },
    { name: "released ambiguity", custody: "released", ambiguous: true, visible: false },
  ] as const)(
    "keeps $name pending without sending to another private target",
    async ({ custody, ambiguous, visible }) => {
      const error = new OutboundDeliveryError("private delivery interrupted", {
        cause: undefined,
        results: visible ? [{ channel: "telegram", messageId: "first-chunk" }] : [],
        payloadOutcomes: [
          {
            index: 0,
            status: "failed",
            error: new Error("interrupted"),
            sentBeforeError: ambiguous,
            stage: "platform_send",
          },
        ],
      });
      error.queueCustody = custody;
      deliverOutboundPayloads.mockRejectedValueOnce(error);
      const result = await showGroupMcpConfig();

      expectPrivateReply(result, ["owner-1"], "pending", ["sent the details", "billing-server"]);
    },
  );

  it("stops after intentional suppression with an honest acknowledgement", async () => {
    deliverOutboundPayloads.mockImplementationOnce(async ({ onPayloadDeliveryOutcome }) => {
      onPayloadDeliveryOutcome?.({
        index: 0,
        status: "suppressed",
        reason: "cancelled_by_reply_payload_sending_hook",
      });
      return [];
    });
    const result = await showGroupMcpConfig();

    expectPrivateReply(
      result,
      ["owner-1"],
      "Private delivery was suppressed; no details were sent",
    );
  });
});
