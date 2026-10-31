import { afterEach, expect, it, vi } from "vitest";
import { agentEvent, createHost, useToolStreamFakeTimers } from "./tool-stream.test-helpers.ts";
import { handleAgentEvent } from "./tool-stream.ts";

afterEach(() => vi.useRealTimers());
it("uses cumulative run-scoped widget snapshots and retires them on result or cancellation", () => {
  useToolStreamFakeTimers();
  const host = createHost({ chatRunId: "run" });
  const input = (run: string, seq: number, html: string, session = "main") =>
    handleAgentEvent(
      host,
      agentEvent(
        run,
        seq,
        "tool",
        {
          phase: "widget_preview",
          name: "show_widget",
          toolCallId: "call",
          preview: { title: "Survey", html },
        },
        session,
      ),
    );
  input("run", 1, "<p>First");
  input("run", 3, "<p>First complete</p><p>Second"); // A dropped intermediate frame needs no replay.
  input("run", 2, "<p>Stale");
  input("other-run", 1, "<p>Other call");
  input("run", 4, "<p>Wrong session", "different");
  vi.advanceTimersByTime(100);
  expect(host.chatToolMessages.map((message) => message["__openclawWidgetInputPreview"])).toEqual([
    {
      identity: JSON.stringify(["run", "call"]),
      title: "Survey",
      html: "<p>First complete</p><p>Second",
    },
    { identity: JSON.stringify(["other-run", "call"]), title: "Survey", html: "<p>Other call" },
  ]);
  handleAgentEvent(
    host,
    agentEvent("run", 5, "tool", {
      phase: "result",
      name: "show_widget",
      toolCallId: "call",
      isError: true,
      result: { content: [{ type: "text", text: "Invalid script" }] },
    }),
  );
  input("run", 6, "<p>Late input");
  handleAgentEvent(host, agentEvent("other-run", 2, "lifecycle", { phase: "end", aborted: true }));
  input("other-run", 3, "<p>Late cancelled input");
  vi.advanceTimersByTime(100);
  expect(
    host.chatToolMessages.every((message) => message["__openclawWidgetInputPreview"] === undefined),
  ).toBe(true);
});
