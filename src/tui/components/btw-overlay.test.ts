import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { normalizeTestText } from "../../../test/helpers/normalize-text.js";
import { BtwOverlay } from "./btw-overlay.js";

const make = (copy = vi.fn(async () => true), isError = false) => {
  const close = vi.fn();
  const requestRender = vi.fn();
  const overlay = new BtwOverlay(
    { question: "2+2?", text: "It is 4.", isError },
    { close, copy, requestRender },
  );
  overlay.focused = true;
  return { overlay, close, copy, requestRender };
};
const strip = (line: string) => normalizeTestText(line.split(CURSOR_MARKER).join("")).trim();
const text = (overlay: BtwOverlay) => overlay.render(60).map(strip);
const cursorRow = (overlay: BtwOverlay) =>
  strip(overlay.render(60).find((line) => line.includes(CURSOR_MARKER)) ?? "");

describe("BtwOverlay", () => {
  it("leads with 'Your btw answer:' and puts the cursor on it when opened", () => {
    const { overlay } = make();
    expect(cursorRow(overlay)).toBe("Your btw answer: It is 4.");
    expect(text(overlay).filter(Boolean)).toEqual([
      "Your btw answer: It is 4.",
      "Question: 2+2?",
      "Esc or Enter: close. c: copy answer.",
    ]);
  });

  it("windows an answer taller than the terminal and scrolls with the arrow and page keys", () => {
    const answer = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
    const requestRender = vi.fn();
    const overlay = new BtwOverlay(
      { question: "long?", text: answer },
      { close: vi.fn(), copy: vi.fn(), requestRender, rows: () => 12 },
    );
    overlay.focused = true;
    const first = text(overlay);
    expect(first.length).toBeLessThanOrEqual(12);
    expect(first[0]).toBe("Your btw answer: line 1");
    expect(first).toContain("Question: long?");
    overlay.handleInput("\x1b[B");
    expect(text(overlay)[0]).toBe("line 2");
    overlay.handleInput("\x1b[6~");
    expect(text(overlay).some((line) => line.startsWith("Lines "))).toBe(true);
    for (let i = 0; i < 10; i++) {
      overlay.handleInput("\x1b[6~");
    }
    const last = text(overlay);
    expect(last).toContain("line 40");
    expect(last).toContain("Question: long?");
    overlay.handleInput("\x1b[5~");
    expect(text(overlay)).not.toContain("line 40");
    expect(requestRender).toHaveBeenCalled();
  });

  it("labels an error answer", () => {
    const { overlay } = make(undefined, true);
    expect(cursorRow(overlay)).toBe("btw error: It is 4.");
  });

  it("closes on Esc and Enter", () => {
    const { overlay, close } = make();
    overlay.handleInput("\x1b");
    overlay.handleInput("\r");
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("copies on c, repaints, and moves the cursor to 'Copied to clipboard.'", async () => {
    const { overlay, copy, requestRender } = make();
    overlay.handleInput("c");
    await vi.waitFor(() => expect(requestRender).toHaveBeenCalledTimes(1));
    expect(copy).toHaveBeenCalledExactlyOnceWith("It is 4.");
    expect(cursorRow(overlay)).toBe("Copied to clipboard.");
  });

  it("returns the cursor to the answer when scrolling after a copy", async () => {
    const answer = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
    const requestRender = vi.fn();
    const overlay = new BtwOverlay(
      { question: "long?", text: answer },
      { close: vi.fn(), copy: vi.fn(async () => true), requestRender, rows: () => 12 },
    );
    overlay.focused = true;
    overlay.handleInput("c");
    await vi.waitFor(() => expect(cursorRow(overlay)).toBe("Copied to clipboard."));
    overlay.handleInput("\x1b[B");
    expect(cursorRow(overlay)).toBe("line 2");
  });

  it("reports a failed copy at the cursor", async () => {
    const { overlay, requestRender } = make(vi.fn(async () => false));
    overlay.handleInput("c");
    await vi.waitFor(() => expect(requestRender).toHaveBeenCalled());
    expect(cursorRow(overlay)).toBe("Copy failed.");
  });
});
