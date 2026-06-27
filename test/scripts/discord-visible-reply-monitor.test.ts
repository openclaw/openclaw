import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  analyzeVisibleReplyGaps,
  formatVisibleReplyGapAlert,
} from "../../scripts/lib/discord-visible-reply-monitor.ts";

const t = (iso: string) => new Date(iso).getTime();

function msg(params: {
  id: string;
  at: string;
  content?: string;
  bot?: boolean;
  authorId?: string;
  username?: string;
}) {
  return {
    id: params.id,
    timestamp: params.at,
    content: params.content ?? "hello fiducian",
    author: {
      id: params.authorId ?? (params.bot ? "fiducian-bot" : "spencer"),
      username: params.username ?? (params.bot ? "Fiducian" : "Spencer"),
      bot: params.bot === true,
    },
  };
}

describe("discord visible reply monitor", () => {
  it("flags a direct human prompt with no bot reply inside the visibility deadline", () => {
    const gaps = analyzeVisibleReplyGaps({
      messages: [
        msg({ id: "human-1", at: "2026-06-27T15:00:00.000Z" }),
        msg({ id: "human-2", at: "2026-06-27T15:08:00.000Z", content: "still there?" }),
      ],
      nowMs: t("2026-06-27T15:10:00.000Z"),
      thresholdMs: 5 * 60_000,
      botUserIds: new Set(["fiducian-bot"]),
    });

    expect(gaps).toEqual([
      expect.objectContaining({
        promptId: "human-1",
        authorId: "spencer",
        ageMs: 10 * 60_000,
        replyStatus: "missing",
      }),
    ]);
  });

  it("does not flag prompts that have a bot reply before the deadline", () => {
    const gaps = analyzeVisibleReplyGaps({
      messages: [
        msg({ id: "human-1", at: "2026-06-27T15:00:00.000Z" }),
        msg({ id: "bot-1", at: "2026-06-27T15:03:00.000Z", bot: true, content: "visible reply" }),
      ],
      nowMs: t("2026-06-27T15:10:00.000Z"),
      thresholdMs: 5 * 60_000,
      botUserIds: new Set(["fiducian-bot"]),
    });

    expect(gaps).toEqual([]);
  });

  it("flags late bot replies separately from never-replied prompts", () => {
    const gaps = analyzeVisibleReplyGaps({
      messages: [
        msg({ id: "human-1", at: "2026-06-27T15:00:00.000Z" }),
        msg({ id: "bot-late", at: "2026-06-27T15:08:00.000Z", bot: true, content: "late" }),
      ],
      nowMs: t("2026-06-27T15:10:00.000Z"),
      thresholdMs: 5 * 60_000,
      botUserIds: new Set(["fiducian-bot"]),
    });

    expect(gaps).toEqual([
      expect.objectContaining({
        promptId: "human-1",
        replyStatus: "late",
        replyId: "bot-late",
        latencyMs: 8 * 60_000,
      }),
    ]);
  });

  it("supports an env/CLI token fallback for SecretRef-based local runs", () => {
    const source = fs.readFileSync("scripts/discord-visible-reply-monitor.ts", "utf8");
    expect(source).toContain("OPENCLAW_VISIBLE_REPLY_DISCORD_TOKEN");
    expect(source).toContain("process.env.DISCORD_BOT_TOKEN");
    expect(source).toContain("token,");
  });

  it("formats an actionable alert without leaking message bodies", () => {
    const [gap] = analyzeVisibleReplyGaps({
      messages: [msg({ id: "human-1", at: "2026-06-27T15:00:00.000Z" })],
      nowMs: t("2026-06-27T15:10:00.000Z"),
      thresholdMs: 5 * 60_000,
      botUserIds: new Set(["fiducian-bot"]),
    });

    expect(formatVisibleReplyGapAlert({ channelId: "1468361476585558210", gap })).toBe(
      "⚠️ Discord visible-reply monitor: no visible Fiducian reply within 5m for Spencer's message human-1 in channel 1468361476585558210 (age 10m). Check FAD-963/FAD-979 delivery suppression paths.",
    );
  });
});
