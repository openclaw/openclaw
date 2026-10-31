import fs from "node:fs/promises";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import type { WAMessage, WASocket } from "baileys";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { whatsappPlugin } from "../extensions/whatsapp/api.js";
import {
  cacheInboundMessageMeta,
  createAttachedTestListener,
  setWhatsAppRuntime,
  type ActiveWebListener,
} from "../extensions/whatsapp/test-api.js";
import { messageGatewayContext } from "../src/agents/tools/message-tool-execution.test-support.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../src/config/config.js";
import type { OpenClawConfig } from "../src/config/types.js";
import { sendHandlers } from "../src/gateway/server-methods/send.js";
import { getPluginInstance } from "../src/plugins/plugin-instance-scope.js";
import { createPluginRegistry } from "../src/plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../src/plugins/runtime.js";
import type { PluginRuntime } from "../src/plugins/runtime/types.js";
import { createPluginRecord } from "../src/plugins/status.test-fixtures.js";
import { createMessageReadAuthority } from "./message-read-authority.test-support.js";

const chat = "+15555550123";
const chatJid = "15555550123@s.whatsapp.net";
const group = "1203630000000000@g.us";
const sessionKey = "agent:main:whatsapp:channel:origin";
const edit = { messageId: "sent-own", message: "updated" };

function registerExternalWhatsApp(runtime: PluginRuntime) {
  const owner = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id: "whatsapp",
    origin: "global",
    trustedOfficialInstall: false,
  });
  owner.registry.plugins.push(record);
  owner.createApi(record, { config: {}, registrationMode: "full" }).registerChannel({
    // Status probes have provider-specific generics, unrelated to message dispatch.
    plugin: { ...whatsappPlugin, status: undefined },
  });
  setActivePluginRegistry(owner.registry);
  // An external install reads its runtime from its own instance slot, not the process-wide one.
  getPluginInstance(record)!.runInRegistry(owner.registry, () => setWhatsAppRuntime(runtime));
}

describe("external WhatsApp edit under the host-issued caller guard", () => {
  const rawSend = vi.fn<WASocket["sendMessage"]>();
  const fetchReachoutTimelock = vi.fn(async () => ({ isActive: false }));
  const cfg: OpenClawConfig = {
    channels: {
      whatsapp: {
        allowFrom: [chat],
        groups: { [group]: {} },
        accounts: { default: {}, work: { allowFrom: [chat] } },
      },
    },
  };
  const runs: ReturnType<typeof createMessageReadAuthority>[] = [];
  let authDir: string;
  let listener: ActiveWebListener;

  function startRun() {
    const gateway = messageGatewayContext(() => cfg, sendHandlers["message.action"]!, {
      dedupe: new Map(),
    });
    const run = createMessageReadAuthority({
      runId: "whatsapp-edit",
      sessionKey,
      requesterSenderId: chat,
      toolContext: {
        currentChannelProvider: "whatsapp",
        currentChannelId: chat,
        currentChatType: "direct",
      },
      gatewayContext: "resolved",
      gatewayContextResolver: () => gateway,
    });
    runs.push(run);
    return { run, gateway };
  }

  function editThroughTool(run: ReturnType<typeof createMessageReadAuthority>, params = {}) {
    return run.createTool(cfg).execute("edit", {
      action: "edit",
      channel: "whatsapp",
      target: chat,
      ...edit,
      ...params,
    });
  }

  beforeAll(async () => {
    authDir = await fs.mkdtemp(join(resolvePreferredOpenClawTmpDir(), "openclaw-wa-edit-"));
  });

  afterAll(async () => {
    await fs.rm(authDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    registerExternalWhatsApp({
      channel: {
        runtimeContexts: {
          get: ({ accountId }: { accountId: string }) =>
            accountId === "default" ? { getActiveListener: () => listener } : undefined,
        },
      },
    } as unknown as PluginRuntime);
    setRuntimeConfigSnapshot(cfg, cfg);
    rawSend.mockReset();
    rawSend.mockResolvedValue({ key: { id: "edit-receipt" } } as WAMessage);
    fetchReachoutTimelock.mockClear();
    listener = await createAttachedTestListener({
      accountId: "default",
      authDir,
      sendMessage: rawSend,
      fetchAccountReachoutTimelock: fetchReachoutTimelock,
    });
    cacheInboundMessageMeta("default", chatJid, "sent-own", { fromMe: true });
  });

  afterEach(() => {
    for (const run of runs.splice(0)) {
      run.dispose();
    }
    resetPluginRuntimeStateForTest();
    clearRuntimeConfigSnapshot();
  });

  it("submits the current chat's edit to the socket", async () => {
    const result = await editThroughTool(startRun().run);
    expect(result.details).toMatchObject({ submitted: true, confirmed: false });
    expect(rawSend.mock.calls.map(([jid, content]) => [jid, content])).toEqual([
      [chatJid, { text: "updated", edit: { remoteJid: chatJid, id: "sent-own", fromMe: true } }],
    ]);
  });

  it("rejects an edit naming another allowed chat before the socket", async () => {
    await expect(editThroughTool(startRun().run, { target: group })).rejects.toThrow(
      "exact current conversation and account",
    );
    expect(rawSend).not.toHaveBeenCalled();
  });

  it("has the gateway reject an edit naming another allowed account before the socket", async () => {
    const { run, gateway } = startRun();
    const respond = vi.fn<(ok: boolean, payload?: unknown, error?: { message?: string }) => void>();
    await sendHandlers["message.action"]!({
      params: {
        channel: "whatsapp",
        action: "edit",
        params: { to: chat, ...edit, accountId: "work" },
        accountId: "work",
        agentId: "main",
        sessionKey,
        idempotencyKey: "edit-work",
      },
      respond,
      context: gateway,
      client: run.client,
      req: { type: "req", id: "edit-work", method: "message.action" },
      isWebchatConnect: () => false,
    });
    expect(respond).toHaveBeenCalledOnce();
    expect(respond.mock.calls[0]?.slice(0, 2)).toEqual([false, undefined]);
    expect(respond.mock.calls[0]?.[2]?.message).toBe(
      "Error: Delegated whatsapp:edit requires the exact current conversation and account for this plugin.",
    );
    expect(rawSend).not.toHaveBeenCalled();
  });

  it("drops a queued edit whose turn the host revoked before its socket turn", async () => {
    const occupying = Promise.withResolvers<WAMessage | undefined>();
    const occupied = Promise.withResolvers<void>();
    rawSend.mockImplementationOnce(() => {
      occupied.resolve();
      return occupying.promise;
    });
    const busy = listener.sendMessage(chat, "busy");
    await occupied.promise;

    // The edit's send-readiness preflight is its last step before it waits behind the busy send.
    const preflighted = Promise.withResolvers<void>();
    fetchReachoutTimelock.mockImplementationOnce(async () => {
      preflighted.resolve();
      return { isActive: false };
    });
    const { run } = startRun();
    const settled = editThroughTool(run).catch((error: unknown) => error);
    await preflighted.promise;
    await setImmediate();

    run.revokeTurn();
    occupying.resolve({ key: { id: "busy" } } as WAMessage);
    await busy;

    expect(await settled).toMatchObject({ message: "agent runtime authority is no longer active" });
    expect(rawSend).toHaveBeenCalledOnce();
  });
});
