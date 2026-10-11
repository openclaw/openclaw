import { cleanup, render } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { KEYBOARD_SHORTCUT_COMBOS } from "../../lib/keyboard-shortcut-contract.ts";
import { Kbd, KeyboardShortcut, ShortcutText } from "./kbd.tsx";

afterEach(cleanup);

describe("Solid keyboard hints", () => {
  it.each([
    [KEYBOARD_SHORTCUT_COMBOS.browserPanel, true, false, ["⌘⌥⇧U"], 3],
    [KEYBOARD_SHORTCUT_COMBOS.browserPanel, false, false, ["Ctrl+Alt+Shift+U"], 0],
    [KEYBOARD_SHORTCUT_COMBOS.newline, true, true, ["⇧", "⏎"], 2],
  ] as const)(
    "renders platform key labels and accessible symbols",
    (combo, applePlatform, separateKeys, labels, count) => {
      const view = render(() => (
        <KeyboardShortcut combo={combo} applePlatform={applePlatform} separateKeys={separateKeys} />
      ));
      expect(Array.from(view.container.querySelectorAll("kbd"), (key) => key.textContent)).toEqual(
        labels,
      );
      expect(view.container.querySelectorAll("svg")).toHaveLength(count);
      for (const icon of view.container.querySelectorAll("svg")) {
        expect(icon.querySelector("path")?.namespaceURI).toBe("http://www.w3.org/2000/svg");
        expect(icon.closest('[aria-hidden="true"]')).not.toBeNull();
      }
      for (const symbol of view.container.querySelectorAll(".kbd__symbol")) {
        expect(symbol.closest('[aria-hidden="true"]')).toBeNull();
      }
    },
  );

  it("preserves literal labels and updates caller visibility without replacing the keycap", () => {
    const [hidden, setHidden] = createSignal(true);
    const view = render(() => (
      <Kbd keys="constructor" slot="details" ariaHidden hidden={hidden()} />
    ));
    const key = view.container.querySelector("kbd")!;
    expect(key.textContent).toBe("constructor");
    expect(key.slot).toBe("details");
    expect(key.hidden).toBe(true);
    expect(key.getAttribute("aria-hidden")).toBe("true");
    setHidden(false);
    flush();
    expect(view.container.querySelector("kbd")).toBe(key);
    expect(key.hidden).toBe(false);
  });

  it("renders a distinct shortcut at each translated placeholder", () => {
    const view = render(() => (
      <ShortcutText text="{shortcut} first; {shortcut} again" shortcut={() => <Kbd keys="/" />} />
    ));
    expect(view.container.textContent).toBe("/ first; / again");
    expect(view.container.querySelectorAll("kbd")).toHaveLength(2);
  });
});
