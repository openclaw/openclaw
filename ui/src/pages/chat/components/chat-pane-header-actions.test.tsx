/* @vitest-environment jsdom */

import { expect, it, onTestFinished } from "vitest";
import { mountChatPaneHeader } from "./chat-pane-header.test-support.ts";

it("shows Create Claw as a share action beside the other header actions", () => {
  const mounted = mountChatPaneHeader([], { onCreateClaw: () => undefined });
  onTestFinished(mounted.unmount);
  const button = mounted.container.querySelector<HTMLButtonElement>(
    '.chat-pane__actions button[aria-label="Create Claw"]',
  );

  expect(button?.querySelector("svg")).not.toBeNull();
});
