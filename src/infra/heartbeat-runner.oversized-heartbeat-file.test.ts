// Regression test for bounded HEARTBEAT.md reads.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import { seedMainSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";

installHeartbeatRunnerTestRuntime({ includeSlack: true });

describe("runHeartbeatOnce oversized HEARTBEAT.md", () => {
  it("treats an oversized HEARTBEAT.md like a missing file and continues the run", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "slack", to: "channel:C123" },
          },
        },
        channels: { slack: { heartbeat: { showOk: false } } },
        session: { store: storePath },
      };
      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "slack",
        lastProvider: "slack",
        lastTo: "channel:C123",
      });
      // Overwrite the default heartbeat file with content larger than the 16 MB cap.
      const oversizedContent = Buffer.alloc(16 * 1024 * 1024 + 1, "x");
      await fs.writeFile(path.join(tmpDir, "HEARTBEAT.md"), oversizedContent);

      replySpy.mockResolvedValue({ text: "needs attention" });
      const sendSlack = vi.fn().mockResolvedValue({ messageId: "m1", channelId: "C123" });

      const res = await runHeartbeatOnce({
        cfg,
        deps: {
          getReplyFromConfig: replySpy,
          slack: sendSlack,
          getQueueSize: () => 0,
          nowMs: () => 0,
        },
      });

      expect(res.status).toBe("ran");
      expect(sendSlack).toHaveBeenCalledTimes(1);
    });
  });
});
