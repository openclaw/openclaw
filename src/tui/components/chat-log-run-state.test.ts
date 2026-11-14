import { beforeEach, describe, expect, it } from "vitest";
import { normalizeTestText } from "../../../test/helpers/normalize-text.js";
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
  it.each([0, 39])("anchors a delayed prompt before surviving finals after %i notices", (count) => {
    chatLog.finalizeAssistant("First reply.", "peer-run");
    addNotices(count);
    chatLog.finalizeAssistant("Second reply.", "peer-run");
    chatLog.addLiveUser("Late peer prompt.", { messageId: "peer-user", runId: "peer-run" });

    expect(render().match(/(?:Late peer prompt|First reply|Second reply)\./gu)).toEqual(
      count === 0
        ? ["Late peer prompt.", "First reply.", "Second reply."]
        : ["Late peer prompt.", "Second reply."],
    );
    expect(chatLog.children.length).toBeLessThanOrEqual(40);
  });

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

  it("anchors a delayed prompt before the surviving streaming reply after pruning", () => {
    chatLog = new ChatLog(20);
    chatLog.finalizeAssistant("Evicted reply.", "old-run");
    chatLog.updateAssistant("Surviving reply.", "run");
    addNotices(18);
    chatLog.startTool("tool", "read_file", { path: "active.txt" });
    chatLog.addLiveUser("Delayed prompt.", { messageId: "user", runId: "run" });
    const rendered = render();
    expect(chatLog.children).toHaveLength(20);
    expect(rendered).not.toContain("Evicted reply.");
    expectOrder(rendered, "Delayed prompt.", "Surviving reply.");
    expectOrder(rendered, "Surviving reply.", "Read File");
  });

  it("deduplicates authoritative user events and adopts the matching pending prompt", () => {
    chatLog.addPendingUser("local-send", "Persisted prompt.");
    chatLog.updateAssistant("Already streaming.", "shared-run");
    const identity = { messageId: "shared-user", sendId: "local-send", runId: "shared-run" };
    chatLog.addLiveUser("Persisted prompt.", identity);
    chatLog.addLiveUser("Persisted prompt.", identity);

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
