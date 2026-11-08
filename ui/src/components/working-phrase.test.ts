// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./working-phrase-solid.tsx";

// Mirrors WORKING_PHRASE_SHOW_AFTER_MS / WORKING_PHRASE_ROTATE_EVERY_MS in
// working-phrase-solid.tsx (knip forbids test-only exports).
const WORKING_PHRASE_SHOW_AFTER_MS = 30_000;
const WORKING_PHRASE_ROTATE_EVERY_MS = 45_000;

const NOW = 2_000_000_000;
const PHRASE_TEXT = /^·\s\S+…$/;
type WorkingPhraseElement = HTMLElementTagNameMap["openclaw-working-phrase"];
const text = (element: Element) => element.textContent?.replace(/\s+/g, " ").trim() ?? "";

async function atBucket(element: WorkingPhraseElement, bucket = 0): Promise<string> {
  await element.updateComplete;
  vi.setSystemTime(
    NOW + WORKING_PHRASE_SHOW_AFTER_MS + bucket * WORKING_PHRASE_ROTATE_EVERY_MS - 1_000,
  );
  await vi.advanceTimersByTimeAsync(1_000);
  return text(element);
}

describe("openclaw-working-phrase", () => {
  let element: WorkingPhraseElement;

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    element = document.createElement("openclaw-working-phrase");
    element.seed = "stream-working:test";
    element.startMs = NOW;
    document.body.appendChild(element);
  });

  afterEach(() => {
    element.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("stays silent through the grace period and holds each phrase until its rotation", async () => {
    await element.updateComplete;

    await vi.advanceTimersByTimeAsync(WORKING_PHRASE_SHOW_AFTER_MS - 1_000);
    expect(element.textContent?.trim()).toBe("");

    await vi.advanceTimersByTimeAsync(1_000);
    const first = text(element);
    expect(first).toMatch(PHRASE_TEXT);
    expect(element.style.display).toBe("contents");

    await vi.advanceTimersByTimeAsync(WORKING_PHRASE_ROTATE_EVERY_MS - 1_000);
    expect(text(element)).toBe(first);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(text(element)).not.toBe(first);
  });

  it.each([0, 1, 6])(
    "walks all %i authored phrases without translation and restores the default vocabulary",
    async (length) => {
      const defaultPhrase = await atBucket(element);
      const phrases = Array.from({ length }, (_, index) => `Phrase ${index + 1}`);
      element.phrases = phrases;
      const displayed = new Set<string>();
      for (let bucket = 0; bucket < Math.max(1, length); bucket++) {
        displayed.add(await atBucket(element, bucket));
      }
      expect(displayed).toEqual(new Set(length ? phrases.map((phrase) => `· ${phrase}…`) : [""]));
      if (length === 1) {
        for (const bucket of [1, 100_000]) {
          expect(await atBucket(element, bucket)).toBe("· Phrase 1…");
        }
      }
      element.phrases = undefined;
      expect(await atBucket(element)).toBe(defaultPhrase);
    },
  );
});
