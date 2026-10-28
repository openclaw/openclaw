import { createSignal, For, Match, Switch } from "solid-js";
import { expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { coalesceAgentRunFrames } from "../chat-agent-run-grouping.ts";
import { buildItems } from "../chat-thread.test-support.ts";
import { coalesceActivityRuns, collapseCompletedTurnWork } from "../chat-turn-presentation.ts";
import { splitMixedWorkGroup } from "../chat-work-chunks.ts";
import { AgentRunFrame } from "./chat-agent-run-frame.tsx";
import { MessageGroup } from "./chat-message-group-view.tsx";
import "../../../styles.css";
import "../../../styles/chat.ts";

const sessionKey = "agent:main:dashboard:synthetic-work-chunks";
const runId = "synthetic-anthropic";
const msg = (id: string, role: string, content: unknown, timestamp: number, extra = {}) => ({
  role,
  content,
  timestamp,
  runId,
  __openclaw: { id, runId },
  ...extra,
});
const tool = (id: string) => ({
  type: "toolCall",
  id,
  name: "read",
  arguments: { path: "synthetic.txt" },
});
const text = (value: string) => ({ type: "text", text: value });
const messages = [
  msg("prompt", "user", "Inspect the synthetic inputs.", 1000),
  msg("first", "assistant", [text("First visible narration."), tool("one")], 2000, {
    stopReason: "toolUse",
  }),
  msg("result-one", "toolResult", "First synthetic result.", 3000, {
    toolCallId: "one",
    toolName: "read",
  }),
  msg("second", "assistant", [text("Second visible narration."), tool("two")], 4000, {
    stopReason: "toolUse",
  }),
  msg("result-two", "toolResult", "Second synthetic result.", 5000, {
    toolCallId: "two",
    toolName: "read",
  }),
  msg("final", "assistant", "Final visible answer.", 6000, { stopReason: "stop" }),
];

it.each([
  { width: 1440, sameId: false },
  { width: 1440, sameId: true },
])(
  "renders in-place work at $width px (same-ID envelope=$sameId) in both modes",
  async ({ width, sameId }) => {
    const renderedMessages = sameId
      ? [
          messages[0]!,
          msg(
            "same-id",
            "assistant",
            [
              text("First visible narration."),
              tool("read-1"),
              text("Second visible narration."),
              { type: "tool_result", tool_use_id: "read-1", content: "Recorded result." },
              text("Final visible answer."),
            ],
            6000,
            { stopReason: "stop" },
          ),
        ]
      : messages;
    await page.viewport(width, 900);
    for (const bubbleMode of [false, true]) {
      const items = coalesceAgentRunFrames(
        coalesceActivityRuns(
          collapseCompletedTurnWork(
            buildItems({
              paneId: "work-chunks-browser-" + width + bubbleMode,
              sessionKey,
              messages: renderedMessages,
            }),
            { sessionKey, runWorking: false, bubbleMode },
          ),
        ),
        { messages: renderedMessages },
      );
      const [expanded, setExpanded] = createSignal(new Set<string>());
      const view = mountSolid(() => (
        <div
          class={["chat-thread", { "chat-thread--bubbles": bubbleMode }]}
          style={{ width: "900px", margin: "24px auto", height: "800px" }}
        >
          <div class="chat-thread-inner">
            <For each={items}>
              {(item) => (
                <Switch>
                  <Match when={item.kind === "agent-run-frame"}>
                    <AgentRunFrame
                      frame={item as Extract<typeof item, { kind: "agent-run-frame" }>}
                      options={{
                        streamOptions: { bubbleMode },
                        renderGroupOptions: () => ({
                          showReasoning: true,
                          showToolCalls: true,
                          bubbleMode,
                        }),
                        isWorkExpanded: (key) => expanded().has(key),
                        onToggleWork: (key, wasExpanded) =>
                          setExpanded((current) => {
                            const next = new Set(current);
                            if (wasExpanded) {
                              next.delete(key);
                            } else {
                              next.add(key);
                            }
                            return next;
                          }),
                      }}
                    />
                  </Match>
                  <Match when={item.kind === "group"}>
                    <MessageGroup
                      group={item as Extract<typeof item, { kind: "group" }>}
                      options={{ showReasoning: true, showToolCalls: true, bubbleMode }}
                    />
                  </Match>
                </Switch>
              )}
            </For>
          </div>
        </div>
      ));
      try {
        flush();
        await waitForSolid(() =>
          expect(view.container.textContent).toContain("Final visible answer."),
        );
        const visibleText = () =>
          [...view.container.querySelectorAll<HTMLElement>(".chat-text")].map((node) =>
            node.textContent?.trim(),
          );
        const summaries = () => [
          ...view.container.querySelectorAll<HTMLButtonElement>(".chat-work-group > button"),
        ];
        expect(visibleText()).toEqual([
          "Inspect the synthetic inputs.",
          "First visible narration.",
          "Second visible narration.",
          "Final visible answer.",
        ]);
        expect(summaries()).toHaveLength(2);
        const order = [
          ...view.container.querySelectorAll<HTMLElement>(".chat-text, .chat-work-group"),
        ].map((node) => (node.matches(".chat-work-group") ? "WORK" : node.textContent?.trim()));
        expect(order).toEqual([
          "Inspect the synthetic inputs.",
          "First visible narration.",
          "WORK",
          "Second visible narration.",
          "WORK",
          "Final visible answer.",
        ]);
        expect(
          summaries().every((button) => button.getAttribute("aria-expanded") === "false"),
        ).toBe(true);
        const before = visibleText();
        await userEvent.click(summaries()[0]!);
        await waitForSolid(() =>
          expect(summaries()[0]?.getAttribute("aria-expanded")).toBe("true"),
        );
        expect(summaries()[1]?.getAttribute("aria-expanded")).toBe("false");
        expect(visibleText().filter((value) => before.includes(value))).toEqual(before);
        await userEvent.click(summaries()[0]!);
        await waitForSolid(() =>
          expect(summaries()[0]?.getAttribute("aria-expanded")).toBe("false"),
        );
      } finally {
        view.unmount();
      }
    }
  },
);

it.each([false, true])(
  "renders one fenced code unit across text blocks (work between=%s)",
  async (workBetween) => {
    const thinking = { type: "thinking", thinking: "Recorded work" };
    const source = msg(
      "markdown",
      "assistant",
      [
        text("```js\nconst a = 1;"),
        ...(workBetween ? [thinking] : []),
        text("const b = 2;\n```"),
        ...(!workBetween ? [thinking] : []),
      ],
      1000,
      { stopReason: "stop" },
    );
    const group = buildItems({ paneId: "markdown-context", sessionKey, messages: [source] }).find(
      (item) => item.kind === "group",
    );
    if (!group || group.kind !== "group") {
      throw new Error("Missing group");
    }
    const parts = splitMixedWorkGroup(group);
    const view = mountSolid(() => (
      <div class="chat-thread">
        <For each={parts}>
          {(part) => (
            <MessageGroup group={part} options={{ showReasoning: false, showToolCalls: true }} />
          )}
        </For>
      </div>
    ));
    try {
      await waitForSolid(() => expect(view.container.querySelectorAll("pre")).toHaveLength(1));
      const code = view.container.querySelector("pre code");
      expect(code?.textContent).toContain("const a = 1;");
      expect(code?.textContent).toContain("const b = 2;");
      expect(view.container.querySelectorAll(".chat-text")).toHaveLength(1);
      expect(view.container.querySelector(".chat-text")?.textContent).not.toContain("```");
    } finally {
      view.unmount();
    }
  },
);
