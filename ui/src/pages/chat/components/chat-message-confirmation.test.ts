import { createComponent } from "solid-js";
import { afterEach, expect, it } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import {
  dismissConfirmedActionPopovers,
  isConfirmedActionPopoverFocused,
  RewindButton,
} from "./chat-message-confirmation-view.tsx";

afterEach(() => {
  dismissConfirmedActionPopovers(document.body);
  document.body.replaceChildren();
});

it("tracks focused confirmation ownership through dismissal of another pane", () => {
  const first = document.createElement("section");
  const second = document.createElement("section");
  document.body.append(first, second);
  mountSolid(() => createComponent(RewindButton, { onRewind: () => {} }), { container: first });
  mountSolid(() => createComponent(RewindButton, { onRewind: () => {} }), { container: second });
  first.querySelector<HTMLButtonElement>("button")!.click();
  expect(isConfirmedActionPopoverFocused(first)).toBe(true);
  expect(isConfirmedActionPopoverFocused(second)).toBe(false);
  dismissConfirmedActionPopovers(second);
  expect(isConfirmedActionPopoverFocused(first)).toBe(true);
  dismissConfirmedActionPopovers(first);
  expect(isConfirmedActionPopoverFocused(first)).toBe(false);
  expect(document.querySelector(".chat-confirm-popover")).toBeNull();
});
