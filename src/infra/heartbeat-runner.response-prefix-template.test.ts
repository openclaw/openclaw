import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { telegramPlugin } from "../../extensions/telegram/src/channel.js";
import { setTelegramRuntime } from "../../extensions/telegram/src/runtime.js";
import { whatsappPlugin } from "../../extensions/whatsapp/src/channel.js";
import { setWhatsAppRuntime } from "../../extensions/whatsapp/src/runtime.js";
import * as replyModule from "../auto-reply/reply.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { seedSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";

// Avoid pulling optional runtime deps during isolated runs.
vi.mock("jiti", () => ({ createJiti: () => () => ({}) }));

beforeEach(() => {
  const runtime = createPluginRuntime();
  setTelegramRuntime(runtime);
  setWhatsAppRuntime(runtime);
  setActivePluginRegistry(
    createTestRegistry([
      { pluginId: "whatsapp", plugin: whatsappPlugin, source: "test" },
      { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
    ]),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runHeartbeatOnce – responsePrefix template interpolation", () => {
  it("passes onModelSelected callback to getReplyFromConfig", async () => {
    await withTempHeartbeatSandbox(
      async ({ tmpDir, storePath }) => {
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: tmpDir,
              heartbeat: { every: "5m", target: "whatsapp" },
            },
          },
          channels: {
            whatsapp: {
              allowFrom: ["*"],
              responsePrefix: "{model}: ",
            },
          },
          session: { store: storePath },
        };
        const sessionKey = resolveMainSessionKey(cfg);
        await seedSessionStore(storePath, sessionKey, {
          lastChannel: "whatsapp",
          lastProvider: "whatsapp",
          lastTo: "+1555",
        });

        const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
        replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

        await runHeartbeatOnce({
          cfg,
          deps: { getQueueSize: () => 0, nowMs: () => 0 },
        });

        expect(replySpy).toHaveBeenCalledTimes(1);
        const replyOpts = replySpy.mock.calls[0]?.[1];
        expect(replyOpts).toHaveProperty("onModelSelected");
        expect(typeof replyOpts?.onModelSelected).toBe("function");
      },
      { prefix: "openclaw-hb-prefix-" },
    );
  });

  it("passes onModelSelected even without heartbeatModelOverride", async () => {
    await withTempHeartbeatSandbox(
      async ({ tmpDir, storePath }) => {
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: tmpDir,
              heartbeat: { every: "5m", target: "whatsapp" },
            },
          },
          channels: {
            whatsapp: {
              allowFrom: ["*"],
              responsePrefix: "{model}: ",
            },
          },
          session: { store: storePath },
        };
        const sessionKey = resolveMainSessionKey(cfg);
        await seedSessionStore(storePath, sessionKey, {
          lastChannel: "whatsapp",
          lastProvider: "whatsapp",
          lastTo: "+1555",
        });

        const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
        replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

        await runHeartbeatOnce({
          cfg,
          deps: { getQueueSize: () => 0, nowMs: () => 0 },
        });

        const replyOpts = replySpy.mock.calls[0]?.[1];
        // onModelSelected should be present regardless of model override
        expect(replyOpts).toEqual(
          expect.objectContaining({
            isHeartbeat: true,
            onModelSelected: expect.any(Function),
          }),
        );
      },
      { prefix: "openclaw-hb-prefix-no-override-" },
    );
  });

  it("passes onModelSelected with heartbeatModelOverride", async () => {
    await withTempHeartbeatSandbox(
      async ({ tmpDir, storePath }) => {
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: tmpDir,
              heartbeat: { every: "5m", target: "whatsapp", model: "ollama/llama3.2:1b" },
            },
          },
          channels: {
            whatsapp: {
              allowFrom: ["*"],
              responsePrefix: "{model}: ",
            },
          },
          session: { store: storePath },
        };
        const sessionKey = resolveMainSessionKey(cfg);
        await seedSessionStore(storePath, sessionKey, {
          lastChannel: "whatsapp",
          lastProvider: "whatsapp",
          lastTo: "+1555",
        });

        const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
        replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

        await runHeartbeatOnce({
          cfg,
          deps: { getQueueSize: () => 0, nowMs: () => 0 },
        });

        const replyOpts = replySpy.mock.calls[0]?.[1];
        expect(replyOpts).toEqual(
          expect.objectContaining({
            isHeartbeat: true,
            heartbeatModelOverride: "ollama/llama3.2:1b",
            onModelSelected: expect.any(Function),
          }),
        );
      },
      { prefix: "openclaw-hb-prefix-with-override-" },
    );
  });
});
