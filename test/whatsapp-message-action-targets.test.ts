import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createWhatsAppQaAuthState, whatsappPlugin } from "../extensions/whatsapp/api.js";
import { getActiveWebListener } from "../extensions/whatsapp/runtime-api.js";
import { setWhatsAppRuntime } from "../extensions/whatsapp/runtime-setter-api.js";
import type { OpenClawConfig } from "../src/config/config.js";
import { setRuntimeConfigSnapshot } from "../src/config/runtime-snapshot.js";
import { runMessageAction } from "../src/infra/outbound/message-action-runner.js";
import { createStartAccountContext } from "../src/plugin-sdk/test-helpers/start-account-context.js";
import { getPluginInstance } from "../src/plugins/plugin-instance-scope.js";
import { markPluginRegistryActive } from "../src/plugins/registry-lifecycle.js";
import { createTestPluginRegistry } from "../src/plugins/registry-runtime.test-helpers.js";
import { setActivePluginRegistry } from "../src/plugins/runtime.js";
import { createPluginRuntime } from "../src/plugins/runtime/index.js";
import { createPluginRecord } from "../src/plugins/status.test-fixtures.js";
import { createTestRegistry } from "../src/test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";

const socket = vi.hoisted(() => ({
  sendMessage: vi.fn(async (_jid: string, _content: unknown, _options: unknown) => ({
    key: { id: "accepted-message" },
  })),
  sendPresenceUpdate: vi.fn(async () => {}),
}));

// Only the external transport is replaced; policy, resolution, and send API stay real.
vi.mock("baileys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("baileys")>();
  const { EventEmitter } = await import("node:events");
  return {
    ...actual,
    fetchLatestBaileysVersion: async () => ({
      version: actual.DEFAULT_CONNECTION_CONFIG.version,
      isLatest: false,
    }),
    makeWASocket: () => {
      const ev = new EventEmitter();
      const ws = Object.assign(new EventEmitter(), { isClosed: false });
      setImmediate(() => ev.emit("connection.update", { connection: "open" }));
      return {
        ...socket,
        ev,
        ws,
        authState: { creds: { accountSyncCounter: 1 } },
        signalRepository: { lidMapping: { getPNForLID: async () => null } },
        user: { id: "15550000000@s.whatsapp.net" },
        fetchAccountReachoutTimelock: async () => ({ isActive: false }),
        groupFetchAllParticipating: async () => ({}),
        end: async () => {
          ws.isClosed = true;
          ws.emit("close");
        },
      };
    },
  };
});

const phone = "+15555550000";
const phoneJid = "15555550000@s.whatsapp.net";
const unrelatedLid = "15555550000@lid";
const mappedLid = "987654@lid";

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  setActivePluginRegistry(createTestRegistry([]));
});

it("delivers same-chat phone JIDs through LID mapping and rejects a same-digit LID before I/O", async () => {
  await withOpenClawTestState({ prefix: "whatsapp-target-authority-" }, async (state) => {
    const abort = new AbortController();
    let monitor: Promise<unknown> | undefined;
    try {
      const authDir = await createWhatsAppQaAuthState({
        parentDir: state.root,
        selfJid: "15550000000@s.whatsapp.net",
        name: "Target authority fixture",
      });
      await fs.writeFile(path.join(authDir, "lid-mapping-15555550000.json"), '"987654"');
      const cfg: OpenClawConfig = {
        channels: { whatsapp: { enabled: true, authDir, allowFrom: ["*"] } },
        tools: { message: { crossContext: { allowWithinProvider: false } } },
        agents: { entries: { main: { workspace: state.workspaceDir } } },
        session: { dmScope: "per-channel-peer" },
      };
      setRuntimeConfigSnapshot(cfg);
      const builder = createTestPluginRegistry(createPluginRuntime());
      const record = createPluginRecord({ id: "whatsapp", origin: "bundled" });
      const api = builder.createApi(record, { config: cfg, registrationMode: "full" });
      api.registerChannel({ plugin: whatsappPlugin });
      builder.registry.plugins.push(record);
      markPluginRegistryActive(builder.registry);
      setActivePluginRegistry(builder.registry);
      const instance = getPluginInstance(record);
      assert(instance);
      instance.run(() => setWhatsAppRuntime(api.runtime));
      const channelRuntime = builder.registry.channels[0]?.resolveChannelRuntime?.();
      assert(channelRuntime);
      const ready = Promise.withResolvers<void>();
      const start = builder.registry.channels[0]?.plugin.gateway?.startAccount;
      assert(start);
      monitor = Promise.resolve(
        start({
          ...createStartAccountContext({
            cfg,
            account: whatsappPlugin.config.resolveAccount(cfg, "default"),
            abortSignal: abort.signal,
            statusPatchSink: (snapshot) => {
              if (snapshot.connected) {
                ready.resolve();
              }
            },
          }),
          channelRuntime,
        }),
      );
      await Promise.race([
        ready.promise,
        monitor.then(() => {
          throw new Error("WhatsApp fixture stopped before ready");
        }),
      ]);
      const listener = instance.run(() => getActiveWebListener("default"));
      assert(listener);
      const send = vi.spyOn(listener, "sendMessage");
      const composing = vi.spyOn(listener, "sendComposingTo");
      const dispatch = (target: string) =>
        runMessageAction({
          cfg,
          action: "send",
          params: { channel: "whatsapp", to: target, message: "Target authority proof" },
          agentId: "main",
          workspaceDir: state.workspaceDir,
          toolContext: { currentChannelProvider: "whatsapp", currentChannelId: phone },
          callerRecordsDestinationHistory: true,
          gatewayOwnedDelivery: true,
        });
      await dispatch(phoneJid);
      expect(socket.sendMessage.mock.calls.map(([jid]) => jid)).toEqual([mappedLid]);
      expect(send).toHaveBeenCalledOnce();
      const presenceCalls = composing.mock.calls.length;
      await expect(dispatch(unrelatedLid)).rejects.toThrow("Cross-context messaging denied");
      expect(send).toHaveBeenCalledOnce();
      expect(composing).toHaveBeenCalledTimes(presenceCalls);
      expect(socket.sendMessage.mock.calls.map(([jid]) => jid)).toEqual([mappedLid]);
    } finally {
      abort.abort();
      await monitor;
    }
  });
});
