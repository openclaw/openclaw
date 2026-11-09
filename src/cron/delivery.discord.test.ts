// Real Discord plugin + cron preview/announce owners; only platform transport is synthetic.
import { afterEach, expect, it, vi } from "vitest";
import { discordPlugin } from "../../extensions/discord/api.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveCronDeliveryPreview } from "./delivery-preview.js";
import { sendCronAnnouncePayloadStrict } from "./delivery.js";
import { makeCronJob } from "./delivery.test-helpers.js";
import { resolveDeliveryTarget } from "./isolated-agent/delivery-target.js";

afterEach(() => {
  resetPluginRuntimeStateForTest();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each(["main", "default"])(
  "previews and announces through actual Discord account %s",
  async (accountId) => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("External network forbidden in this proof");
      }),
    );
    await withOpenClawTestState({ layout: "home" }, async (state) => {
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "discord", source: "test", plugin: discordPlugin }]),
      );
      const cfg: OpenClawConfig = {
        agents: { entries: { main: { workspace: state.workspaceDir } } },
        channels: { discord: { accounts: { [accountId]: { token: "synthetic-proof-token" } } } },
      };
      const to = "channel:123456789012345678";
      const job = makeCronJob({
        agentId: "main",
        delivery: { mode: "announce", channel: "discord", to },
      });
      const target = await resolveDeliveryTarget(cfg, "main", job.delivery!);
      expect(target).toMatchObject({
        ok: true,
        channel: "discord",
        to,
        accountId: accountId === "main" ? "main" : undefined,
      });
      if (!target.ok || !target.channel || !target.to) {
        throw new Error("Expected the configured Discord delivery target");
      }
      expect(await resolveCronDeliveryPreview({ cfg, job })).toEqual({
        label: `announce -> discord:${to}`,
        detail: "commits to the destination conversation; sends one external notification",
      });
      const send = vi.fn(async (_to: string, _text: string, _options: { accountId?: string }) => ({
        messageId: "synthetic-proof-message",
        channelId: "123456789012345678",
      }));
      const result = await sendCronAnnouncePayloadStrict({
        cfg,
        deps: { discord: send },
        agentId: "main",
        jobId: job.id,
        target: { channel: target.channel, to: target.to, accountId: target.accountId },
        payload: { text: "Scheduled account routing proof" },
        abortSignal: new AbortController().signal,
        completion: { job, runStartedAt: 1_700_000_000_000, deliveryAttemptFence: null },
      });
      expect(result.status).toBe("sent");
      expect(send).toHaveBeenCalledExactlyOnceWith(
        to,
        "Scheduled account routing proof",
        expect.objectContaining({ accountId: accountId === "main" ? "main" : undefined }),
      );
    });
  },
);
