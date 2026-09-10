/**
 * Display-cap truncation boundary regression tests.
 *
 * The live display cap retires the head of the shared assistant buffer while the
 * snapshot scope keeps character offsets into that buffer. Truncation must stay
 * on character boundaries and must never re-materialize bytes the retained buffer
 * no longer carries into a user-visible reply.
 */
import { describe, expect, it } from "vitest";
import { mergeAssistantText } from "./agent-event-assistant-text.js";
import { truncateChatHistoryText } from "./chat-display-projection.helpers.js";
import { sanitizeChatHistoryMessage } from "./chat-display-projection.sanitize.js";
import { capLiveAssistantText } from "./live-chat-projector.js";

const LIVE_CHAT_BUFFER_CHARS = 500_000;
const CJK = "代码审查报告与修复建议";
const EMOJI = "🚀🐈‍⬛🧪";

function findLoneSurrogate(value: string): number | null {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return index;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return index;
    }
  }
  return null;
}

describe("display-cap truncation boundary", () => {
  it("does not emit bytes the retained live buffer no longer carries", () => {
    const firstItem = `${CJK}${EMOJI}`.repeat(LIVE_CHAT_BUFFER_CHARS / 8);
    const authoredTail = `${CJK}尾巴🙂`;
    const first = capLiveAssistantText(
      mergeAssistantText({ text: "" }, { itemId: "first", text: firstItem }, "live"),
    );
    // A second item is appended, so the scope records the retired prior item as a
    // prefix offset into the shared live buffer.
    const snapshot = mergeAssistantText(
      { text: first },
      { itemId: "answer", text: authoredTail, delta: authoredTail },
      "live",
    );
    const capped = capLiveAssistantText(snapshot);
    expect(capped.endsWith(authoredTail)).toBe(true);
    expect(snapshot.scope?.prefix.length).toBeGreaterThan(1_000);
    // A transport-level bound (the second display cap in the pipeline) keeps only
    // the visible window while the snapshot's recorded offsets stay unchanged.
    const visibleWindow = capped.slice(capped.indexOf(authoredTail));
    const merged = mergeAssistantText(
      { text: visibleWindow, scope: snapshot.scope },
      { itemId: "answer", delta: "新增结论" },
      "live",
    );

    expect(merged.text).toBe(`${visibleWindow}新增结论`);
    expect(merged.text.startsWith(visibleWindow)).toBe(true);
    expect(merged.text.length).toBeLessThanOrEqual(visibleWindow.length + 4);
  });

  it("keeps the retained buffer carrying the prefix its scope records", () => {
    const shapes = [CJK, EMOJI, "a🚀b", "字🧪字", `${CJK}${EMOJI}${CJK}`];
    const failures: string[] = [];
    for (const shape of shapes) {
      for (let fill = 0; fill <= 4; fill++) {
        for (const tail of ["", CJK, EMOJI, `\n\n${CJK}`]) {
          const prefix = `${shape.repeat(Math.ceil(LIVE_CHAT_BUFFER_CHARS / shape.length) + 1)}${"字".repeat(fill)}`;
          const text = `${prefix}${tail}`;
          const snapshot = mergeAssistantText(
            { text: "" },
            { itemId: "answer", text, delta: text },
            "live",
          );
          const capped = capLiveAssistantText(snapshot);
          const scopePrefix = snapshot.scope?.prefix ?? "";
          if (!capped.startsWith(scopePrefix)) {
            failures.push(
              `capped head=${JSON.stringify(capped.slice(0, 8))} scope prefix=${JSON.stringify(scopePrefix.slice(0, 8))}`,
            );
          }
          if (capped.length > LIVE_CHAT_BUFFER_CHARS + 1) {
            failures.push(`cap exceeded: ${capped.length}`);
          }
          const lone = findLoneSurrogate(capped);
          if (lone !== null) {
            failures.push(`lone surrogate at ${lone}`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it.each([
    { name: "multi-byte history text", text: `${CJK}${EMOJI}`.repeat(2_000) },
    { name: "surrogate pair on the cap edge", text: `${CJK.repeat(1_333)}🚀${CJK.repeat(2_000)}` },
  ])("truncates $name on a character boundary and keeps the display-cap marker", ({ text }) => {
    const capped = truncateChatHistoryText(text, 8_000);
    expect(capped.truncated).toBe(true);
    expect(findLoneSurrogate(capped.text)).toBeNull();
    expect(capped.text).not.toContain("\uFFFD");
    expect(text.startsWith(capped.text.replace(/\n\.\.\.\(truncated\)\.\.\.$/u, ""))).toBe(true);

    const projected = sanitizeChatHistoryMessage(
      { role: "assistant", content: [{ type: "text", text }] },
      8_000,
    ).message as Record<string, unknown>;
    expect(projected["__openclaw"]).toMatchObject({ truncated: true, reason: "display-cap" });
  });

  it("leaves capped text unchanged when the reported limit is never reached", () => {
    const text = `${CJK}${EMOJI}`;
    expect(truncateChatHistoryText(text, 8_000)).toEqual({ text, truncated: false });
  });
});
