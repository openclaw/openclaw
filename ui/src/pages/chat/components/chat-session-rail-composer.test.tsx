/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { SessionRailComposer } from "./chat-session-rail-composer.tsx";

afterEach(() => vi.restoreAllMocks());

it.each(["enter", "modifier-enter"] as const)(
  "uses the Ask button on mobile with preference %s",
  (sendShortcut) => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("iPhone");
    const submit = vi.fn();
    const { container } = mountSolid(() => (
      <SessionRailComposer
        companion={{ draft: "A question", turns: [], loading: false }}
        connected={true}
        pending={false}
        sendShortcut={sendShortcut}
        attachmentProps={{}}
        submit={submit}
      />
    ));
    const textarea = container.querySelector("textarea")!;
    for (const modifiers of [{}, { ctrlKey: true }, { metaKey: true }]) {
      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
        ...modifiers,
      });
      textarea.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(submit).not.toHaveBeenCalled();
    }
    expect(textarea.getAttribute("enterkeyhint")).toBe("enter");
    expect(textarea.hasAttribute("aria-keyshortcuts")).toBe(false);
    container.querySelector<HTMLButtonElement>("button[type=submit]")!.click();
    expect(submit).toHaveBeenCalledOnce();
  },
);
