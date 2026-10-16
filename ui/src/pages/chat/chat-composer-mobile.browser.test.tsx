import { expect, it, onTestFinished, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { SessionRailComposer } from "./components/chat-session-rail-composer.tsx";

it.each(["enter", "modifier-enter"] as const)(
  "keeps mobile Side chat multiline and button-submitted with preference %s",
  async (sendShortcut) => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("iPhone");
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    const submit = vi.fn();
    const { container } = mountSolid(() => (
      <SessionRailComposer
        companion={{ draft: "first second", turns: [], loading: false }}
        connected={true}
        pending={false}
        sendShortcut={sendShortcut}
        attachmentProps={{}}
        submit={submit}
      />
    ));
    document.body.append(container);
    const textarea = container.querySelector("textarea")!;
    textarea.focus();
    textarea.setSelectionRange(5, 6);
    await userEvent.keyboard("{Enter}");
    expect(textarea.value).toBe("first\nsecond");
    expect(textarea.selectionStart).toBe(6);
    expect(textarea.selectionEnd).toBe(6);
    await userEvent.keyboard("{Control>}{Enter}{/Control}{Meta>}{Enter}{/Meta}");
    expect(submit).not.toHaveBeenCalled();
    expect(textarea.getAttribute("enterkeyhint")).toBe("enter");
    expect(textarea.hasAttribute("aria-keyshortcuts")).toBe(false);
    container.querySelector<HTMLButtonElement>("button[type=submit]")!.click();
    expect(submit).toHaveBeenCalledOnce();
  },
);
