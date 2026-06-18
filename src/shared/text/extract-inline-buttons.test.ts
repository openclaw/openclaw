import { describe, expect, it } from "vitest";
import { extractInlineButtons } from "./extract-inline-buttons.js";

describe("extractInlineButtons", () => {
  // ── Double-bracket formats (primary format from issue #41495) ──────

  it("extracts single button from [[{...}]] format (inner JSON is a button object)", () => {
    const input =
      "Here is a report.\n\n[[{\"text\":\"Approve\",\"callback_data\":\"approve_1\"}]]";
    const result = extractInlineButtons(input);

    expect(result.buttons).toHaveLength(1);
    expect(result.buttons[0]).toHaveLength(1);
    expect(result.buttons[0][0].text).toBe("Approve");
    expect(result.buttons[0][0].callback_data).toBe("approve_1");
    expect(result.text).not.toContain("[[{");
    expect(result.text).toContain("Here is a report");
  });

  it("extracts multiple comma-separated button objects from [[{...},{...}]]", () => {
    const input =
      "Pick:\n[[{\"text\":\"Yes\",\"callback_data\":\"yes\"},{\"text\":\"No\",\"callback_data\":\"no\"}]]";
    const result = extractInlineButtons(input);

    expect(result.buttons).toHaveLength(1);
    expect(result.buttons[0]).toHaveLength(2);
    expect(result.buttons[0][0].text).toBe("Yes");
    expect(result.buttons[0][1].text).toBe("No");
    expect(result.text).not.toContain("[[{");
  });

  // ── Triple-bracket formats ─────────────────────────────────────────

  it("extracts single button from [[[{...}]]] triple-bracket format", () => {
    const input =
      "Choose:\n[[[{\"text\":\"Approve\",\"callback_data\":\"approve_1\"}]]]";
    const result = extractInlineButtons(input);

    expect(result.buttons).toHaveLength(1);
    expect(result.buttons[0]).toHaveLength(1);
    expect(result.buttons[0][0].text).toBe("Approve");
    expect(result.text).not.toContain("[[{");
    expect(result.text).toContain("Choose");
  });

  it("extracts multiple buttons in a single row from triple bracket", () => {
    const input =
      "[[[{\"text\":\"Yes\",\"callback_data\":\"yes\"},{\"text\":\"No\",\"callback_data\":\"no\"}]]]";
    const result = extractInlineButtons(input);

    expect(result.buttons).toHaveLength(1);
    expect(result.buttons[0]).toHaveLength(2);
    expect(result.buttons[0][0].text).toBe("Yes");
    expect(result.buttons[0][1].text).toBe("No");
  });

  // ── Multi-row format ──────────────────────────────────────────────

  it("extracts multi-row button format [[row1],[row2]]", () => {
    const input =
      "Options:\n[[[{\"text\":\"Row1\",\"callback_data\":\"r1\"}],[{\"text\":\"Row2\",\"callback_data\":\"r2\"}]]]";
    const result = extractInlineButtons(input);

    expect(result.buttons).toHaveLength(2);
    expect(result.buttons[0]).toHaveLength(1);
    expect(result.buttons[0][0].text).toBe("Row1");
    expect(result.buttons[1]).toHaveLength(1);
    expect(result.buttons[1][0].text).toBe("Row2");
    expect(result.text).not.toContain("[[");
    expect(result.text).toContain("Options");
  });

  // ── Gemini real-world format (from issue #41495) ──────────────────

  it("extracts Gemini-style buttons with spaces from issue #41495", () => {
    // The exact format from the bug report:
    // [[ {"text": "✅ Reconcile Registry", "callback_data": "REGISTRY_CLEANUP"}, {"text": "🤔 Challenge", "callback_data": "CHALLENGE"} ]]
    const input =
      "Should I run a reconciliation now?\n\n[[ {\"text\": \"✅ Reconcile Registry\", \"callback_data\": \"REGISTRY_CLEANUP\"}, {\"text\": \"🤔 Challenge\", \"callback_data\": \"CHALLENGE\"} ]]";
    const result = extractInlineButtons(input);

    expect(result.buttons).toHaveLength(1);
    expect(result.buttons[0]).toHaveLength(2);
    expect(result.buttons[0][0].text).toBe("✅ Reconcile Registry");
    expect(result.buttons[0][0].callback_data).toBe("REGISTRY_CLEANUP");
    expect(result.buttons[0][1].text).toBe("🤔 Challenge");
    expect(result.buttons[0][1].callback_data).toBe("CHALLENGE");
    expect(result.text).not.toContain("[[{");
    expect(result.text).not.toContain("]]");
  });

  // ── TTS / directive safety ─────────────────────────────────────────

  it("preserves [[tts:voice]] and [[reply_to_current]] directives", () => {
    const input = "Use [[tts:voice]] and [[reply_to_current]] directives.";
    const result = extractInlineButtons(input);

    expect(result.buttons).toHaveLength(0);
    expect(result.text).toBe(input);
  });

  it("does not extract [[tts:...]] even when near button markers", () => {
    const input =
      "[[tts:voice]] Hello [[{\"text\":\"Click\",\"callback_data\":\"click\"}]]";
    const result = extractInlineButtons(input);

    expect(result.buttons).toHaveLength(1);
    expect(result.buttons[0][0].text).toBe("Click");
    expect(result.text).toContain("[[tts:voice]]");
    expect(result.text).not.toContain("[[{");
  });

  // ── Multiple blocks in same text ──────────────────────────────────

  it("handles multiple inline button blocks in the same text", () => {
    const input =
      "First:\n[[{\"text\":\"A\",\"callback_data\":\"a\"}]]\nSecond:\n[[{\"text\":\"B\",\"callback_data\":\"b\"}]]";
    const result = extractInlineButtons(input);

    expect(result.buttons).toHaveLength(2);
    expect(result.buttons[0][0].text).toBe("A");
    expect(result.buttons[1][0].text).toBe("B");
    expect(result.text).toContain("First:");
    expect(result.text).toContain("Second:");
    expect(result.text).not.toContain("[[{");
  });

  // ── Edge cases ────────────────────────────────────────────────────

  it("handles empty input", () => {
    const result = extractInlineButtons("");
    expect(result.buttons).toHaveLength(0);
    expect(result.text).toBe("");
  });

  it("returns empty buttons when no inline button pattern found", () => {
    const input = "Just some regular text with no buttons.";
    const result = extractInlineButtons(input);

    expect(result.buttons).toHaveLength(0);
    expect(result.text).toBe(input);
  });

  it("ignores bracket content that is not valid button JSON", () => {
    const input = "Ignore [[\"not\",\"valid\",\"buttons\"]].";
    const result = extractInlineButtons(input);

    expect(result.buttons).toHaveLength(0);
    expect(result.text).toBe(input);
  });

  it("ignores arrays of strings (not button objects)", () => {
    const input = "Skip [[\"string1\",\"string2\"]].";
    const result = extractInlineButtons(input);

    expect(result.buttons).toHaveLength(0);
    expect(result.text).toBe(input);
  });

  it("ignores non-bracket content that looks like JSON", () => {
    const input =
      "Use the [[reply_to_current]] tag and [[tts:voice]] directive but not [invalid JSON]]";
    const result = extractInlineButtons(input);

    expect(result.buttons).toHaveLength(0);
  });

  // ── Style preservation ────────────────────────────────────────────

  it("extracts button style when present", () => {
    const input =
      "[[{\"text\":\"Click\",\"callback_data\":\"click\",\"style\":\"primary\"}]]";
    const result = extractInlineButtons(input);

    expect(result.buttons).toHaveLength(1);
    expect(result.buttons[0][0].style).toBe("primary");
  });

  it("cleans up whitespace after removal", () => {
    const input =
      "Text before\n\n[[{\"text\":\"Click\",\"callback_data\":\"click\"}]]\n\nText after";
    const result = extractInlineButtons(input);

    expect(result.buttons).toHaveLength(1);
    expect(result.text).toContain("Text before");
    expect(result.text).toContain("Text after");
    expect(result.text).not.toContain("[[{");
  });

  // ── Issue #41495 end-to-end ────────────────────────────────────────

  it("extracts buttons from issue #41495 format without leftover brackets", () => {
    // The format the PR was originally targeting: double bracket with
    // button objects inside. This was the case that had the parser bug
    // where inner ] was misidentified as a closing marker.
    const input =
      "Here is the result.\n\n[[{\"text\":\"Open\",\"callback_data\":\"open_detail\"},{\"text\":\"Close\",\"callback_data\":\"close\"}]]\n\nPlease choose an option.";
    const result = extractInlineButtons(input);

    expect(result.buttons).toHaveLength(1);
    expect(result.buttons[0]).toHaveLength(2);
    expect(result.buttons[0][0].text).toBe("Open");
    expect(result.buttons[0][1].text).toBe("Close");
    expect(result.text).toContain("Here is the result");
    expect(result.text).toContain("Please choose an option");
    expect(result.text).not.toContain("[[{");
    // No leftover bracket artifacts
    expect(result.text).not.toContain("]]");
  });
});
