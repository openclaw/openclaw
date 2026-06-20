import { afterEach, describe, expect, it, vi } from "vitest";
import type { GetReplyOptions } from "../../auto-reply/get-reply-options.types.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../agent-events.js";
import { createMirrorReplyResolver } from "./echo-mirror-resolver.js";

vi.mock("../../logging/subsystem.js", () => {
  const logger = {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return { createSubsystemLogger: () => logger };
});

function emitLifecycleEnd(runId: string) {
  emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
}

// Let the serial drain (async) flush.
async function flush() {
  await new Promise((r) => {
    setTimeout(r, 0);
  });
  await new Promise((r) => {
    setTimeout(r, 0);
  });
}

describe("createMirrorReplyResolver", () => {
  afterEach(() => {
    resetAgentEventsForTest();
  });

  it("replays assistant deltas into onPartialReply and resolves the final text on lifecycle end", async () => {
    const { resolver } = createMirrorReplyResolver({ originRunId: "r1" });
    const partials: Array<{ text?: string; delta?: string }> = [];
    const opts: GetReplyOptions = {
      onPartialReply: (p) => {
        partials.push({ text: p.text, delta: p.delta });
      },
    };
    const done = resolver({} as never, opts);

    emitAgentEvent({ runId: "r1", stream: "assistant", data: { text: "Hel", delta: "Hel" } });
    emitAgentEvent({ runId: "r1", stream: "assistant", data: { text: "Hello", delta: "lo" } });
    emitLifecycleEnd("r1");
    await flush();

    const final = (await done) as ReplyPayload;
    expect(partials).toEqual([
      { text: "Hel", delta: "Hel" },
      { text: "Hello", delta: "lo" },
    ]);
    expect(final.text).toBe("Hello");
  });

  it("ignores events for other runIds", async () => {
    const { resolver } = createMirrorReplyResolver({ originRunId: "r1" });
    const partials: string[] = [];
    const done = resolver({} as never, {
      onPartialReply: (p) => {
        if (p.text) {
          partials.push(p.text);
        }
      },
    });

    emitAgentEvent({ runId: "OTHER", stream: "assistant", data: { text: "nope" } });
    emitAgentEvent({ runId: "r1", stream: "assistant", data: { text: "yes" } });
    emitLifecycleEnd("r1");
    await flush();

    await done;
    expect(partials).toEqual(["yes"]);
  });

  it("buffers events that arrive before the resolver is invoked, then drains in order", async () => {
    const { resolver } = createMirrorReplyResolver({ originRunId: "r1" });

    // Events arrive BEFORE the target dispatch calls the resolver.
    emitAgentEvent({ runId: "r1", stream: "assistant", data: { text: "early" } });
    emitAgentEvent({
      runId: "r1",
      stream: "item",
      data: { itemId: "i1", phase: "start", title: "t" },
    });

    const seen: string[] = [];
    const done = resolver({} as never, {
      onPartialReply: (p) => {
        if (p.text) {
          seen.push(`partial:${p.text}`);
        }
      },
      onItemEvent: (p) => {
        seen.push(`item:${p.itemId}`);
      },
    });

    emitLifecycleEnd("r1");
    await flush();
    await done;
    expect(seen).toEqual(["partial:early", "item:i1"]);
  });

  it("routes each stream to its matching callback", async () => {
    const { resolver } = createMirrorReplyResolver({ originRunId: "r1" });
    const calls: string[] = [];
    const opts: GetReplyOptions = {
      onItemEvent: () => void calls.push("item"),
      onToolStart: () => void calls.push("tool"),
      onReasoningStream: () => void calls.push("reasoning"),
      onPlanUpdate: () => void calls.push("plan"),
      onCommandOutput: () => void calls.push("command_output"),
      onPatchSummary: () => void calls.push("patch"),
    };
    const done = resolver({} as never, opts);

    emitAgentEvent({ runId: "r1", stream: "item", data: { itemId: "i" } });
    emitAgentEvent({ runId: "r1", stream: "tool", data: { toolCallId: "c", name: "bash" } });
    emitAgentEvent({ runId: "r1", stream: "thinking", data: { delta: "hmm" } });
    emitAgentEvent({ runId: "r1", stream: "plan", data: { title: "p" } });
    emitAgentEvent({
      runId: "r1",
      stream: "command_output",
      data: { toolCallId: "c", output: "x" },
    });
    emitAgentEvent({ runId: "r1", stream: "patch", data: { toolCallId: "c", summary: "s" } });
    emitLifecycleEnd("r1");
    await flush();
    await done;

    expect(calls).toEqual(["item", "tool", "reasoning", "plan", "command_output", "patch"]);
  });

  it("a throwing target callback does not reject the resolver", async () => {
    const { resolver } = createMirrorReplyResolver({ originRunId: "r1" });
    const done = resolver({} as never, {
      onPartialReply: () => {
        throw new Error("render boom");
      },
    });

    emitAgentEvent({ runId: "r1", stream: "assistant", data: { text: "hi" } });
    emitLifecycleEnd("r1");
    await flush();

    const final = (await done) as ReplyPayload;
    expect(final.text).toBe("hi");
  });

  it("settles early when the abort signal fires", async () => {
    const { resolver } = createMirrorReplyResolver({ originRunId: "r1" });
    const controller = new AbortController();
    const done = resolver({} as never, { abortSignal: controller.signal });

    emitAgentEvent({ runId: "r1", stream: "assistant", data: { text: "partial" } });
    await flush();
    controller.abort();

    const final = (await done) as ReplyPayload | undefined;
    // Resolves (does not hang) with whatever was accumulated.
    expect(final?.text).toBe("partial");
  });

  it("resolves undefined when the run ends with no assistant output", async () => {
    const { resolver } = createMirrorReplyResolver({ originRunId: "r1" });
    const done = resolver({} as never, {});
    emitLifecycleEnd("r1");
    await flush();
    expect(await done).toBeUndefined();
  });

  it("renders a durable tool summary from start+result tool events via onToolResult", async () => {
    const { resolver } = createMirrorReplyResolver({
      originRunId: "r1",
      toolProgressDetail: "raw",
    });
    const toolStarts: unknown[] = [];
    const toolResults: ReplyPayload[] = [];
    const done = resolver({} as never, {
      onToolStart: (p) => void toolStarts.push(p),
      onToolResult: (p) => void toolResults.push(p),
    });

    emitAgentEvent({
      runId: "r1",
      stream: "tool",
      data: { phase: "start", name: "bash", toolCallId: "c1", args: { command: "date -u" } },
    });
    emitAgentEvent({
      runId: "r1",
      stream: "tool",
      data: {
        phase: "result",
        name: "bash",
        toolCallId: "c1",
        isError: false,
        result: "Fri Jun 12",
      },
    });
    emitLifecycleEnd("r1");
    await flush();
    await done;

    // "start" drives the live status (onToolStart); "result" drives the durable 🛠️
    // summary (onToolResult) and must NOT be re-routed to onToolStart.
    expect(toolStarts).toHaveLength(1);
    expect(toolResults).toHaveLength(1);
    expect(typeof toolResults[0].text).toBe("string");
    expect((toolResults[0].text ?? "").length).toBeGreaterThan(0);
  });

  it("propagates a tool error to onToolResult", async () => {
    const { resolver } = createMirrorReplyResolver({ originRunId: "r1" });
    const toolResults: ReplyPayload[] = [];
    const done = resolver({} as never, {
      onToolResult: (p) => void toolResults.push(p),
    });

    emitAgentEvent({
      runId: "r1",
      stream: "tool",
      data: { phase: "start", name: "bash", toolCallId: "c1", args: { command: "false" } },
    });
    emitAgentEvent({
      runId: "r1",
      stream: "tool",
      data: { phase: "result", name: "bash", toolCallId: "c1", isError: true, result: "boom" },
    });
    emitLifecycleEnd("r1");
    await flush();
    await done;

    expect(toolResults).toHaveLength(1);
    expect(toolResults[0].isError).toBe(true);
  });
});
