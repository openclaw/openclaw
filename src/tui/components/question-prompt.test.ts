import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { QuestionPrompt } from "./question-prompt.js";

const makePrompt = (screenReader: boolean) =>
  new QuestionPrompt(
    {
      id: "request-1",
      agentId: "main",
      sessionKey: "agent:main:main",
      createdAtMs: 1_000,
      expiresAtMs: Date.now() + 60_000,
      status: "pending",
      questions: [
        {
          questionId: "target",
          header: "Target",
          question: "→ Where should the sample run?",
          options: [
            { label: "Staging" },
            { label: "Production", description: "→ Use this for production" },
          ],
        },
      ],
    },
    { onSubmit() {}, onSkip() {}, onCollapse() {}, requestRender() {} },
    screenReader,
  );
const strip = (lines: string[]) =>
  lines.map((line) => line.split(CURSOR_MARKER).join("").trimEnd());
const cursorLine = (lines: string[]) =>
  lines.find((line) => line.includes(CURSOR_MARKER))?.trimEnd();

describe("QuestionPrompt screen reader cursor", () => {
  it("parks the cursor on the selected option, not on arrow-led description text", () => {
    const prompt = makePrompt(true);
    prompt.focused = true;
    const first = prompt.render(60);
    prompt.handleInput("\x1b[B");
    const second = prompt.render(60);
    expect(cursorLine(first)).toBe(`${CURSOR_MARKER}  1. Staging`);
    expect(cursorLine(second)).toBe(`${CURSOR_MARKER}  2. Production`);
    expect(strip(second)).toEqual(strip(first));
  });

  it("keeps the visual selection arrow and no cursor outside screen reader mode", () => {
    const prompt = makePrompt(false);
    prompt.focused = true;
    const lines = prompt.render(60);
    expect(cursorLine(lines)).toBeUndefined();
    expect(lines.some((line) => line.includes("› 1. Staging"))).toBe(true);
  });
});
