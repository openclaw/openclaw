import { createSignal, flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { restorePropertyDescriptor } from "../../test-helpers/property-descriptor.ts";
import { ConnectCommand } from "./connect-command.tsx";

const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const writeText = vi.fn<(text: string) => Promise<void>>();
const command = "openclaw connect https://gateway.example/j/synthetic-code --service";

beforeEach(() => {
  vi.useFakeTimers();
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});

afterEach(() => {
  cleanupSolid();
  vi.useRealTimers();
  restorePropertyDescriptor(navigator, "clipboard", clipboardDescriptor);
});

describe("connection command", () => {
  it.each(["wrapper click", "Enter", "Space", "copy icon"] as const)(
    "copies once through %s",
    async (action) => {
      const view = mountSolid(() => <ConnectCommand command={command} />);
      const surface = view.container.querySelector<HTMLElement>(".login-gate__command")!;
      if (action === "wrapper click") {
        surface.click();
      } else if (action === "copy icon") {
        view.container.querySelector<HTMLElement>(".chat-copy-btn__icon")!.click();
      } else {
        const event = new KeyboardEvent("keydown", {
          key: action === "Space" ? " " : action,
          bubbles: true,
          cancelable: true,
        });
        surface.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(writeText.mock.calls).toEqual([[command]]);
    },
  );

  it("copies the displayed command after it changes", async () => {
    const [value, setValue] = createSignal(command);
    const view = mountSolid(() => <ConnectCommand command={value()} />);
    const next = "openclaw connect https://gateway.example/j/refreshed-code --service";
    setValue(next);
    flush();
    expect(view.container.querySelector("code")?.textContent).toBe(next);
    const surface = view.container.querySelector<HTMLElement>(".login-gate__command")!;
    expect(surface.getAttribute("aria-label")).toContain(next);
    surface.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(writeText.mock.calls).toEqual([[next]]);
  });

  it("leaves unrelated keys to the enclosing dialog", () => {
    const view = mountSolid(() => <ConnectCommand command={command} />);
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    view.container.querySelector<HTMLElement>(".login-gate__command")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });
});
