/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { wrapWebContent } from "../../../../../src/security/external-content.js";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { saveChatSessionScrollPosition } from "../scroll.ts";
import { createChatThreadHarness } from "./chat-message-native.test-support.tsx";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  resizeObservers,
  threadProps,
  transcriptDomState,
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

// Short rows in a tall viewport keep every reply inside the virtualized window.
async function renderTallTranscript(name: string, messages: unknown[]) {
  transcriptDomState.measuredRowHeight = 20;
  transcriptDomState.detachedRowHeight = 20;
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(2_000);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 800, 2_000),
  );
  vi.stubGlobal("innerHeight", 2_000);
  const props = {
    ...threadProps(`pane-${name}`, `agent:main:dashboard:${name}`, messages),
    showToolCalls: true,
  };
  const transcript = createTestTranscript(props.paneId);
  const container = document.body.appendChild(document.createElement("div"));
  const thread = createChatThreadHarness(container, transcript);
  onTestFinished(() => {
    thread.unmount();
    transcript.dispose();
  });
  thread.render(props);
  transcript.update();
  transcript.start();
  for (const observer of resizeObservers) {
    observer.emit(800, 2_000);
  }
  transcript.update();
  await waitForSolid(() =>
    expect(
      container.querySelector(".chat-work-group > button")?.getAttribute("aria-expanded"),
    ).toBe("false"),
  );
  return container;
}

const run = (runId: string) => ({ __openclaw: { runId } });

it("shows every run's reply below completed work when completions arrive without user input", async () => {
  const container = await renderTallTranscript("work-runs", [
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
  ]);
  const text = container.textContent ?? "";
  for (const reply of ["Both started.", "Child A finished.", "Child B finished.", "All settled."]) {
    expect(text).toContain(reply);
  }
  expect(text).not.toContain("Spawning both.");
});

it("keeps a later run's source cards when an earlier run's reply stays visible", async () => {
  const url = "https://example.com/article";
  const details = {
    kind: "results",
    results: [{ url, title: wrapWebContent("Article title", "web_search") }],
    externalContent: { untrusted: true, source: "web_search", wrapped: true },
  };
  const container = await renderTallTranscript("work-sources", [
    { role: "user", content: "Start two subagents", timestamp: 1_000 },
    { role: "assistant", content: "Child A finished.", timestamp: 2_000, ...run("announce:a") },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "search", name: "web_search", arguments: {} }],
      timestamp: 3_000,
      ...run("announce:b"),
    },
    {
      role: "toolResult",
      toolCallId: "search",
      toolName: "web_search",
      content: JSON.stringify(details),
      details,
      timestamp: 3_500,
      ...run("announce:b"),
    },
    {
      role: "assistant",
      content: `Child B cited the [article](${url}).`,
      stopReason: "stop",
      timestamp: 4_000,
      ...run("announce:b"),
    },
  ]);
  expect(container.textContent).toContain("Child A finished.");
  // The search result sits in the rollup above both replies; the citing reply keeps its card.
  await waitForSolid(() => expect(container.querySelector(".chat-source-card")).not.toBeNull());
});
