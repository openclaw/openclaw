import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { sendMessageTelegram, sendPollTelegram } from "../../extensions/telegram/src/send.js";
import {
  clearConfigCache,
  loadConfig,
  writeConfigFile,
  type OpenClawConfig,
} from "../config/config.js";
import { loadCronStore, saveCronStore } from "../cron/store.js";
import type { CronStoreFile } from "../cron/types.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import {
  getActivePluginRegistry,
  releasePinnedPluginChannelRegistry,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { connectOk, installGatewayTestHooks, rpcReq } from "./test-helpers.js";
import { withServer } from "./test-with-server.js";

installGatewayTestHooks({ scope: "suite" });

function createCronStore(): CronStoreFile {
  const now = Date.now();
  return {
    version: 1,
    jobs: [
      {
        id: "telegram-writeback-job",
        name: "Telegram writeback job",
        enabled: true,
        createdAtMs: now,
        updatedAtMs: now,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "tick" },
        state: {},
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "@mychannel",
        },
      },
    ],
  };
}

async function withTelegramGatewayWritebackFixture(
  run: (params: {
    cronStorePath: string;
    getChat: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
    sendPoll: ReturnType<typeof vi.fn>;
    installTelegramTestPlugin: () => void;
  }) => Promise<void>,
): Promise<void> {
  const previousRegistry = getActivePluginRegistry() ?? createEmptyPluginRegistry();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-writeback-"));
  const cronStorePath = path.join(tempDir, "cron", "jobs.json");
  const getChat = vi.fn(async () => ({ id: -100321 }));
  const sendMessage = vi.fn(async () => ({
    message_id: 17,
    chat: { id: "-100321" },
  }));
  const sendPoll = vi.fn(async () => ({
    message_id: 19,
    chat: { id: "-100321" },
    poll: { id: "poll-1" },
  }));

  const installTelegramTestPlugin = () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "telegram",
            label: "Telegram",
            outbound: {
              sendText: async ({ cfg, to, text, accountId, gatewayClientScopes }) =>
                await sendMessageTelegram(to, text, {
                  cfg,
                  accountId: accountId ?? undefined,
                  gatewayClientScopes,
                  token: "123:abc",
                  api: {
                    getChat,
                    sendMessage,
                  },
                }),
              sendPoll: async ({ cfg, to, poll, accountId, gatewayClientScopes, threadId }) =>
                await sendPollTelegram(to, poll, {
                  cfg,
                  accountId: accountId ?? undefined,
                  gatewayClientScopes,
                  messageThreadId:
                    typeof threadId === "number" && Number.isFinite(threadId)
                      ? Math.trunc(threadId)
                      : undefined,
                  token: "123:abc",
                  api: {
                    getChat,
                    sendPoll,
                  },
                }),
            },
          }),
        },
      ]),
      "telegram-target-writeback-scope",
    );
  };

  installTelegramTestPlugin();

  try {
    await saveCronStore(cronStorePath, createCronStore());
    clearConfigCache();
    await writeConfigFile({
      agents: {
        defaults: {
          model: "gpt-5.4",
          workspace: path.join(process.env.HOME ?? ".", "openclaw"),
        },
      },
      channels: {
        telegram: {
          botToken: "123:abc",
          defaultTo: "https://t.me/mychannel",
        },
      },
      cron: {
        store: cronStorePath,
      },
    } satisfies OpenClawConfig);
    clearConfigCache();

    await run({
      cronStorePath,
      getChat,
      sendMessage,
      sendPoll,
      installTelegramTestPlugin,
    });
  } finally {
    setActivePluginRegistry(previousRegistry);
    clearConfigCache();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

describe("gateway Telegram target writeback scope enforcement", () => {
  it("allows operator.write delivery but skips config and cron persistence", async () => {
    await withTelegramGatewayWritebackFixture(async ({ cronStorePath, getChat, sendMessage }) => {
      await withServer(async (ws) => {
        await connectOk(ws, { token: "secret", scopes: ["operator.write"] });

        const current = await rpcReq<{
          hash?: string;
        }>(ws, "config.get", {});
        expect(current.ok).toBe(true);
        expect(typeof current.payload?.hash).toBe("string");

        const directPatch = await rpcReq(ws, "config.patch", {
          raw: JSON.stringify({
            channels: {
              telegram: {
                defaultTo: "-100321",
              },
            },
          }),
          baseHash: current.payload?.hash,
        });
        expect(directPatch.ok).toBe(false);
        expect(directPatch.error?.message).toBe("missing scope: operator.admin");

        const viaSend = await rpcReq(ws, "send", {
          to: "https://t.me/mychannel",
          message: "hello from send scope test",
          channel: "telegram",
          sessionKey: "main",
          idempotencyKey: "idem-send-telegram-target-writeback-operator-write",
        });
        expect(viaSend.ok).toBe(true);

        clearConfigCache();
        const stored = loadConfig();
        const cronStore = await loadCronStore(cronStorePath);

        expect(stored.channels?.telegram?.defaultTo).toBe("https://t.me/mychannel");
        expect(cronStore.jobs[0]?.delivery?.to).toBe("@mychannel");
        expect(getChat).toHaveBeenCalledWith("@mychannel");
        expect(sendMessage).toHaveBeenCalledWith("-100321", "hello from send scope test", {
          parse_mode: "HTML",
        });
      });
    });
  });

  it("persists config and cron rewrites for operator.admin delivery", async () => {
    await withTelegramGatewayWritebackFixture(async ({ cronStorePath, getChat, sendMessage }) => {
      await withServer(async (ws) => {
        await connectOk(ws, { token: "secret", scopes: ["operator.write", "operator.admin"] });

        const viaSend = await rpcReq(ws, "send", {
          to: "https://t.me/mychannel",
          message: "hello from admin scope test",
          channel: "telegram",
          sessionKey: "main",
          idempotencyKey: "idem-send-telegram-target-writeback-operator-admin",
        });
        expect(viaSend.ok).toBe(true);

        clearConfigCache();
        const stored = loadConfig();
        const cronStore = await loadCronStore(cronStorePath);

        expect(stored.channels?.telegram?.defaultTo).toBe("-100321");
        expect(cronStore.jobs[0]?.delivery?.to).toBe("-100321");
        expect(getChat).toHaveBeenCalledWith("@mychannel");
        expect(sendMessage).toHaveBeenCalledWith("-100321", "hello from admin scope test", {
          parse_mode: "HTML",
        });
      });
    });
  });

  it("allows operator.write poll delivery but skips config and cron persistence", async () => {
    await withTelegramGatewayWritebackFixture(
      async ({ cronStorePath, getChat, sendPoll, installTelegramTestPlugin }) => {
        await withServer(async (ws) => {
          releasePinnedPluginChannelRegistry();
          installTelegramTestPlugin();
          await connectOk(ws, { token: "secret", scopes: ["operator.write"] });

          const viaPoll = await rpcReq(ws, "poll", {
            to: "https://t.me/mychannel",
            question: "Which one?",
            options: ["A", "B"],
            channel: "telegram",
            idempotencyKey: "idem-poll-telegram-target-writeback-operator-write",
          });
          if (!viaPoll.ok) {
            throw new Error(`poll failed: ${viaPoll.error?.message ?? "unknown error"}`);
          }
          expect(viaPoll.ok).toBe(true);

          clearConfigCache();
          const stored = loadConfig();
          const cronStore = await loadCronStore(cronStorePath);

          expect(stored.channels?.telegram?.defaultTo).toBe("https://t.me/mychannel");
          expect(cronStore.jobs[0]?.delivery?.to).toBe("@mychannel");
          expect(getChat).toHaveBeenCalledWith("@mychannel");
          expect(sendPoll).toHaveBeenCalledWith("-100321", "Which one?", ["A", "B"], {
            allows_multiple_answers: false,
            is_anonymous: true,
          });
        });
      },
    );
  });
});
