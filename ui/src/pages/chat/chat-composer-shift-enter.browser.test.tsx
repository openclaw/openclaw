import { afterEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { renderComposerFixture, resetComposerFixture } from "./chat-composer.test-support.ts";

afterEach(() => resetComposerFixture());

it("inserts a newline rather than running an open slash suggestion on Shift+Enter", async () => {
  const { container, props } = renderComposerFixture();
  document.body.append(container);
  const input = page.elementLocator(container.querySelector("textarea")!);
  await input.click();
  await userEvent.type(input, "/help");
  await waitForSolid(() =>
    expect(container.querySelectorAll(".slash-menu-item").length).toBeGreaterThan(0),
  );
  await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
  flush();
  expect(props.onSend).not.toHaveBeenCalled();
  expect(container.querySelector("textarea")!.value).toBe("/help\n");
});
