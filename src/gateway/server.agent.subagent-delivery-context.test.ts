import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { getSessionEntry } from "../config/sessions.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import { setRegistry } from "./server.agent.gateway-server-agent.mocks.js";
import { createRegistry } from "./server.e2e-registry-helpers.js";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
  testState,
  seedGatewaySessionEntries,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let server: Awaited<ReturnType<typeof startServerWithClient>>["server"];
let ws: Awaited<ReturnType<typeof startServerWithClient>>["ws"];
let sessionStateDir: string;

const createStubChannelPlugin = (params: {
  id: ChannelPlugin["id"];
  label: string;
}): ChannelPlugin => ({
  ...createChannelTestPluginBase({
    id: params.id,
    label: params.label,
  }),
  outbound: {
    deliveryMode: "direct",
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim() ?? "";
      if (trimmed) {
        return { ok: true, to: trimmed };
      }
      return { ok: false, error: new Error(`missing target for ${params.id}`) };
    },
    sendText: async () => ({ channel: params.id, messageId: "msg-test" }),
    sendMedia: async () => ({ channel: params.id, messageId: "msg-test" }),
  },
});

const defaultRegistry = createRegistry([
  {
    pluginId: "slack",
    source: "test",
    plugin: createStubChannelPlugin({ id: "slack", label: "Slack" }),
  },
]);

beforeAll(async () => {
  const started = await startServerWithClient();
  server = started.server;
  ws = started.ws;
  await connectOk(ws);
  sessionStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-subagent-delivery-ctx-"));
});

afterAll(async () => {
  ws.close();
  await server.close();
  await fs.rm(sessionStateDir, { recursive: true, force: true });
});

describe("subagent session deliveryContext from spawn request params", () => {
  test("new subagent session inherits deliveryContext from request channel/to/threadId", async () => {
    setRegistry(defaultRegistry);
    await seedGatewaySessionEntries({ entries: {} });

    const res = await rpcReq(ws, "agent", {
      message: "[Subagent Task]: analyze data",
      sessionKey: "agent:main:subagent:test-delivery-ctx",
      channel: "slack",
      to: "channel:C0AF8TW48UQ",
      accountId: "default",
      threadId: "1774374945.091819",
      deliver: false,
      idempotencyKey: "idem-subagent-delivery-ctx-1",
    });
    expect(res.ok).toBe(true);

    const entry = getSessionEntry({
      agentId: "main",
      sessionKey: "agent:main:subagent:test-delivery-ctx",
    });
    expect(entry).toBeDefined();
    expect(entry?.deliveryContext?.channel).toBe("slack");
    expect(entry?.deliveryContext?.to).toBe("channel:C0AF8TW48UQ");
    expect(entry?.deliveryContext?.threadId).toBe("1774374945.091819");
    expect(entry?.deliveryContext?.accountId).toBe("default");
    expect(entry?.lastChannel).toBe("slack");
    expect(entry?.lastTo).toBe("channel:C0AF8TW48UQ");
  });

  test("existing session deliveryContext is NOT overwritten by request params", async () => {
    setRegistry(defaultRegistry);
    await seedGatewaySessionEntries({
      entries: {
        "agent:main:subagent:existing-ctx": {
          sessionId: "sess-existing",
          updatedAt: Date.now(),
          deliveryContext: {
            channel: "slack",
            to: "user:U09U1LV7JDN",
            accountId: "default",
            threadId: "1771242986.529939",
          },
          lastChannel: "slack",
          lastTo: "user:U09U1LV7JDN",
          lastAccountId: "default",
          lastThreadId: "1771242986.529939",
        },
      },
    });

    const res = await rpcReq(ws, "agent", {
      message: "follow-up",
      sessionKey: "agent:main:subagent:existing-ctx",
      channel: "slack",
      to: "channel:C0AF8TW48UQ",
      threadId: "9999999999.000000",
      deliver: false,
      idempotencyKey: "idem-subagent-delivery-ctx-2",
    });
    expect(res.ok).toBe(true);

    const entry = getSessionEntry({
      agentId: "main",
      sessionKey: "agent:main:subagent:existing-ctx",
    });
    expect(entry).toBeDefined();
    // The ORIGINAL deliveryContext should be preserved (primary wins in merge).
    expect(entry?.deliveryContext?.to).toBe("user:U09U1LV7JDN");
    expect(entry?.deliveryContext?.threadId).toBe("1771242986.529939");
    expect(entry?.lastTo).toBe("user:U09U1LV7JDN");
  });

  test("pre-patched subagent session (via sessions.patch) inherits deliveryContext from agent request", async () => {
    // Simulates the real subagent spawn flow: spawnSubagentDirect calls sessions.patch
    // first (to set spawnDepth, spawnedBy, etc.), then calls callSubagentGateway({method: "agent"}).
    // The sessions.patch creates a partial entry without deliveryContext.
    // The agent handler must seed deliveryContext from the request params.
    setRegistry(defaultRegistry);
    await seedGatewaySessionEntries({
      entries: {
        "agent:main:subagent:pre-patched": {
          sessionId: "sess-pre-patched",
          updatedAt: Date.now(),
          spawnDepth: 1,
          spawnedBy: "agent:main:slack:direct:u07fdr83w6n:thread:1775577152.364109",
        },
      },
    });

    const res = await rpcReq(ws, "agent", {
      message: "[Subagent Task]: investigate data",
      sessionKey: "agent:main:subagent:pre-patched",
      channel: "slack",
      to: "user:U07FDR83W6N",
      accountId: "default",
      threadId: "1775577152.364109",
      deliver: false,
      idempotencyKey: "idem-subagent-delivery-ctx-prepatched",
    });
    expect(res.ok).toBe(true);

    const entry = getSessionEntry({
      agentId: "main",
      sessionKey: "agent:main:subagent:pre-patched",
    });
    expect(entry).toBeDefined();
    expect(entry?.deliveryContext?.channel).toBe("slack");
    expect(entry?.deliveryContext?.to).toBe("user:U07FDR83W6N");
    expect(entry?.deliveryContext?.threadId).toBe("1775577152.364109");
    expect(entry?.deliveryContext?.accountId).toBe("default");
    expect(entry?.lastThreadId).toBe("1775577152.364109");
  });

  test("request without to/threadId does not inject empty values", async () => {
    setRegistry(defaultRegistry);
    await seedGatewaySessionEntries({ entries: {} });

    const res = await rpcReq(ws, "agent", {
      message: "internal task",
      sessionKey: "agent:main:subagent:no-routing",
      channel: "slack",
      deliver: false,
      idempotencyKey: "idem-subagent-delivery-ctx-3",
    });
    expect(res.ok).toBe(true);

    const entry = getSessionEntry({
      agentId: "main",
      sessionKey: "agent:main:subagent:no-routing",
    });
    expect(entry).toBeDefined();
    expect(entry?.deliveryContext?.channel).toBe("slack");
    expect(entry?.deliveryContext?.to).toBeUndefined();
    expect(entry?.deliveryContext?.threadId).toBeUndefined();
  });
});
