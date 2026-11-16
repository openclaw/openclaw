import { createComponent, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../../../styles.css";
import "../../../styles/chat.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { ActivityGroup, MessageGroup as NativeMessageGroup } from "./chat-message-group-view.tsx";
import { settleToolBridges } from "./chat-tool-render.test-support.ts";

let container: HTMLDivElement;
let root: { unmount(): void } | undefined;
beforeEach(() => {
  container = document.body.appendChild(document.createElement("div"));
  container.style.width = "760px";
});
afterEach(() => {
  root?.unmount();
  container.remove();
  root = undefined;
});

function messageGroup(key: string, role: string, messages: unknown[]): MessageGroup {
  return {
    kind: "group",
    key,
    role,
    timestamp: 1000,
    isStreaming: false,
    visibleContent: "non-text",
    messages: messages.map((message, i) => ({ key: key + i, message, hasVisibleContent: true })),
  };
}

function call(id: string, name: string, args: unknown, parentToolCallId?: string) {
  return {
    type: "toolCall",
    id,
    name,
    runId: "activity-layout",
    arguments: args,
    ...(parentToolCallId ? { parentToolCallId } : {}),
  };
}

function child(index: number, parent: string) {
  const id = "child-" + index;
  const content: unknown[] = [
    call(id, "read", { path: `/${index}.ts` }, parent),
    {
      type: "toolResult",
      toolCallId: id,
      toolName: "read",
      content: [{ type: "text", text: "Source contents" }],
    },
  ];
  return {
    role: "custom",
    content,
    timestamp: 1000 + index,
  };
}

function activityFixture(note = "") {
  const messages: unknown[] = Array.from({ length: 4 }, (_, index) => ({
    role: "assistant",
    content: [call("batch-" + index, "exec", { title: `Batch ${index + 1}`, code: "// Read" })],
    timestamp: 1000,
  }));
  // Keep the expanded activity tall enough to exercise scrolling with compact rows.
  for (let index = 0; index < 48; index++) {
    const message = child(index, "batch-" + Math.floor(index / 12));
    if (index === 0 && note) {
      message.content.push({ type: "text", text: note });
    }
    messages.push(message);
  }
  return messageGroup("activity", "tool", messages);
}

function mountActivity(group: MessageGroup, inline = false, expandMessages = true) {
  const expanded = new Set<string>();
  root = mountSolid(
    () => {
      const [revision, setRevision] = createSignal(0);
      const [activityExpanded, setActivityExpanded] = createSignal(expandMessages);
      const options = () => {
        revision();
        return {
          showReasoning: false,
          isToolMessageExpanded: activityExpanded,
          onToggleToolMessageExpanded: () => setActivityExpanded((value) => !value),
          isToolExpanded: (id: string) => expanded.has(id),
          onToggleToolExpanded: (id: string) => {
            if (expanded.has(id)) {
              expanded.delete(id);
            } else {
              expanded.add(id);
            }
            setRevision((value) => value + 1);
            flush();
          },
        };
      };
      const activity = createComponent(ActivityGroup, {
        groups: [group],
        get options() {
          return options();
        },
        presentation: inline ? "continuation" : "standalone",
      });
      return inline
        ? createComponent(NativeMessageGroup, {
            group: messageGroup("frame", "assistant", [
              { role: "assistant", content: "Finished." },
            ]),
            get options() {
              return { ...options(), frameContent: [activity] };
            },
          })
        : activity;
    },
    { container },
  );
  return settleToolBridges(container);
}

const bodyElement = () => container.querySelector<HTMLElement>(".chat-activity-group__body")!;

describe.runIf("__vitest_browser__" in globalThis)("activity group sizing", () => {
  it.each(["standalone", "inline"])("sizes and collapses %s", async (presentation) => {
    await mountActivity(activityFixture(), presentation === "inline", false);
    const body = bodyElement();
    expect(body.getBoundingClientRect().height).toBe(0);

    const toggle = () =>
      container.querySelector<HTMLButtonElement>(".chat-activity-group__summary")!.click();
    toggle();
    await settleToolBridges(container);
    expect(body.querySelectorAll(".chat-tool-row")).toHaveLength(48);
    expect(body.clientHeight).toBeGreaterThan(0);
    expect(body.clientHeight).toBeLessThan(window.innerHeight);
    expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
    body.scrollTop = body.scrollHeight;
    expect(body.scrollTop).toBeGreaterThan(0);

    toggle();
    await settleToolBridges(container);
    expect(body.getBoundingClientRect().height).toBe(0);
  });

  it("preserves non-tool text beside flattened child operations", async () => {
    const note = "Keep this explanation visible.";
    const group = activityFixture(note);
    await mountActivity(group);
    expect(container.querySelectorAll(".chat-tool-row")).toHaveLength(48);
    expect(container.querySelector(".chat-text")?.textContent).toContain(note);
    expect(container.textContent).not.toContain("Source contents");
  });
});
