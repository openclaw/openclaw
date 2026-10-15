/* @vitest-environment jsdom */

import { expect, it, onTestFinished, vi } from "vitest";
import type { ChatDetails } from "./chat-details.tsx";
import { mountChatPaneHeader } from "./chat-pane-header.test-support.ts";
import "./chat-details.tsx";

it("retains Details directly in the header while pane props change", () => {
  const setRef = vi.fn();
  const detailsControl = { chat: undefined, mobile: false, presentation: true, setRef };
  const mounted = mountChatPaneHeader([], { detailsControl });
  onTestFinished(mounted.unmount);
  const selector = ".chat-pane__header-trailing > openclaw-chat-details";
  const details = mounted.container.querySelector<ChatDetails>(selector);
  expect(details).not.toBeNull();
  expect(setRef).toHaveBeenCalledWith(details);

  mounted.update({ detailsControl: { ...detailsControl, mobile: true } });
  expect(mounted.container.querySelector(selector)).toBe(details);
  expect(details?.mobile).toBe(true);

  mounted.update({ detailsControl: undefined });
  expect(mounted.container.querySelector(selector)).toBeNull();
  expect(setRef).toHaveBeenLastCalledWith(undefined);
});
