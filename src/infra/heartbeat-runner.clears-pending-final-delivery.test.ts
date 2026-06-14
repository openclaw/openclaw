import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { runHeartbeatOnce, type HeartbeatDeps } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import { seedMainSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";

installHeartbeatRunnerTestRuntime();

describe("runHeartbeatOnce clears stuck pendingFinalDelivery state after a successful send", () => {
  const TELEGRAM_GROUP = "-1001234567890";

  function createHeartbeatConfig(storePath: string): OpenClawConfig {
    return {
      agents: {
        defaults: {
          heartbeat: { every: "5m", target: "telegram" },
        },
      },
      channels: {
        telegram: {
          token: "test-token",
          allowFrom: ["*"],
          heartbeat: { showOk: false },
        },
      },
      session: { store: storePath },
    } as unknown as OpenClawConfig;
  }

  it("nulls every pendingFinalDelivery* field after delivering substantive heartbeat content", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = createHeartbeatConfig(storePath);

      // Seed a session that carries a stuck pendingFinalDelivery from a prior run.
      // pendingFinalDeliveryText must be a heartbeat-ack token so the heartbeat-defer
      // window short-circuit at heartbeat-runner.ts:~1328 does not bail before send.
      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: TELEGRAM_GROUP,
        updatedAt: Date.now(),
        pendingFinalDelivery: true,
        pendingFinalDeliveryText: "HEARTBEAT_OK",
      });

      // Manually patch in the remaining pendingFinalDelivery* fields the seeder
      // does not expose, so the test proves *all seven* fields get cleared.
      const seeded = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
        string,
        Record<string, unknown> | undefined
      >;
      seeded[sessionKey] = {
        ...seeded[sessionKey],
        pendingFinalDeliveryCreatedAt: 1,
        pendingFinalDeliveryLastAttemptAt: 2,
        pendingFinalDeliveryAttemptCount: 3,
        pendingFinalDeliveryLastError: "prior-error",
        pendingFinalDeliveryContext: { foo: "bar" },
      };
      await fs.writeFile(storePath, JSON.stringify(seeded));

      // Substantive reply text forces the post-success store write path
      // (heartbeat-runner.ts:~2010, `if (!shouldSkipMain && normalized.text.trim())`).
      const replyText = "Heartbeat update: everything is green.";
      replySpy.mockResolvedValue({ text: replyText });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", toJid: "jid" });

      const result = await runHeartbeatOnce({
        cfg,
        deps: {
          telegram: sendTelegram as unknown,
          getQueueSize: () => 0,
          nowMs: () => Date.now(),
          getReplyFromConfig: replySpy,
        } satisfies HeartbeatDeps,
      });

      expect(result.status).toBe("ran");
      expect(sendTelegram).toHaveBeenCalledTimes(1);

      const finalStore = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
        string,
        Record<string, unknown> | undefined
      >;
      const entry = finalStore[sessionKey];
      expect(entry?.lastHeartbeatText).toBe(replyText);
      expect(typeof entry?.lastHeartbeatSentAt).toBe("number");
      expect(entry?.pendingFinalDelivery).toBeUndefined();
      expect(entry?.pendingFinalDeliveryText).toBeUndefined();
      expect(entry?.pendingFinalDeliveryCreatedAt).toBeUndefined();
      expect(entry?.pendingFinalDeliveryLastAttemptAt).toBeUndefined();
      expect(entry?.pendingFinalDeliveryAttemptCount).toBeUndefined();
      expect(entry?.pendingFinalDeliveryLastError).toBeUndefined();
      expect(entry?.pendingFinalDeliveryContext).toBeUndefined();
    });
  });
});
