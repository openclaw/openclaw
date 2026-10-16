import { afterEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  renderComposer as renderNewSession,
  resetComposerTestFixtures,
} from "../new-session/composer.test-support.ts";
import { renderComposerFixture, resetComposerFixture } from "./chat-composer.test-support.ts";
import { SessionRailComposer } from "./components/chat-session-rail-composer.tsx";

afterEach(async () => {
  resetComposerTestFixtures();
  await resetComposerFixture();
});

it.each(["chat", "new-session", "side-chat"])(
  "preserves native mobile newline, selection replacement, and explicit submission in %s",
  async (surface) => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("iPhone");
    const submit = vi.fn();
    const draft = "first second";
    const container =
      surface === "chat"
        ? renderComposerFixture({ draft, onSend: submit }).container
        : surface === "new-session"
          ? renderNewSession({ message: draft, onSubmit: submit }).container
          : mountSolid(() => (
              <SessionRailComposer
                companion={{ draft, turns: [], loading: false }}
                connected={true}
                pending={false}
                sendShortcut="enter"
                attachmentProps={{}}
                submit={submit}
              />
            )).container;
    document.body.append(container);
    const textarea = container.querySelector("textarea")!;
    textarea.focus();
    textarea.setSelectionRange(5, 6);
    await userEvent.keyboard("{Enter}");
    expect(textarea.value).toBe("first\nsecond");
    expect(textarea.selectionStart).toBe(6);
    expect(textarea.selectionEnd).toBe(6);
    expect(submit).not.toHaveBeenCalled();
    const send = container.querySelector<HTMLButtonElement>(
      surface === "new-session" ? ".new-session-page__start-submit" : ".chat-send-btn",
    );
    expect(send?.disabled).toBe(false);
    send!.click();
    expect(submit).toHaveBeenCalledOnce();
  },
);
