import readline from "node:readline/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isYes, setVerbose, setYes } from "../globals.js";
import { promptYesNo } from "./prompt.js";

const readlineState = vi.hoisted(() => {
  const question = vi.fn(async () => "");
  const close = vi.fn();
  const createInterface = vi.fn(() => ({ question, close }));
  return { question, close, createInterface };
});

vi.mock("node:readline/promises", () => ({
  default: { createInterface: readlineState.createInterface },
}));

beforeEach(() => {
  setYes(false);
  setVerbose(false);
  readlineState.question.mockReset();
  readlineState.question.mockResolvedValue("");
  readlineState.close.mockClear();
  readlineState.createInterface.mockClear();
});

describe("promptYesNo", () => {
  it("returns true when global --yes is set", async () => {
    setYes(true);
    setVerbose(false);
    const result = await promptYesNo("Continue?");
    expect(result).toBe(true);
    expect(isYes()).toBe(true);
  });

  it("asks the question and respects default", async () => {
    setYes(false);
    setVerbose(false);
    expect(readline).toBeTruthy();
    readlineState.question.mockResolvedValueOnce("");
    const resultDefaultYes = await promptYesNo("Continue?", true);
    expect(resultDefaultYes).toBe(true);

    readlineState.question.mockResolvedValueOnce("n");
    const resultNo = await promptYesNo("Continue?", true);
    expect(resultNo).toBe(false);

    readlineState.question.mockResolvedValueOnce("y");
    const resultYes = await promptYesNo("Continue?", false);
    expect(resultYes).toBe(true);
  });
});
