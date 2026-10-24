import { beforeEach, describe, expect, it } from "vitest";
import { normalizeTestText } from "../../../test/helpers/normalize-text.js";
import { readTuiSessionUserMessage } from "../tui-session-events.js";
import { ChatLog } from "./chat-log.js";
import { MarkdownMessageComponent } from "./markdown-message.js";

describe("ChatLog run state", () => {
  let chatLog: ChatLog;
  beforeEach(() => {
    chatLog = new ChatLog(40);
  });
  const render = () => normalizeTestText(chatLog.render(120).join("\n"));
  function expectOrder(rendered: string, first: string, second: string) {
    expect(rendered.indexOf(first)).toBeLessThan(rendered.indexOf(second));
  }
  function addNotices(count: number) {
    for (let index = 0; index < count; index += 1) {
      chatLog.addSystem(`Retained notice ${index}.`);
    }
  }
  it("keeps revised snapshots scoped to their own concurrent assistant run", () => {
    chatLog.updateAssistant("Obsolete first", "run-first");
    chatLog.updateAssistant("Preserved second", "run-second");
    chatLog.startTool("first-tool", "read_file", { path: "first.txt" }, "run-first");
    chatLog.updateAssistant("Revised first", "run-first");
    chatLog.updateAssistant("Preserved second\n\nSecond continuation", "run-second");

    const rendered = render();
    expect(rendered).not.toContain("Obsolete first");
    for (const text of ["Revised first", "Preserved second", "Second continuation"]) {
      expect(rendered.split(text)).toHaveLength(2);
    }
    expectOrder(rendered, "Preserved second", "Second continuation");
  });

  it.each([false, true])("anchors a delayed prompt after pruning (streaming=%s)", (streaming) => {
    chatLog = new ChatLog(20);
    chatLog.finalizeAssistant("Evicted reply.", streaming ? "old-run" : "run");
    if (streaming) {
      chatLog.updateAssistant("Surviving reply.", "run");
      addNotices(18);
      chatLog.startTool("tool", "read_file", { path: "active.txt" });
    } else {
      addNotices(19);
      chatLog.finalizeAssistant("Surviving reply.", "run");
    }
    chatLog.addLiveUser("Delayed prompt.", { messageId: "user", runId: "run" });
    const rendered = render();
    expect(chatLog.children).toHaveLength(20);
    expect(rendered).not.toContain("Evicted reply.");
    expectOrder(rendered, "Delayed prompt.", "Surviving reply.");
    if (streaming) {
      expectOrder(rendered, "Surviving reply.", "Read File");
    }
  });

  it("deduplicates authoritative user events and adopts the matching pending prompt", () => {
    chatLog.addPendingUser("local-send", "Persisted prompt.");
    chatLog.updateAssistant("Already streaming.", "shared-run");
    const message = readTuiSessionUserMessage({
      message: {
        role: "user",
        content: "Persisted prompt.",
        __openclaw: { id: "shared-user", idempotencyKey: "local-send:user", runId: "shared-run" },
      },
    });
    expect(message).not.toBeNull();
    if (!message) {
      throw new Error("expected a persisted user message");
    }
    chatLog.addLiveUser(message.text, message);
    chatLog.addLiveUser(message.text, message);

    expect(render()).toContain("Persisted prompt.");
    const roles = chatLog.children.map((c) =>
      c instanceof MarkdownMessageComponent ? c.role : c.constructor.name,
    );
    expect(roles).toEqual(["user", "assistant"]);
    expect(chatLog.countPendingUsers()).toBe(0);
  });

  it("preserves a different pending prompt when another client uses the same run", () => {
    chatLog.addPendingUser("shared-run", "My local steering prompt.");
    chatLog.updateAssistant("Already streaming.", "shared-run");

    const identity = { messageId: "user", runId: "shared-run", sendId: "remote-send" };
    chatLog.addLiveUser("Another client's persisted prompt.", identity);

    const rendered = render();
    expect(rendered).toContain("My local steering prompt.");
    expect(rendered).toContain("Another client's persisted prompt.");
    expectOrder(rendered, "Another client's persisted prompt.", "Already streaming.");
    expect(chatLog.countPendingUsers()).toBe(1);
  });

  it("re-keys a pending user in place without moving its position", () => {
    chatLog.addPendingUser("local", "queued hello");
    chatLog.updateAssistant("hi there", "r-accepted");
    chatLog.rekeyPendingUser("local", "r-accepted");

    expectOrder(render(), "queued hello", "hi there");
    chatLog.dropPendingUser("r-accepted");
    expect(chatLog.countPendingUsers()).toBe(0);
  });
});
