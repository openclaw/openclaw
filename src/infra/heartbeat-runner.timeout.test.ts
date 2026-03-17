import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { telegramPlugin } from "../../extensions/telegram/src/channel.js";
import { setTelegramRuntime } from "../../extensions/telegram/src/runtime.js";
import { whatsappPlugin } from "../../extensions/whatsapp/src/channel.js";
import { setWhatsAppRuntime } from "../../extensions/whatsapp/src/runtime.js";
import * as replyModule from "../auto-reply/reply.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentMainSessionKey, resolveMainSessionKey } from "../config/sessions.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { seedSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";

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

describe("heartbeat timeoutSeconds config", () => {
  it("should accept timeoutSeconds in heartbeat config", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          heartbeat: {
            every: "30m",
            timeoutSeconds: 60,
          },
        },
      },
    };

    expect(cfg.agents?.defaults?.heartbeat?.timeoutSeconds).toBe(60);
  });

  it("should accept timeoutSeconds in per-agent heartbeat config", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          heartbeat: {
            every: "30m",
          },
        },
        list: [
          {
            id: "ops",
            heartbeat: {
              every: "1h",
              timeoutSeconds: 90,
            },
          },
        ],
      },
    };

    const opsAgent = cfg.agents?.list?.[0];
    expect(opsAgent?.heartbeat?.timeoutSeconds).toBe(90);
  });

  it("should allow timeoutSeconds override at agent level", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          heartbeat: {
            every: "30m",
            timeoutSeconds: 60,
          },
        },
        list: [
          {
            id: "research",
            heartbeat: {
              timeoutSeconds: 120,
            },
          },
        ],
      },
    };

    const researchAgent = cfg.agents?.list?.[0];
    expect(researchAgent?.heartbeat?.timeoutSeconds).toBe(120);
  });

  it("should work without timeoutSeconds (backward compatible)", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          heartbeat: {
            every: "30m",
            model: "anthropic/claude-sonnet-4-5",
          },
        },
      },
    };

    expect(cfg.agents?.defaults?.heartbeat?.timeoutSeconds).toBeUndefined();
  });
});

describe("runHeartbeatOnce – timeoutOverrideSeconds passthrough", () => {
  async function runDefaultsHeartbeat(params: { timeoutSeconds?: number }) {
    return withTempHeartbeatSandbox(
      async ({ tmpDir, storePath }) => {
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: tmpDir,
              heartbeat: {
                every: "5m",
                target: "whatsapp",
                ...(params.timeoutSeconds !== undefined && {
                  timeoutSeconds: params.timeoutSeconds,
                }),
              },
            },
          },
          channels: { whatsapp: { allowFrom: ["*"] } },
          session: { store: storePath },
        };
        const sessionKey = resolveMainSessionKey(cfg);
        await seedSessionStore(storePath, sessionKey, {
          updatedAt: 0,
          lastChannel: "whatsapp",
          lastProvider: "whatsapp",
          lastTo: "+1555",
        });

        const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
        replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

        await runHeartbeatOnce({
          cfg,
          deps: {
            getQueueSize: () => 0,
            nowMs: () => 0,
          },
        });

        expect(replySpy).toHaveBeenCalledTimes(1);
        return replySpy.mock.calls[0]?.[1];
      },
      { prefix: "openclaw-hb-timeout-" },
    );
  }

  it("passes timeoutOverrideSeconds when heartbeat.timeoutSeconds is set", async () => {
    const replyOpts = await runDefaultsHeartbeat({ timeoutSeconds: 45 });
    expect(replyOpts).toEqual(
      expect.objectContaining({
        isHeartbeat: true,
        timeoutOverrideSeconds: 45,
      }),
    );
  });

  it("does not pass timeoutOverrideSeconds when heartbeat.timeoutSeconds is unset", async () => {
    const replyOpts = await runDefaultsHeartbeat({});
    expect(replyOpts?.timeoutOverrideSeconds).toBeUndefined();
  });

  it("passes per-agent timeoutSeconds override", async () => {
    return withTempHeartbeatSandbox(
      async ({ tmpDir, storePath }) => {
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              heartbeat: {
                every: "30m",
                timeoutSeconds: 60,
              },
            },
            list: [
              { id: "main", default: true },
              {
                id: "ops",
                workspace: tmpDir,
                heartbeat: {
                  every: "5m",
                  target: "whatsapp",
                  timeoutSeconds: 90,
                },
              },
            ],
          },
          channels: { whatsapp: { allowFrom: ["*"] } },
          session: { store: storePath },
        };
        const sessionKey = resolveAgentMainSessionKey({ cfg, agentId: "ops" });
        await seedSessionStore(storePath, sessionKey, {
          updatedAt: 0,
          lastChannel: "whatsapp",
          lastProvider: "whatsapp",
          lastTo: "+1555",
        });

        const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
        replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

        await runHeartbeatOnce({
          cfg,
          agentId: "ops",
          deps: {
            getQueueSize: () => 0,
            nowMs: () => 0,
          },
        });

        expect(replySpy).toHaveBeenCalledWith(
          expect.any(Object),
          expect.objectContaining({
            isHeartbeat: true,
            timeoutOverrideSeconds: 90,
          }),
          cfg,
        );
      },
      { prefix: "openclaw-hb-timeout-per-agent-" },
    );
  });
});
