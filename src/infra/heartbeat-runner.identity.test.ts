import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import { seedMainSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";

installHeartbeatRunnerTestRuntime({ includeSlack: true });

describe("runHeartbeatOnce identity", () => {
  it.each([
    { name: "alert", replyText: "needs attention", showOk: false },
    { name: "heartbeat ok", replyText: "HEARTBEAT_OK", showOk: true },
  ])("forwards agent identity on $name delivery", async ({ replyText, showOk }) => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "slack", to: "channel:C123" },
          },
          list: [{ id: "main", identity: { name: "Pulse", emoji: "📟" } }],
        },
        channels: { slack: { heartbeat: { showOk } } },
        session: { store: storePath },
      };
      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "slack",
        lastProvider: "slack",
        lastTo: "channel:C123",
      });
      replySpy.mockResolvedValue({ text: replyText });
      const sendSlack = vi.fn().mockResolvedValue({ messageId: "m1", channelId: "C123" });

      await runHeartbeatOnce({
        cfg,
        deps: {
          getReplyFromConfig: replySpy,
          slack: sendSlack,
          getQueueSize: () => 0,
          nowMs: () => 0,
        },
      });

      expect(sendSlack).toHaveBeenCalledTimes(1);
      expect(sendSlack.mock.calls[0]?.[2]).toMatchObject({
        identity: { name: "Pulse", emoji: "📟" },
      });
    });
  });
});
