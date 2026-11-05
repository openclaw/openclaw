import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
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
function configuredServers() {
  return {
    ok: true,
    path: "/tmp/openclaw.json",
    config: {},
    mcpServers: Object.fromEntries(mcpServers),
  };
}
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

// mock-isolation: Keep MCP configuration in the test's in-memory server map.
vi.mock("../../config/mcp-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/mcp-config.js")>()),
  listConfiguredMcpServers: vi.fn(async () => configuredServers()),
}));

// mock-isolation: Exercise command mutations without writing host MCP configuration.
vi.mock("../../agents/mcp-config-mutation.js", () => ({
  setConfiguredMcpServer: vi.fn(async ({ name, server }) => {
    mcpServers.set(name, { ...(server as Record<string, unknown>) });
    return configuredServers();
  }),
  unsetConfiguredMcpServer: vi.fn(async ({ name }) => {
    const removed = mcpServers.delete(name);
    return { ...configuredServers(), removed };
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

async function runMcp(
  command: string,
  options: {
    owner?: boolean;
    group?: boolean;
    ctx?: Partial<HandleCommandsParams["ctx"]>;
  } = {},
) {
  const params = buildCommandTestParams(
    command,
    { commands: { text: true, mcp: true } },
    options.ctx,
  );
  params.command.senderIsOwner = options.owner ?? true;
  params.isGroup = options.group ?? false;
  return expectDefined(await handleMcpCommand(params, true), "MCP command result");
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

function suppressNextDelivery(
  reason: "adapter_returned_no_identity" | "cancelled_by_reply_payload_sending_hook",
) {
  deliverOutboundPayloads.mockImplementationOnce(async ({ onPayloadDeliveryOutcome }) => {
    onPayloadDeliveryOutcome?.({ index: 0, status: "suppressed", reason });
    return [];
  });
}

async function showGroupMcpConfig() {
  privateRouteMocks.resolvePrivateCommandRouteTargets.mockResolvedValue([
    { channel: "telegram", to: "owner-1" },
    { channel: "signal", to: "owner-2" },
  ]);
  mcpServers.set("billing-server", { command: "uvx", args: ["private-billing-mcp"] });
  return runMcp("/mcp show", { group: true });
}

afterEach(() => {
  mcpServers.clear();
  privateRouteMocks.resolvePrivateCommandRouteTargets.mockReset();
  deliverOutboundPayloads.mockReset();
  resetPluginRuntimeStateForTest();
});

it("writes MCP config and shows it back", async () => {
  const setResult = await runMcp('/mcp set context7={"command":"uvx","args":["context7-mcp"]}');
  expect(setResult.reply?.text).toContain('MCP server "context7" saved');

  const showResult = await runMcp("/mcp show context7");
  expect(showResult.reply?.text).toContain('"command": "uvx"');
  expect(showResult.reply?.text).toContain('"args": [');
});

it.each([
  ['/mcp set evil={"command":"/bin/sh","args":["-c","id > /tmp/pwned"]}', "evil", false],
  ["/mcp unset existing", "existing", true],
  ["/mcp show context7", "context7", true],
] as const)("blocks authorized non-owner senders from %s", async (command, server, present) => {
  mcpServers.set("existing", { command: "uvx", args: ["existing-mcp"] });
  mcpServers.set("context7", { command: "uvx", args: ["context7-mcp"] });
  const result = await runMcp(command, { owner: false });
  expect(result).toEqual({
    shouldContinue: false,
    reply: { text: expect.stringContaining("commands.ownerAllowFrom") },
  });
  expect(mcpServers.has(server)).toBe(present);
  expectText(result.reply?.text, [], ['MCP server "context7"', '"command": "uvx"']);
});

it("rejects internal writes without operator.admin", async () => {
  const result = await runMcp('/mcp set context7={"command":"uvx","args":["context7-mcp"]}', {
    ctx: {
      Provider: "webchat",
      Surface: "webchat",
      GatewayClientScopes: ["operator.write"],
    },
  });
  expect(result.reply?.text).toContain("requires operator.admin");
});

it.each(["billing-server", ""])("privately shows redacted MCP config: %s", async (name) => {
  const secret = "private-config-secret";
  const token = "ghp_realgithubtoken1234567890ABCD";
  const privateReplies: string[] = [];
  privateRouteMocks.resolvePrivateCommandRouteTargets.mockResolvedValue([
    { channel: "telegram", to: "owner-1" },
  ]);
  deliverOutboundPayloads.mockImplementation(async ({ payloads }) => {
    privateReplies.push(payloads[0]?.text ?? "");
    return [{ channel: "telegram", messageId: "private-config" }];
  });
  mcpServers.set("billing-server", {
    command: "uvx",
    args: [
      "billing-mcp",
      "--api-key",
      secret,
      `--token=${secret}`,
      token,
      "--secret-key",
      secret,
      `--aws-secret-access-key=${secret}`,
      "--openai_api_key",
      secret,
      "--credentials",
      secret,
      "--region",
      "us-east-1",
    ],
    headers: { Authorization: `Bearer ${secret}` },
    env: { BILLING_TOKEN: secret },
  });
  mcpServers.set("local-tools", { env: { TOOL_API_KEY: secret } });
  const result = await runMcp(`/mcp show ${name}`, { group: true });
  expectPrivateReply(result, ["owner-1"], "sent the details to the owner privately", [
    "billing-server",
    "/tmp/openclaw.json",
    secret,
  ]);
  expect(privateReplies).toHaveLength(1);
  expectText(
    privateReplies[0],
    [
      '"billing-mcp"',
      REDACTED_SENTINEL,
      '"us-east-1"',
      `"--token=${REDACTED_SENTINEL}"`,
      `"--aws-secret-access-key=${REDACTED_SENTINEL}"`,
      name ? 'MCP server "billing-server"' : '"local-tools"',
    ],
    [secret, token],
  );
});

it.each(["no private owner target", "private delivery failure"])(
  "fails closed for group /mcp show with %s",
  async (route) => {
    const secret = "group-route-secret-value";
    mcpServers.set("billing-server", {
      command: "uvx",
      args: ["billing-mcp", "--api-key", secret],
    });
    privateRouteMocks.resolvePrivateCommandRouteTargets.mockResolvedValue(
      route === "no private owner target" ? [] : [{ channel: "telegram", to: "owner-1" }],
    );
    deliverOutboundPayloads.mockRejectedValue(new Error("private route unavailable"));
    const result = await runMcp("/mcp show billing-server", { group: true });
    const groupText = result.reply?.text ?? "";
    expect(groupText).toContain("Run /mcp show from an owner DM");
    expect(groupText).not.toContain("billing-server");
    expect(groupText).not.toContain("/tmp/openclaw.json");
    expect(groupText).not.toContain(secret);
  },
);

it.each([
  ["adapter_returned_no_identity", "pending"],
  [
    "cancelled_by_reply_payload_sending_hook",
    "Private delivery was suppressed; no details were sent",
  ],
] as const)("stops private delivery after %s", async (reason, acknowledgement) => {
  suppressNextDelivery(reason);
  if (reason === "adapter_returned_no_identity") {
    deliverOutboundPayloads.mockResolvedValueOnce([
      { channel: "signal", messageId: "second-send" },
    ]);
  }
  expectPrivateReply(await showGroupMcpConfig(), ["owner-1"], acknowledgement, [
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
    createTestRegistry(
      ["telegram", "signal"].map((id) => ({
        pluginId: id,
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id, label: id }),
          ...(id === "telegram" ? { messaging: { transformReplyPayload } } : {}),
        },
      })),
    ),
  );
  deliverOutboundPayloads.mockResolvedValueOnce([
    { channel: "signal", messageId: "fallback-send" },
  ]);

  const result = await showGroupMcpConfig();

  expectPrivateReply(result, ["owner-2"], "sent the details to the owner privately");
});

it.each([
  { name: "released failure", custody: "released", ambiguous: false, visible: false },
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
    const released = custody === "released" && !ambiguous;
    if (released) {
      deliverOutboundPayloads.mockResolvedValueOnce([
        { channel: "signal", messageId: "fallback-send" },
      ]);
    }
    expectPrivateReply(
      await showGroupMcpConfig(),
      released ? ["owner-1", "owner-2"] : ["owner-1"],
      released ? "sent the details to the owner privately" : "pending",
      released ? ["billing-server", "private-billing-mcp"] : ["sent the details", "billing-server"],
    );
  },
);
