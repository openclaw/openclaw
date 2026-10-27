/* @vitest-environment jsdom */
import { expect, it } from "vitest";
import type { ChatDetailsProps } from "./chat-details-types.ts";
import { mountChatPaneHeader } from "./chat-pane-header.test-support.ts";

it("keeps transcript facts lazy while Details are closed", () => {
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
  const detailsControl = {
    chat: chat("agent:main:first"),
    mobile: false,
    nativePresentation: "desktop" as const,
    presentation: true,
    setRef: () => {},
  };
  const containers: HTMLElement[] = [];
  const view = mountChatPaneHeader(containers, { detailsControl });
  try {
    expect(view.container.querySelector("openclaw-chat-details")).not.toBeNull();
    expect(reads).toBe(0);
    view.update({ detailsControl: { ...detailsControl, chat: chat("agent:main:second") } });
    expect(reads).toBe(0);
  } finally {
    view.unmount();
    containers.forEach((container) => container.remove());
  }
});
