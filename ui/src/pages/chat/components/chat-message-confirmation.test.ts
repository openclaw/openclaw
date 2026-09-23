import { render } from "lit";
import { afterEach, expect, it } from "vitest";
import {
  dismissConfirmedActionPopovers,
  isConfirmedActionPopoverFocused,
  renderRewindButton,
} from "./chat-message-confirmation.ts";

afterEach(() => {
  dismissConfirmedActionPopovers(document.body);
  document.body.replaceChildren();
});

it("tracks focused confirmation ownership through dismissal of another pane", () => {
  const first = document.createElement("section");
  const second = document.createElement("section");
  document.body.append(first, second);
  render(
    renderRewindButton(() => {}),
    first,
  );
  render(
    renderRewindButton(() => {}),
    second,
  );
  first.querySelector<HTMLButtonElement>("button")!.click();
  expect(isConfirmedActionPopoverFocused(first)).toBe(true);
  expect(isConfirmedActionPopoverFocused(second)).toBe(false);
  dismissConfirmedActionPopovers(second);
  expect(isConfirmedActionPopoverFocused(first)).toBe(true);
  dismissConfirmedActionPopovers(first);
  expect(isConfirmedActionPopoverFocused(first)).toBe(false);
  expect(document.querySelector(".chat-confirm-popover")).toBeNull();
});
