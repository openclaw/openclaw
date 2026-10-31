/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { saveChatSessionScrollPosition } from "../scroll.ts";
import { createChatThreadHarness } from "./chat-message-native.test-support.tsx";
import * as textPreparation from "./chat-message-text-preparation.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
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
