import { describe, expect, it, vi } from "vitest";
import { listen } from "./listener.ts";

describe("native listener lifetime", () => {
  it("retains capture ordering and removes only its own listener", () => {
    const parent = document.createElement("div");
    const child = parent.appendChild(document.createElement("button"));
    const calls: string[] = [];
    const sibling = vi.fn(() => calls.push("sibling"));
    parent.addEventListener("click", sibling);
    const stop = listen(parent, "click", () => calls.push("capture"), { capture: true });
    child.addEventListener("click", () => calls.push("target"));
    child.click();
    expect(calls).toEqual(["capture", "target", "sibling"]);
    calls.length = 0;
    stop();
    stop();
    child.click();
    expect(calls).toEqual(["target", "sibling"]);
  });
});
