import { describe, expect, it, vi } from "vitest";
import { createReplyDispatcher } from "./reply-dispatcher.js";

async function drain(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createReplyDispatcher delivery sanitizer", () => {
  it("sanitizes assistant block replies before custom delivery", async () => {
    const deliver = vi.fn(async () => undefined);
    const dispatcher = createReplyDispatcher({ deliver });

    expect(dispatcher.sendBlockReply({ text: "<think>hidden</think>Visible" })).toBe(true);
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(deliver).toHaveBeenCalledWith({ text: "Visible" }, { kind: "block" });
  });

  it("drops reasoning-only final replies before custom delivery", async () => {
    const deliver = vi.fn(async () => undefined);
    const dispatcher = createReplyDispatcher({ deliver });

    expect(dispatcher.sendFinalReply({ text: "Reasoning:\n_private step_" })).toBe(false);
    dispatcher.markComplete();
    await drain();

    expect(deliver).not.toHaveBeenCalled();
  });

  it("does not sanitize tool result payloads", async () => {
    const deliver = vi.fn(async () => undefined);
    const dispatcher = createReplyDispatcher({ deliver });

    expect(dispatcher.sendToolResult({ text: "Reasoning:\nliteral tool output" })).toBe(true);
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(deliver).toHaveBeenCalledWith(
      { text: "Reasoning:\nliteral tool output" },
      { kind: "tool" },
    );
  });
});
