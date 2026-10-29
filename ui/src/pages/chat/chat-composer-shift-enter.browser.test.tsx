import { render } from "lit";
import { afterEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createComposerContainer,
  createComposerProps,
  resetComposerFixture,
} from "./chat-composer.test-support.ts";
import { renderChatComposer } from "./components/chat-composer-render.test-support.ts";

afterEach(() => resetComposerFixture());

it("inserts a newline rather than running an open slash suggestion on Shift+Enter", async () => {
  const container = createComposerContainer();
  let draftValue = "";
  const props = createComposerProps({
    getDraft: () => draftValue,
    onDraftChange: (draft) => {
      draftValue = draft;
      props.draft = draft;
      render(renderChatComposer(props), container);
    },
    onRequestUpdate: () => render(renderChatComposer(props), container),
  });
  render(renderChatComposer(props), container);
  document.body.append(container);
  const input = page.elementLocator(container.querySelector("textarea")!);
  await input.click();
  await userEvent.type(input, "/help");
  await waitForSolid(() => {
    expect(container.querySelector("textarea")!.value).toBe("/help");
    expect(container.querySelectorAll(".slash-menu-item").length).toBeGreaterThan(0);
  });
  await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
  flush();
  expect(props.onSend).not.toHaveBeenCalled();
  expect(container.querySelector("textarea")!.value).toBe("/help\n");
});
