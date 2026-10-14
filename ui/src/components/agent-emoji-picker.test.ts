import { expect, it, vi } from "vitest";
import "./agent-emoji-picker.ts";

it("filters emoji choices, selects their value, and remounts after removal", async () => {
  const picker = document.createElement("openclaw-agent-emoji-picker");
  const onSelect = vi.fn();
  picker.onSelect = onSelect;
  document.body.append(picker);
  try {
    await picker.updateComplete;
    const search = picker.querySelector<HTMLInputElement>(".agent-emoji-picker__search")!;
    search.value = "rocket";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await picker.updateComplete;
    const choice = picker.querySelector<HTMLButtonElement>(".agent-emoji-picker__choice")!;
    expect(choice.textContent).toBe("🚀");
    choice.click();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("🚀");
    picker.remove();
    await Promise.resolve();
    document.body.append(picker);
    await picker.updateComplete;
    expect(picker.querySelectorAll(".agent-emoji-picker__choice")).toHaveLength(24);
  } finally {
    picker.remove();
  }
});
