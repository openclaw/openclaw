import { describe, expect, it } from "vitest";
import { HEARTBEAT_PROMPT, resolveHeartbeatPrompt } from "../heartbeat.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import { normalizeReplyPayload } from "./normalize-reply.js";

// Keep channelData-only payloads so channel-specific replies survive normalization.
describe("normalizeReplyPayload", () => {
  it("keeps channelData-only replies", () => {
    const payload = {
      channelData: {
        line: {
          flexMessage: { type: "bubble" },
        },
      },
    };

    const normalized = normalizeReplyPayload(payload);

    expect(normalized).not.toBeNull();
    expect(normalized?.text).toBeUndefined();
    expect(normalized?.channelData).toEqual(payload.channelData);
  });

  it("records silent skips", () => {
    const reasons: string[] = [];
    const normalized = normalizeReplyPayload(
      { text: SILENT_REPLY_TOKEN },
      {
        onSkip: (reason) => reasons.push(reason),
      },
    );

    expect(normalized).toBeNull();
    expect(reasons).toEqual(["silent"]);
  });

  it("records empty skips", () => {
    const reasons: string[] = [];
    const normalized = normalizeReplyPayload(
      { text: "   " },
      {
        onSkip: (reason) => reasons.push(reason),
      },
    );

    expect(normalized).toBeNull();
    expect(reasons).toEqual(["empty"]);
  });

  it("suppresses leaked heartbeat poll prompt", () => {
    const reasons: string[] = [];
    const normalized = normalizeReplyPayload(
      { text: HEARTBEAT_PROMPT },
      { onSkip: (reason) => reasons.push(reason) },
    );

    expect(normalized).toBeNull();
    expect(reasons).toEqual(["heartbeat"]);
  });

  it("suppresses configured custom heartbeat prompts (including stacked)", () => {
    const customPrompt = resolveHeartbeatPrompt("Check HEARTBEAT.md and reply HEARTBEAT_OK.");
    const stacked = `${customPrompt}\n\n${customPrompt}`;

    expect(
      normalizeReplyPayload({ text: customPrompt }, { heartbeatPrompt: customPrompt }),
    ).toBeNull();
    expect(normalizeReplyPayload({ text: stacked }, { heartbeatPrompt: customPrompt })).toBeNull();
  });

  it("does not suppress legitimate messages mentioning heartbeat.md", () => {
    const normalized = normalizeReplyPayload({
      text: "Please read heartbeat.md and summarize it.",
    });

    expect(normalized).not.toBeNull();
    expect(normalized?.text).toBe("Please read heartbeat.md and summarize it.");
  });

  it("keeps heartbeat poll text when media is attached", () => {
    const normalized = normalizeReplyPayload({
      text: HEARTBEAT_PROMPT,
      mediaUrl: "https://example.com/image.png",
    });

    expect(normalized).not.toBeNull();
  });
});
