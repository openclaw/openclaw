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

function child(index: number, parent: string, process = false) {
  const id = "child-" + index;
  const name = process ? "process" : "read";
  const args = process ? { action: "poll" } : { path: `/${index}.ts` };
  const text = process ? "running" : "Source contents";
  const content: unknown[] = [
    call(id, name, args, parent),
    { type: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }] },
  ];
  return {
    role: "custom",
    content,
    timestamp: 1000 + index + Number(process),
    ...(process ? { activity: [] } : {}),
  };
}

function activityFixture(note = "") {
  const messages: unknown[] = Array.from({ length: 4 }, (_, index) => ({
    role: "assistant",
    content: [call("batch-" + index, "exec", { title: `Batch ${index + 1}`, code: "// Read" })],
    timestamp: 1000,
  }));
  // Keep one expanded batch tall enough to exercise scrolling with compact rows.
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
      const options = () => {
        revision();
        return {
          showReasoning: false,
          ...(expandMessages ? { isToolMessageExpanded: () => true } : {}),
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
const cappedHeight = () => Math.min(420, window.innerHeight * 0.58);

describe.runIf("__vitest_browser__" in globalThis)("activity group sizing", () => {
  it.each(["standalone", "inline"])("sizes and collapses %s", async (presentation) => {
    await mountActivity(activityFixture(), presentation === "inline");
    const body = bodyElement();
    const compactHeight = body.getBoundingClientRect().height;
    expect(body.querySelectorAll(":scope > .chat-bubble")).toHaveLength(4);
    expect(body.querySelectorAll(".chat-tool-row")).toHaveLength(4);
    expect(body.scrollHeight).toBe(body.clientHeight);
    expect(compactHeight).toBeGreaterThan(0);
    expect(compactHeight).toBeLessThan(200);

    const toggle = () => body.querySelector<HTMLButtonElement>(".chat-tool-msg-summary")!.click();
    toggle();
    await settleToolBridges(container);
    expect(body.querySelectorAll(".chat-tool-row")).toHaveLength(16);
    expect(body.getBoundingClientRect().height).toBeCloseTo(cappedHeight(), 0);
    expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
    body.scrollTop = body.scrollHeight;
    expect(body.scrollTop).toBeGreaterThan(0);

    toggle();
    await settleToolBridges(container);
    expect(body.getBoundingClientRect().height).toBe(compactHeight);
    expect(body).toMatchObject({ scrollHeight: body.clientHeight, scrollTop: 0 });
  });

  it("caps an opened lone step whose nested calls are all routine", async () => {
    const group = messageGroup("step", "tool", [
      {
        role: "assistant",
        content: [call("step", "exec", { title: "Build", code: "// Poll" })],
        activity: [
          {
            itemId: "tool:step",
            toolCallId: "step",
            kind: "tool",
            name: "exec",
            title: "Exec",
            phase: "end",
            status: "completed",
            commandBearing: true,
          },
        ],
        timestamp: 1000,
      },
      ...Array.from({ length: 40 }, (_, index) => child(index, "step", true)),
    ]);
    await mountActivity(group, false, false);
    expect(container.querySelector(".chat-activity-group__summary")).toBeNull();
    const body = bodyElement();
    const chevronOpacity = (row: number) =>
      getComputedStyle(body.querySelectorAll(".chat-tool-row__chevron")[row]!).opacity;
    expect(body.querySelectorAll(".chat-tool-row")).toHaveLength(1);
    expect(body.scrollHeight).toBe(body.clientHeight);
    const { userEvent } = await import("vitest/browser");
    await userEvent.hover(body.querySelector<HTMLButtonElement>(".chat-tool-msg-summary")!);
    await expect.poll(() => chevronOpacity(0)).not.toBe("0");
    await userEvent.hover(document.body);

    body.querySelector<HTMLButtonElement>(".chat-tool-msg-summary")!.click();
    await settleToolBridges(container);
    expect(body.querySelectorAll(".chat-tool-row")).toHaveLength(41);
    expect(chevronOpacity(1)).toBe("0");
    expect(body.getBoundingClientRect().height).toBeCloseTo(cappedHeight(), 0);
    expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
  });

  it("preserves non-tool text beside a card moved under its parent", async () => {
    const note = "Keep this explanation visible.";
    await mountActivity(activityFixture(note));
    expect(container.querySelectorAll(".chat-tool-row")).toHaveLength(4);
    expect(container.querySelectorAll(".chat-activity-group__body > .chat-bubble")).toHaveLength(5);
    expect(container.querySelector(".chat-text")?.textContent).toContain(note);
  });
});
