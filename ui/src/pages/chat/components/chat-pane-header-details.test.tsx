/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import type { ChatDetailsProps } from "./chat-details-types.ts";
import { mountChatPaneHeader } from "./chat-pane-header.test-support.ts";

it("retains closed Details through header updates without reading transcript facts", () => {
  let reads = 0;
  const chat = (sessionKey: string): ChatDetailsProps => ({
    sessionKey,
    currentAgentId: "main",
    selectedSession: { key: sessionKey, kind: "direct" },
    get messages() {
      reads += 1;
      return [];
    },
    gatewayScope: {},
  });
  const setRef = vi.fn();
  const elements = { frame: document.createElement("div") };
  const detailsControl = {
    chat: chat("agent:main:first"),
    elements,
    mobile: false,
    nativePresentation: "desktop" as const,
    presentation: true,
    setRef,
  };
  const mounted = mountChatPaneHeader([], { detailsControl });
  const selector = ".chat-pane__header-trailing > .chat-pane__actions > openclaw-chat-details";
  const details = mounted.container.querySelector<HTMLElement>(selector);
  expect(details).not.toBeNull();
  expect(reads).toBe(0);
  expect(setRef).toHaveBeenCalledWith({
    open: expect.any(Function),
    close: expect.any(Function),
  });
  expect(elements.frame.querySelector(".chat-details")).not.toBeNull();

  mounted.update({
    detailsControl: { ...detailsControl, chat: chat("agent:main:second") },
  });
  expect(reads).toBe(0);
  expect(mounted.container.querySelector(selector)).toBe(details);
  mounted.update({ detailsControl: { ...detailsControl, mobile: true } });
  expect(mounted.container.querySelector(selector)).toBe(details);
  expect(details?.hasAttribute("mobile")).toBe(true);

  mounted.update({ detailsControl: undefined });
  expect(mounted.container.querySelector(selector)).toBeNull();
  expect(setRef).toHaveBeenLastCalledWith(undefined);
  expect(elements.frame.querySelector(".chat-details")).toBeNull();
});
