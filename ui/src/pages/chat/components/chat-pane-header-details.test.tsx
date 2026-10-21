/* @vitest-environment jsdom */

import { expect, it, onTestFinished, vi } from "vitest";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { mountChatPaneHeader } from "./chat-pane-header.test-support.ts";

it("retains Details in the header actions while pane props change", () => {
  const setRef = vi.fn();
  const elements = { frame: document.createElement("div") };
  const detailsControl = { chat: undefined, elements, mobile: false, presentation: true, setRef };
  const mounted = mountChatPaneHeader([], { detailsControl });
  onTestFinished(mounted.unmount);
  const selector = ".chat-pane__header-trailing > .chat-pane__actions > openclaw-chat-details";
  const details = mounted.container.querySelector<HTMLElement>(selector);
  expect(details).not.toBeNull();
  expect(setRef).toHaveBeenCalledWith({ open: expect.any(Function) });
  expect(elements.frame.querySelector(".chat-details")).not.toBeNull();

  mounted.update({ detailsControl: { ...detailsControl, mobile: true } });
  expect(mounted.container.querySelector(selector)).toBe(details);
  flush();
  expect(details?.hasAttribute("mobile")).toBe(true);

  mounted.update({ detailsControl: undefined });
  expect(mounted.container.querySelector(selector)).toBeNull();
  expect(setRef).toHaveBeenLastCalledWith(undefined);
  expect(elements.frame.querySelector(".chat-details")).toBeNull();
});
