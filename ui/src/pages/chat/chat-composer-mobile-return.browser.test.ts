import { nothing, render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import {
  renderComposer as renderNewSessionComposer,
  resetComposerTestFixtures,
} from "../new-session/composer.test-support.ts";
import {
  findPrimaryButton,
  renderComposerFixture,
  resetComposerFixture,
} from "./chat-composer.test-support.ts";

let container: HTMLElement | undefined;

afterEach(async () => {
  if (container) {
    render(nothing, container);
    container.remove();
    container = undefined;
  }
  resetComposerTestFixtures();
  await resetComposerFixture();
});

it.each(["chat", "new-session"] as const)(
  "inserts a native mobile newline in %s without submitting",
  async (surface) => {
    // Exercise native browser editing through the real composer with a mobile identity.
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (iPhone)");
    const submit = vi.fn();
    const input = vi.fn();
    const fixture =
      surface === "chat"
        ? renderComposerFixture({
            draft: "First lineSecond line",
            onSend: submit,
            onDraftChange: input,
          })
        : renderNewSessionComposer({
            message: "First lineSecond line",
            onSubmit: submit,
            onInput: input,
          });
    container = fixture.container;
    document.body.append(container);
    const textarea = container.querySelector("textarea");
    if (!textarea) {
      throw new Error("Expected composer textarea");
    }
    textarea.focus();
    textarea.setSelectionRange(10, 10);
    await userEvent.keyboard("{Enter}");
    expect(textarea.value).toBe("First line\nSecond line");
    expect(input.mock.calls.at(-1)?.[0]).toBe("First line\nSecond line");
    expect(submit).not.toHaveBeenCalled();
    const send =
      surface === "chat"
        ? findPrimaryButton(container)
        : container.querySelector<HTMLButtonElement>(".new-session-page__start-submit");
    if (!send) {
      throw new Error("Expected explicit send button");
    }
    await userEvent.click(send);
    expect(submit).toHaveBeenCalledOnce();
  },
);
