// Covers heartbeat sender selection when delivery target differs.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import { seedMainSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";

installHeartbeatRunnerTestRuntime({ includeSlack: true });

describe("runHeartbeatOnce", () => {
  it("uses the delivery target as sender when lastTo differs", async () => {
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
          lastChannel: "telegram",
          lastProvider: "telegram",
          lastTo: "1644620762",
        });

        replySpy.mockImplementation(async (ctx) => {
          expect(ctx).toMatchObject({
            From: "C0A9P2N8QHY",
            To: "C0A9P2N8QHY",
            OriginatingChannel: "slack",
            OriginatingTo: "C0A9P2N8QHY",
          });
          return { text: "ok" };
        });

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

        expect(sendSlack).toHaveBeenCalledWith(
          "C0A9P2N8QHY",
          expect.any(String),
          expect.any(Object),
        );
      },
      { prefix: "openclaw-hb-" },
    );
  });
});
