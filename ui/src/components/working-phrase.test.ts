// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./working-phrase.ts";

// Mirrors WORKING_PHRASE_SHOW_AFTER_MS / WORKING_PHRASE_ROTATE_EVERY_MS in
// working-phrase-solid.tsx (knip forbids test-only exports).
const WORKING_PHRASE_SHOW_AFTER_MS = 30_000;
const WORKING_PHRASE_ROTATE_EVERY_MS = 45_000;

type WorkingPhraseElement = HTMLElement & {
  startMs: number | null;
  seed: string;
  phrases: readonly string[] | undefined;
  updateComplete: Promise<boolean>;
};

const NOW = 2_000_000_000;
// "· Clawing…" — a middot, one gerund, an ellipsis.
const PHRASE_TEXT = /^·\s\S+…$/;

function mountPhrase(seed = "stream-working:test"): WorkingPhraseElement {
  // SAFETY: The imported bridge declares these writable host properties.
  const element = document.createElement("openclaw-working-phrase") as WorkingPhraseElement;
  element.seed = seed;
  element.startMs = NOW;
  document.body.appendChild(element);
  return element;
}

async function textAt(element: WorkingPhraseElement, elapsedMs: number): Promise<string> {
  await element.updateComplete;
  vi.setSystemTime(NOW + elapsedMs - 1_000);
  await vi.advanceTimersByTimeAsync(1_000);
  return element.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

describe("openclaw-working-phrase", () => {
  let element: WorkingPhraseElement;
  let visibility: DocumentVisibilityState;

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    visibility = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    element = mountPhrase();
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
    const first = element.textContent?.replace(/\s+/g, " ").trim();
    expect(first).toMatch(PHRASE_TEXT);
    expect(element.style.display).toBe("contents");

    await vi.advanceTimersByTimeAsync(WORKING_PHRASE_ROTATE_EVERY_MS - 1_000);
    expect(element.textContent?.replace(/\s+/g, " ").trim()).toBe(first);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(element.textContent?.replace(/\s+/g, " ").trim()).not.toBe(first);
  });

  it("pauses hidden polling, catches up on return, and stops after removal", async () => {
    element.startMs = NOW - WORKING_PHRASE_SHOW_AFTER_MS;
    await element.updateComplete;
    const first = element.textContent;
    expect(vi.getTimerCount()).toBe(1);

    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(WORKING_PHRASE_ROTATE_EVERY_MS);
    expect(element.textContent).toBe(first);
    expect(vi.getTimerCount()).toBe(0);

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await element.updateComplete;
    expect(element.textContent).not.toBe(first);
    expect(vi.getTimerCount()).toBe(1);

    element.remove();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, 1, 6])(
    "walks all %i authored phrases without translation and restores the default vocabulary",
    async (length) => {
      const defaultPhrase = await textAt(element, WORKING_PHRASE_SHOW_AFTER_MS);
      const phrases = Array.from({ length }, (_, index) => `Phrase ${index + 1}`);
      element.phrases = phrases;
      const displayed = new Set<string>();
      for (let bucket = 0; bucket < Math.max(1, length); bucket++) {
        displayed.add(
          await textAt(
            element,
            WORKING_PHRASE_SHOW_AFTER_MS + bucket * WORKING_PHRASE_ROTATE_EVERY_MS,
          ),
        );
      }
      expect(displayed).toEqual(new Set(length ? phrases.map((phrase) => `· ${phrase}…`) : [""]));
      if (length === 1) {
        for (const bucket of [1, 100_000]) {
          expect(
            await textAt(
              element,
              WORKING_PHRASE_SHOW_AFTER_MS + bucket * WORKING_PHRASE_ROTATE_EVERY_MS,
            ),
          ).toBe("· Phrase 1…");
        }
      }
      element.phrases = undefined;
      expect(await textAt(element, WORKING_PHRASE_SHOW_AFTER_MS)).toBe(defaultPhrase);
    },
  );
});
