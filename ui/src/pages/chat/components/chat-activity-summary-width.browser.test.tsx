import { expect, it, onTestFinished } from "vitest";
import "../../../styles.css";
import "../../../styles/chat.ts";
import type { MessageGroup as MessageGroupData } from "../../../lib/chat/chat-types.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { ActivityGroup, MessageGroup, MessageGroupContent } from "./chat-message-group-view.tsx";
import { settleToolBridges } from "./chat-tool-render.test-support.ts";

// Distinct actions keep the semantic summary long enough to exercise truncation.
const TOOLS = [
  "exec",
  "read",
  "edit",
  "write",
  "grep",
  "web_fetch",
  "knowledge_save_page",
  "knowledge_lookup",
  "sessions_send",
  "agents_wait",
  "ask_user",
  "custom_tool",
];
const PROSE = "The reply wraps inside the reading column of the conversation. ".repeat(6);

function group(key: string, role: string, messages: unknown[]): MessageGroupData {
  return {
    kind: "group",
    key,
    role,
    timestamp: 1000,
    isStreaming: false,
    visibleContent: role === "tool" ? "non-text" : "text",
    messages: messages.map((message, i) => ({ key: key + i, message, hasVisibleContent: true })),
  };
}

const activity = group(
  "activity",
  "tool",
  TOOLS.flatMap((name, index) => [
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-" + index, name, arguments: { path: "/a.ts" } }],
      timestamp: 1000,
    },
    {
      role: "toolResult",
      toolCallId: "call-" + index,
      toolName: name,
      content: [{ type: "text", text: "ok" }],
      timestamp: 1001,
    },
  ]),
);
const reply = group("reply", "assistant", [{ role: "assistant", content: PROSE, timestamp: 2000 }]);
const options = { showReasoning: false, isToolMessageExpanded: () => false };

// Shared threads inset the reading column for avatars; direct threads use the whole thread.
it.each(
  ["direct", "shared"].flatMap((thread) =>
    (["continuation", "standalone"] as const).map((presentation) => ({ thread, presentation })),
  ),
)(
  "ends a long $presentation activity summary at the reply's edge in a $thread thread",
  async ({ thread, presentation }) => {
    const container = document.body.appendChild(document.createElement("div"));
    container.className = "chat";
    container.style.width = "640px";
    const root = mountSolid(
      () => (
        <div class={["chat-thread", { "chat-thread--direct": thread === "direct" }]}>
          {presentation === "standalone" ? (
            <>
              <ActivityGroup groups={[activity]} options={options} presentation="standalone" />
              <MessageGroup group={reply} options={options} />
            </>
          ) : (
            <MessageGroup
              group={reply}
              options={{
                ...options,
                frameContent: [
                  <ActivityGroup
                    groups={[activity]}
                    options={options}
                    presentation="continuation"
                  />,
                  <MessageGroupContent group={reply} options={options} />,
                ],
              }}
            />
          )}
        </div>
      ),
      { container },
    );
    onTestFinished(() => {
      root.unmount();
      container.remove();
    });
    await settleToolBridges(container);

    const summary = container.querySelector<HTMLElement>(".chat-activity-group__summary")!;
    const label = summary.querySelector<HTMLElement>(".chat-activity-group__label")!;
    const paragraph = container.querySelector<HTMLElement>(".chat-text p")!;
    // The fixture must overflow, or the shared edge below proves nothing.
    expect(label.scrollWidth).toBeGreaterThan(label.clientWidth);
    expect(getComputedStyle(label).textOverflow).toBe("ellipsis");
    expect(summary.getBoundingClientRect().right).toBeCloseTo(
      paragraph.getBoundingClientRect().right,
      0,
    );
  },
);
