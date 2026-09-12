import { describe, expect, it } from "vitest";
import type { ReplyPayload } from "../auto-reply/types.js";
import { createLoginChoicePrompt } from "./command-choice.js";

const prompt = {
  message: "Choose model access",
  options: [
    { value: "all", label: "Show all Sample models" },
    { value: "keep", label: "Keep current restrictions" },
  ],
};

function command(reply: ReplyPayload, index: number): string {
  const block = reply.presentation?.blocks.find((entry) => entry.type === "buttons");
  const action = block?.type === "buttons" ? block.buttons[index]?.action : undefined;
  if (action?.type !== "command") {
    throw new Error("Expected a typed command choice");
  }
  return action.command;
}

describe("login command choices", () => {
  it.each([
    [0, "all"],
    [1, "keep"],
  ] as const)("returns button %s as %s once", (index, value) => {
    const choice = createLoginChoicePrompt(prompt, new AbortController().signal, "sample");
    const answer = command(choice.reply, index);
    expect(choice.reply.text).toContain(answer);
    expect(choice.answer(answer)).toEqual({ value });
    expect(choice.answer(answer)).toBeUndefined();
  });

  it("rejects an older login's button while the new login remains usable", () => {
    const old = createLoginChoicePrompt(prompt, new AbortController().signal, "sample");
    const next = createLoginChoicePrompt(prompt, new AbortController().signal, "sample");
    expect(next.answer(command(old.reply, 0))).toBeUndefined();
    expect(next.answer(command(next.reply, 1))).toEqual({ value: "keep" });
  });

  it("rejects a delivered button after cancellation", () => {
    const controller = new AbortController();
    const choice = createLoginChoicePrompt(prompt, controller.signal, "sample");
    controller.abort(new Error("Login replaced"));
    expect(choice.answer(command(choice.reply, 0))).toBeUndefined();
  });
});
