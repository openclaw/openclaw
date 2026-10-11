/* @vitest-environment jsdom */
import { nothing, render } from "lit";
import { afterEach, beforeEach, expect, it, onTestFinished } from "vitest";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { renderChatThread } from "./chat-thread.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

it("keeps the focused work summary toggle through expansion updates", async () => {
  const props = {
    ...threadProps("pane-work-focus", "agent:main:dashboard:work-focus", [
      { role: "user", content: "Inspect the workspace", timestamp: 1_000 },
      {
        role: "toolResult",
        toolCallId: "work-focus-read",
        toolName: "read",
        content: "Read complete",
        timestamp: 2_000,
      },
      { role: "assistant", content: "Workspace checked", timestamp: 3_000 },
    ]),
    showToolCalls: true,
  };
  const transcript = createTestTranscript();
  const container = document.body.appendChild(document.createElement("div"));
  const rerender = () => {
    render(renderChatThread(props, transcript), container);
    transcript.hostUpdated();
  };
  props.onRequestUpdate = rerender;
  onTestFinished(() => {
    render(nothing, container);
    transcript.hostDisconnected();
  });
  rerender();
  const toggleSelector = ".chat-group--work .chat-work-group > button";
  transcript.hostConnected();
  transcript.hostUpdated();
  await waitForSolid(() => expect(container.querySelector(toggleSelector)).not.toBeNull());
  const toggle = container.querySelector<HTMLButtonElement>(toggleSelector)!;
  toggle.focus();
  for (const expanded of [true, false]) {
    toggle.click();
    await waitForSolid(() =>
      expect(container.querySelector(toggleSelector)?.getAttribute("aria-expanded")).toBe(
        String(expanded),
      ),
    );
    expect(container.querySelector(toggleSelector)).toBe(toggle);
    expect(document.activeElement).toBe(toggle);
  }
});
