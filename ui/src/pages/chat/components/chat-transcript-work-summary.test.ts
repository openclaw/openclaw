/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { wrapWebContent } from "../../../../../src/security/external-content.js";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { inlineCommandPresentation } from "../chat-inline-command-presentation.ts";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { saveChatSessionScrollPosition } from "../scroll.ts";
import { createChatThreadHarness } from "./chat-message-native.test-support.tsx";
import * as textPreparation from "./chat-message-text-preparation.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  resizeObservers,
  threadProps,
  transcriptDomState,
} from "./chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

it("keeps settled message preparation out of minute-boundary scroll updates", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(60_000);
  const prepare = vi.spyOn(textPreparation, "prepareMessageMarkdown");
  const props = threadProps("minute-scroll", "agent:main:minute-scroll", [
    { role: "user", content: "Inspect the workspace", timestamp: 1_000 },
    { role: "assistant", content: "**Workspace checked**", timestamp: 2_000 },
  ]);
  const transcript = createTestTranscript(props.paneId);
  const container = document.body.appendChild(document.createElement("div"));
  const thread = createChatThreadHarness(container, transcript);
  onTestFinished(() => {
    thread.unmount();
    transcript.dispose();
    prepare.mockRestore();
    clock.mockRestore();
  });
  thread.render(props);
  transcript.start();
  transcript.update();
  await waitForSolid(() => expect(container.textContent).toContain("Inspect the workspace"));
  expect(prepare).toHaveBeenCalled();
  prepare.mockClear();

  clock.mockReturnValue(120_000);
  thread.render(props);
  transcript.update();
  await waitForSolid(() => expect(container.textContent).toContain("Workspace checked"));
  expect(prepare).not.toHaveBeenCalled();
});

it("shows the inline command trail during a turn and folds it behind completed work", async () => {
  const inlineCommands = await inlineCommandPresentation();
  const runId = "inline-trail-run";
  const messages: unknown[] = [
    { role: "user", content: "Check the workspace", timestamp: 1_000 },
    {
      role: "assistant",
      runId,
      timestamp: 2_000,
      content: [
        { type: "toolCall", id: "first-check", name: "exec", arguments: { command: "npm test" } },
      ],
    },
    {
      role: "toolResult",
      runId,
      timestamp: 3_000,
      toolCallId: "first-check",
      toolName: "exec",
      content: "All checks passed",
    },
    {
      role: "assistant",
      runId,
      timestamp: 4_000,
      phase: "commentary",
      content: "Checking the next step.",
    },
    {
      role: "assistant",
      runId,
      timestamp: 5_000,
      content: [
        {
          type: "toolCall",
          id: "second-check",
          name: "exec",
          arguments: { command: "npm run build" },
        },
      ],
    },
  ];
  const props = threadProps("pane-inline-fold", "agent:main:dashboard:inline-fold", messages, {
    runId,
    runActive: true,
    runWorking: true,
    showToolCalls: true,
    inlineCommands,
    autoExpandToolCalls: true,
  });
  const transcript = createTestTranscript(props.paneId);
  const container = document.body.appendChild(document.createElement("div"));
  const thread = createChatThreadHarness(container, transcript);
  const draw = () => {
    thread.render(props);
    transcript.update();
  };
  onTestFinished(() => {
    thread.unmount();
    transcript.dispose();
    container.remove();
  });
  draw();
  await waitForSolid(() =>
    expect(container.querySelectorAll(".chat-tool-row__cmd")).toHaveLength(2),
  );
  expect(container.textContent).toContain("All checks passed");
  expect(container.querySelectorAll(".chat-tool-msg-collapse.is-open")).toHaveLength(0);
  expect(container.textContent).toContain("Checking the next step.");
  expect(container.querySelector(".chat-work-group")).toBeNull();
  props.inlineCommands = undefined;
  draw();
  await waitForSolid(() =>
    expect(container.querySelector(".chat-command-trail__preview")).toBeNull(),
  );
  props.inlineCommands = inlineCommands;
  props.runActive = false;
  props.runWorking = false;
  props.messages = [
    ...messages,
    {
      role: "toolResult",
      runId,
      timestamp: 6_000,
      toolCallId: "second-check",
      toolName: "exec",
      content: "Build passed",
    },
    {
      role: "assistant",
      runId,
      timestamp: 7_000,
      phase: "final_answer",
      content: "Workspace verified.",
    },
  ];
  draw();
  const toggle = () => container.querySelector<HTMLButtonElement>(".chat-work-group > button");
  await waitForSolid(() => expect(toggle()?.getAttribute("aria-expanded")).toBe("false"));
  expect(container.textContent).toContain("Workspace verified.");
  expect(container.querySelector(".chat-tool-row__cmd")).toBeNull();
  toggle()!.click();
  await waitForSolid(() =>
    expect(container.querySelectorAll(".chat-tool-row__cmd")).toHaveLength(2),
  );
  expect(container.textContent).toContain("All checks passed");
  expect(container.textContent).toContain("Build passed");
});

it.each([false, true])(
  "keeps the focused work summary toggle through expansion updates (long frame: %s)",
  async (longFrame) => {
    const entry = (id: string, seq: number, message: Record<string, unknown>) => ({
      timestamp: seq * 1_000,
      ...message,
      __openclaw: { id, seq, runId: "long-run" },
    });
    const longMessages = [
      entry("question", 1, { role: "user", content: "Inspect the workspace" }),
      ...Array.from({ length: 300 }, (_, index) => [
        entry(`step-${index}`, index * 2 + 2, {
          role: "assistant",
          phase: "commentary",
          stopReason: "toolUse",
          content: [
            { type: "text", text: `Inspecting file ${index}` },
            {
              type: "toolCall",
              id: `read-${index}`,
              name: "read",
              arguments: { path: `file-${index}.md` },
            },
          ],
        }),
        entry(`tool-${index}`, index * 2 + 3, {
          role: "toolResult",
          toolCallId: `read-${index}`,
          toolName: "read",
          content: "Read complete",
        }),
      ]).flat(),
      entry("long-answer", 602, {
        role: "assistant",
        phase: "final_answer",
        stopReason: "stop",
        content: "Workspace checked",
      }),
    ];
    const props = {
      ...threadProps(
        "pane-work-focus",
        "agent:main:dashboard:work-focus",
        longFrame
          ? longMessages
          : [
              { role: "user", content: "Inspect the workspace", timestamp: 1_000 },
              {
                role: "toolResult",
                toolCallId: "work-focus-read",
                toolName: "read",
                content: "Read complete",
                timestamp: 2_000,
              },
              { role: "assistant", content: "Workspace checked", timestamp: 3_000 },
            ],
      ),
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
    const toggleSelector = ".chat-work-group > button";
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
      if (longFrame && expanded) {
        await waitForSolid(() =>
          expect(container.querySelectorAll(".chat-bubble").length).toBeLessThan(100),
        );
        expect(container.textContent).toContain("Inspecting file 0");
        expect(container.textContent).not.toContain("Inspecting file 299");
      }
    }
  },
);

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
