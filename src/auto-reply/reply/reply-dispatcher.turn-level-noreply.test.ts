/**
 * Turn-level NO_REPLY suppression — substrate-leak regression coverage.
 *
 * The leak forensic (2026-05-24 session cf23b629) showed:
 *   intermediate `block`-kind text payloads emitted BEFORE the final `NO_REPLY`
 *   in the same turn were being delivered to Telegram even though the final
 *   suppressed itself. Operators saw ~140 overnight notifications of agent
 *   reasoning ("Inbox empty, no threads…" etc) that should never have shipped.
 *
 * Fix lineage: woodhouse msg-20260524-183651-3206538 directed Path B (gateway-
 * side) with the redesign requirement that suppression buffer block-kind
 * payloads until final arrives, then flush-or-drop. A flag-on-NO_REPLY check
 * cannot work because the flag is unset at the moment the leading block
 * enqueues.
 */
import { describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../types.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";

describe("createReplyDispatcher — turn-level NO_REPLY suppression (substrate-leak fix)", () => {
  it("drops a leading block payload when a NO_REPLY final follows in the same turn (the actual leak shape)", async () => {
    const delivered: Array<{ kind: string; text: string | undefined }> = [];
    const skipped: Array<{ kind: string; text: string | undefined; reason: string }> = [];

    const dispatcher = createReplyDispatcher({
      deliver: async (payload, info) => {
        delivered.push({ kind: info.kind, text: payload.text });
      },
      onSkip: (payload, info) => {
        skipped.push({ kind: info.kind, text: payload.text, reason: info.reason });
      },
    });

    // ── The exact leak shape from the forensic ──────────────────────────────
    // 1. Reasoning block first ("Inbox empty…")
    expect(
      dispatcher.sendBlockReply({ text: "Inbox empty, no threads, no spawns. State clean." }),
    ).toBe(true);
    // 2. Then the final NO_REPLY arrives
    expect(dispatcher.sendFinalReply({ text: "NO_REPLY" })).toBe(false);

    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    // The leak shape: previously, "Inbox empty…" would have been delivered.
    // With the buffer-until-final fix, NOTHING is delivered.
    expect(delivered).toEqual([]);

    // The dropped block must surface an onSkip(silent) signal so channels know
    // suppression was intentional (not an empty-payload bug).
    const blockSkips = skipped.filter((s) => s.kind === "block");
    expect(blockSkips).toHaveLength(1);
    expect(blockSkips[0]).toEqual({
      kind: "block",
      text: "Inbox empty, no threads, no spawns. State clean.",
      reason: "silent",
    });
  });

  it("drops multiple buffered blocks when a NO_REPLY final follows (multi-block leak shape)", async () => {
    const delivered: string[] = [];
    const skippedBlocks: string[] = [];

    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
      onSkip: (payload, info) => {
        if (info.kind === "block" && info.reason === "silent") {
          skippedBlocks.push(payload.text ?? "");
        }
      },
    });

    dispatcher.sendBlockReply({ text: "first reasoning chunk" });
    dispatcher.sendBlockReply({ text: "second reasoning chunk" });
    dispatcher.sendBlockReply({ text: "third reasoning chunk" });
    dispatcher.sendFinalReply({ text: "NO_REPLY" });

    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual([]);
    expect(skippedBlocks).toEqual([
      "first reasoning chunk",
      "second reasoning chunk",
      "third reasoning chunk",
    ]);
  });

  it("flushes buffered blocks in order when the final is a real reply", async () => {
    const delivered: Array<{ kind: string; text: string | undefined }> = [];

    const dispatcher = createReplyDispatcher({
      deliver: async (payload, info) => {
        delivered.push({ kind: info.kind, text: payload.text });
      },
    });

    dispatcher.sendBlockReply({ text: "intro" });
    dispatcher.sendBlockReply({ text: "middle" });
    dispatcher.sendFinalReply({ text: "final answer" });

    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual([
      { kind: "block", text: "intro" },
      { kind: "block", text: "middle" },
      { kind: "final", text: "final answer" },
    ]);
  });

  it("does NOT buffer tool-kind payloads (they must flow to the agent loop)", async () => {
    const delivered: Array<{ kind: string; text: string | undefined }> = [];

    const dispatcher = createReplyDispatcher({
      deliver: async (payload, info) => {
        delivered.push({ kind: info.kind, text: payload.text });
      },
    });

    dispatcher.sendBlockReply({ text: "reasoning A" });
    dispatcher.sendToolResult({ text: "tool output" });
    dispatcher.sendBlockReply({ text: "reasoning B" });
    dispatcher.sendFinalReply({ text: "NO_REPLY" });

    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    // Tool result must be delivered even though final is NO_REPLY.
    // Both reasoning blocks must be dropped.
    expect(delivered).toEqual([{ kind: "tool", text: "tool output" }]);
  });

  it("delivers normally when there is no leading block (final-only NO_REPLY turn)", async () => {
    const delivered: ReplyPayload[] = [];
    const skipped: Array<{ kind: string; reason: string }> = [];

    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload);
      },
      onSkip: (_, info) => {
        skipped.push({ kind: info.kind, reason: info.reason });
      },
    });

    dispatcher.sendFinalReply({ text: "NO_REPLY" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual([]);
    // Single skip on the final (legacy normalize-reply path).
    expect(skipped.some((s) => s.kind === "final" && s.reason === "silent")).toBe(true);
  });

  it("defensive flush at markComplete when no final ever arrives (stream tear-down)", async () => {
    const delivered: string[] = [];

    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
    });

    dispatcher.sendBlockReply({ text: "partial output before stream torn down" });
    // No sendFinalReply — markComplete is the only turn-close signal.
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    // The buffered block must NOT be silently lost — it must be flushed on
    // markComplete because we have no NO_REPLY evidence to justify dropping it.
    expect(delivered).toEqual(["partial output before stream torn down"]);
  });

  it("opt-out: setting enableTurnLevelNoReplySuppression=false restores legacy behavior", async () => {
    const delivered: Array<{ kind: string; text: string | undefined }> = [];

    const dispatcher = createReplyDispatcher({
      enableTurnLevelNoReplySuppression: false,
      deliver: async (payload, info) => {
        delivered.push({ kind: info.kind, text: payload.text });
      },
    });

    // With suppression off, the leading block is delivered immediately (the
    // legacy leak shape). The final NO_REPLY is still dropped by the existing
    // normalize-reply path. This test pins the opt-out for callers who need
    // bug-for-bug compatibility.
    dispatcher.sendBlockReply({ text: "this would have leaked" });
    dispatcher.sendFinalReply({ text: "NO_REPLY" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual([{ kind: "block", text: "this would have leaked" }]);
  });

  it("preserves transformReplyPayload semantics on buffered blocks (normalize-at-enqueue)", async () => {
    const delivered: string[] = [];

    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
      transformReplyPayload: (payload) => {
        if (payload.text?.includes("BLOCKED")) {
          return null;
        }
        return payload;
      },
    });

    // BLOCKED-text block should be rejected at enqueue time (returns false),
    // not buffered.
    expect(dispatcher.sendBlockReply({ text: "BLOCKED reasoning" })).toBe(false);
    expect(dispatcher.sendBlockReply({ text: "allowed reasoning" })).toBe(true);
    dispatcher.sendFinalReply({ text: "real final" });

    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual(["allowed reasoning", "real final"]);
  });

  it("onSkip fires for each dropped buffered block (channel observability)", async () => {
    const skipReasons: Array<{ kind: string; text: string | undefined; reason: string }> = [];

    const dispatcher = createReplyDispatcher({
      deliver: vi.fn(),
      onSkip: (payload, info) => {
        skipReasons.push({ kind: info.kind, text: payload.text, reason: info.reason });
      },
    });

    dispatcher.sendBlockReply({ text: "leak chunk A" });
    dispatcher.sendBlockReply({ text: "leak chunk B" });
    dispatcher.sendFinalReply({ text: "NO_REPLY" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    // Two block skips + one final skip (final path goes through normalize-reply).
    const blockSkips = skipReasons.filter((s) => s.kind === "block");
    expect(blockSkips).toHaveLength(2);
    expect(blockSkips.every((s) => s.reason === "silent")).toBe(true);
    expect(blockSkips.map((s) => s.text)).toEqual(["leak chunk A", "leak chunk B"]);
  });
});
