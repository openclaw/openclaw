/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, onTestFinished } from "vitest";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { saveChatSessionScrollPosition } from "../scroll.ts";
import { createChatThreadHarness } from "./chat-message-native.test-support.tsx";
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
  saveChatSessionScrollPosition(props.paneId, props.sessionKey, {
    scrollTop: 0,
    anchorToEnd: false,
  });
  const transcript = createTestTranscript(props.paneId);
  const container = document.body.appendChild(document.createElement("div"));
  const thread = createChatThreadHarness(container, transcript);
  const rerender = () => {
    thread.render(props);
    transcript.update();
  };
  onTestFinished(() => {
    thread.unmount();
    transcript.dispose();
  });
  rerender();
  const toggleSelector = ".chat-group--work .chat-work-group > button";
  transcript.start();
  transcript.update();
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

it("shows every run's reply below completed work when completions arrive without user input", async () => {
  const run = (runId: string) => ({ __openclaw: { runId } });
  const props = {
    ...threadProps("pane-work-runs", "agent:main:dashboard:work-runs", [
      { role: "user", content: "Start two subagents", timestamp: 1_000 },
      { role: "assistant", content: "Spawning both.", timestamp: 1_500, ...run("run-user") },
      {
        role: "toolResult",
        toolCallId: "work-runs-spawn",
        toolName: "sessions_spawn",
        content: "accepted",
        timestamp: 2_000,
        ...run("run-user"),
      },
      { role: "assistant", content: "Both started.", timestamp: 3_000, ...run("run-user") },
      { role: "assistant", content: "Child A finished.", timestamp: 4_000, ...run("announce:a") },
      { role: "assistant", content: "Child B finished.", timestamp: 5_000, ...run("announce:b") },
      { role: "assistant", content: "All settled.", timestamp: 6_000, ...run("announce:settle") },
    ]),
    showToolCalls: true,
  };
  const transcript = createTestTranscript();
  const container = document.body.appendChild(document.createElement("div"));
  onTestFinished(() => {
    render(nothing, container);
    transcript.hostDisconnected();
  });
  render(renderChatThread(props, transcript), container);
  transcript.hostConnected();
  transcript.hostUpdated();
  await waitForSolid(() =>
    expect(
      container.querySelector(".chat-work-group > button")?.getAttribute("aria-expanded"),
    ).toBe("false"),
  );
  const text = container.textContent ?? "";
  for (const reply of ["Both started.", "Child A finished.", "Child B finished.", "All settled."]) {
    expect(text).toContain(reply);
  }
  expect(text).not.toContain("Spawning both.");
});
