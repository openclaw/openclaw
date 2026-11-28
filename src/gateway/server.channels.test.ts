import { afterAll, beforeAll, expect, test, vi } from "vitest";
import type { ChannelAccountSnapshot, ChannelPlugin } from "../channels/plugins/types.public.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import { setRegistry } from "./server.agent.gateway-server-agent.mocks.js";
import { createRegistry } from "./server.e2e-registry-helpers.js";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const createStubChannelPlugin = (params: {
  id: ChannelPlugin["id"];
  label: string;
  inspection?: Record<string, unknown>;
}): ChannelPlugin => ({
  ...createChannelTestPluginBase({
    id: params.id,
    label: params.label,
    config: {
      inspectAccount: (_cfg, accountId) => ({
        accountId,
        enabled: true,
        configured: false,
        ...params.inspection,
      }),
      isConfigured: async () => false,
    },
  }),
  status: {
    defaultRuntime: { accountId: "default", lastProbeAt: null },
  },
  gateway: { logoutAccount: async () => ({ cleared: false, envToken: false }) },
});

const defaultRegistry = createRegistry(
  [
    { id: "whatsapp", label: "WhatsApp" },
    { id: "telegram", label: "Telegram", inspection: { tokenSource: "none" } },
    { id: "signal", label: "Signal" },
  ].map((params) => ({
    pluginId: params.id,
    source: "test",
    plugin: createStubChannelPlugin(params),
  })),
);

let server: Awaited<ReturnType<typeof startServerWithClient>>["server"];
let ws: Awaited<ReturnType<typeof startServerWithClient>>["ws"];

beforeAll(async () => {
  setRegistry(defaultRegistry);
  const started = await startServerWithClient();
  server = started.server;
  ws = started.ws;
  await connectOk(ws);
});

afterAll(async () => {
  ws.close();
  await server.close();
});

test("channels.status returns snapshot without probe", async () => {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", undefined);
  setRegistry(defaultRegistry);
  const res = await rpcReq<{
    channels?: Record<string, ChannelAccountSnapshot>;
  }>(ws, "channels.status", { probe: false, timeoutMs: 2000 });
  expect(res.ok).toBe(true);
  expect(res.payload?.channels?.whatsapp?.configured).toBe(false);
  expect(res.payload?.channels?.telegram?.tokenSource).toBe("none");
  for (const channel of ["telegram", "signal"]) {
    const snapshot = res.payload?.channels?.[channel];
    expect([snapshot?.configured, snapshot?.probe, snapshot?.lastProbeAt]).toEqual([
      false,
      undefined,
      null,
    ]);
  }
});

test("channels.logout reports no session when missing", async () => {
  setRegistry(defaultRegistry);
  const res = await rpcReq<{ cleared?: boolean; channel?: string }>(ws, "channels.logout", {
    channel: "whatsapp",
  });
  expect(res).toMatchObject({ ok: true, payload: { channel: "whatsapp", cleared: false } });
});
