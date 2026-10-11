import { assert, expect, it } from "vitest";
import { AgentEmojiPicker } from "./agent-emoji-picker.ts";

it("settles a pending popover update after removal and restores its trigger on reconnect", async () => {
  const container = document.createElement("section");
  // The shared fixture adds this method, but native detached Element roots do not have it.
  Object.defineProperty(container, "getElementById", { value: undefined });
  const picker = new AgentEmojiPicker();
  let removeAfterRender = true;
  picker.addController({
    hostUpdated() {
      if (removeAfterRender) {
        container.remove();
      }
    },
  });
  container.append(picker);
  document.body.append(container);

  try {
    await picker.updateComplete;
    const popover = picker.querySelector("wa-popover");
    const trigger = picker.querySelector("button");
    assert(popover);
    assert(trigger);
    expect(picker.isConnected).toBe(false);
    await expect(popover.updateComplete).resolves.toBe(true);

    removeAfterRender = false;
    document.body.append(container);
    await picker.updateComplete;
    await popover.updateComplete;
    expect(popover.anchor).toBe(trigger);
    expect(popover.for).toBe(trigger.id);
  } finally {
    container.remove();
  }
});
