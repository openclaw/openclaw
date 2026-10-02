import { expect, it, vi } from "vitest";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  heartbeatTestConfig,
  seedMainSessionStore,
  withTempTelegramHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";

installHeartbeatRunnerTestRuntime();

it.each([
  {
    name: "decorates an alert",
    prefix: "[{provider}/{model}|think:{thinkingLevel}]",
    reply: "Heartbeat alert",
    expected: "[openai/gpt-5.4|think:high] Heartbeat alert",
  },
  {
    name: "suppresses a prefixed acknowledgment",
    prefix: "[{model}]",
    reply: "[gpt-5.4] HEARTBEAT_OK all good",
    expected: undefined,
  },
])(
  "resolves model-selection prefix variables before delivery: $name",
  async ({ prefix, reply, expected }) => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const target = "-1001234567890";
      const cfg = heartbeatTestConfig(tmpDir, "telegram", "telegram", storePath);
      cfg.channels = {
        telegram: {
          botToken: "test-token",
          allowFrom: ["*"],
          heartbeat: { showOk: false },
          responsePrefix: prefix,
        },
      };
      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: target,
      });
      replySpy.mockImplementation(async (_ctx, opts) => {
        opts?.onModelSelected?.({
          provider: "openai",
          model: "gpt-5.4-20260401",
          thinkLevel: "high",
        });
        return { text: reply };
      });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: target });
      await runHeartbeatOnce({
        cfg,
        deps: {
          telegram: sendTelegram,
          getQueueSize: () => 0,
          nowMs: () => 0,
          getReplyFromConfig: replySpy,
        },
      });
      if (expected === undefined) {
        expect(sendTelegram).not.toHaveBeenCalled();
      } else {
        expect(sendTelegram).toHaveBeenCalledOnce();
        expect(sendTelegram.mock.calls[0]?.[0]).toBe(target);
        expect(sendTelegram.mock.calls[0]?.[1]).toBe(expected);
        expect(typeof sendTelegram.mock.calls[0]?.[2]).toBe("object");
      }
    });
  },
);
