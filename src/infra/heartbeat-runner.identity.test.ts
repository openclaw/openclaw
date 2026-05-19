import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import { seedMainSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";

installHeartbeatRunnerTestRuntime({ includeSlack: true });

// Issue #84297: per-agent identity overlay (`agents.list[<id>].identity`) was
// being dropped on heartbeat target-channel pushes. Slack messages from cron
// `--announce` and heartbeat sends rendered under the generic app identity
// instead of the configured agent persona, while the reply path applied the
// overlay correctly post-#38235. The fix resolves the agent's outbound
// identity once in `heartbeat-runner.ts` and threads it into both
// `sendDurableMessageBatch` calls (the heartbeat-ok path and the main reply
// send). These tests pin down that the resolved identity reaches the channel
// adapter on both code paths.
describe("runHeartbeatOnce identity overlay propagation (issue #84297)", () => {
  it("forwards the per-agent identity to Slack on the main heartbeat send", async () => {
    await withTempHeartbeatSandbox(
      async ({ tmpDir, storePath, replySpy }) => {
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: tmpDir,
              heartbeat: {
                every: "5m",
                target: "slack",
                to: "C0A9P2N8QHY",
              },
            },
            list: [
              {
                id: "main",
                identity: { name: "Pulse", emoji: "📟" },
              },
            ],
          },
          session: { store: storePath },
        };

        await seedMainSessionStore(storePath, cfg, {
          lastChannel: "slack",
          lastProvider: "slack",
          lastTo: "C0A9P2N8QHY",
        });

        replySpy.mockResolvedValue({ text: "all systems nominal" });

        const sendSlack = vi.fn().mockResolvedValue({
          messageId: "m1",
          channelId: "C0A9P2N8QHY",
        });

        await runHeartbeatOnce({
          cfg,
          deps: {
            getReplyFromConfig: replySpy,
            slack: sendSlack,
            getQueueSize: () => 0,
            nowMs: () => 0,
          },
        });

        expect(sendSlack).toHaveBeenCalled();
        const opts = sendSlack.mock.calls[0]?.[2] as
          | { identity?: { name?: string; emoji?: string; avatarUrl?: string; theme?: string } }
          | undefined;
        expect(opts?.identity).toBeDefined();
        expect(opts?.identity?.name).toBe("Pulse");
        expect(opts?.identity?.emoji).toBe("📟");
      },
      { prefix: "openclaw-hb-identity-" },
    );
  });

  it("leaves identity undefined when no per-agent identity is configured", async () => {
    await withTempHeartbeatSandbox(
      async ({ tmpDir, storePath, replySpy }) => {
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: tmpDir,
              heartbeat: {
                every: "5m",
                target: "slack",
                to: "C0A9P2N8QHY",
              },
            },
          },
          session: { store: storePath },
        };

        await seedMainSessionStore(storePath, cfg, {
          lastChannel: "slack",
          lastProvider: "slack",
          lastTo: "C0A9P2N8QHY",
        });

        replySpy.mockResolvedValue({ text: "ok" });

        const sendSlack = vi.fn().mockResolvedValue({
          messageId: "m2",
          channelId: "C0A9P2N8QHY",
        });

        await runHeartbeatOnce({
          cfg,
          deps: {
            getReplyFromConfig: replySpy,
            slack: sendSlack,
            getQueueSize: () => 0,
            nowMs: () => 0,
          },
        });

        expect(sendSlack).toHaveBeenCalled();
        const opts = sendSlack.mock.calls[0]?.[2] as { identity?: unknown } | undefined;
        expect(opts?.identity).toBeUndefined();
      },
      { prefix: "openclaw-hb-no-identity-" },
    );
  });
});
