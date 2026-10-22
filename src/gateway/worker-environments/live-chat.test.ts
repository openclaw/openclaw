import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkerLiveEventParams } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import type { AssistantMessage } from "../../llm/types.js";
import { extractFirstTextBlock } from "../../shared/chat-message-content.js";
import { createWorkerLiveRuntime } from "../../worker/embedded-agent-live.runtime.js";
import {
  ComposedGatewayHarness,
  RUN_ID,
  type WorkerClients,
} from "../../worker/worker-fault-injection.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

let harness: ComposedGatewayHarness;
let testSignal: AbortSignal;
const clients: WorkerClients[] = [];

beforeEach(async ({ signal }) => {
  testSignal = signal;
  harness = await ComposedGatewayHarness.create(tempDirs.make("oc-wc-"));
  await harness.start();
});

afterEach(async () => {
  for (const current of clients.splice(0)) {
    current.inference.dispose();
    current.live.dispose();
    await current.connection.stop();
  }
  await harness.close();
});

async function liveProjection() {
  const current = await harness.createClients();
  clients.push(current);
  await current.connection.start();
  const runtime = createWorkerLiveRuntime({
    enqueuePreview: (event) => current.live.enqueuePreview(RUN_ID, event),
    emitTerminal: (event) => current.live.emitTerminal(RUN_ID, event),
  });
  const start = () => runtime.handleSessionEvent({ type: "message_start", message: message("") });
  const preview = (message: AssistantMessage, contentIndex = 0, delta?: string) => {
    const block = message.content[contentIndex];
    runtime.handleSessionEvent({
      type: "message_update",
      message,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex,
        delta: delta ?? (block?.type === "text" ? block.text : ""),
        partial: message,
      },
    });
  };
  const end = (message: AssistantMessage) =>
    runtime.handleSessionEvent({ type: "message_end", message });
  const finish = async (text?: string) => {
    runtime.handleSessionEvent({ type: "agent_end", messages: [], willRetry: false });
    await runtime.emitTerminal();
    expect(harness.chat.events.every((event) => event.state === "delta")).toBe(true);
    if (text !== undefined) {
      await expectChatText(text);
    }
  };
  return { runtime, start, preview, end, finish };
}

const message = (text: string) => makeAgentAssistantMessage({ content: [{ type: "text", text }] });
const signedText = (text: string, id: string, phase: string) => ({
  type: "text" as const,
  text,
  textSignature: JSON.stringify({ v: 1, id, phase }),
});
const snapshots = () =>
  harness.requestParams("worker.live-event").flatMap((params) => {
    const { event } = params as WorkerLiveEventParams;
    return event.kind === "assistant" ? [event.payload] : [];
  });
const expectChatText = async (text: string) => {
  const latestText = () => {
    const event = harness.chat.events.at(-1);
    return extractFirstTextBlock(event && "message" in event ? event.message : undefined);
  };
  const projected = createDeferred();
  const push = harness.chat.events.push.bind(harness.chat.events);
  const capture = vi.spyOn(harness.chat.events, "push").mockImplementation((...events) => {
    const count = push(...events);
    if (latestText() === text) {
      projected.resolve();
    }
    return count;
  });
  try {
    if (latestText() !== text) {
      await withinTest(projected.promise, testSignal);
    }
    expect(latestText()).toBe(text);
    expect(harness.chat.state.runs.get(RUN_ID)?.rawBuffer).toBe(text);
  } finally {
    capture.mockRestore();
  }
};

it.each([
  ["exact silence", ["NO_", "REPLY"], []],
  ["padded silence", [" \nNO_", "REPLY \t"], []],
  ["split control line", ["NO", "_REPLY", "\n", "Visible answer."], ["Visible answer."]],
  ["literal NO_REPLY suffix", ["NO_REPLY", "\nNO_", "REPLY"], ["NO_", "NO_REPLY"]],
] as const)(
  "prepares %s before worker publication and Gateway projection",
  async (_name, chunks, published) => {
    const live = await liveProjection();
    live.start();
    let text = "";
    {
      using clock = vi.spyOn(Date, "now");
      const startedAt = Date.now();
      for (const [index, chunk] of chunks.entries()) {
        // Exercise each protocol snapshot independently of worker preview pacing.
        clock.mockReturnValue(startedAt + index * 100);
        text += chunk;
        live.preview(message(text), 0, chunk);
      }
    }
    live.end(message(text));
    await live.finish();
    expect(snapshots().map((snapshot) => snapshot.text)).toEqual(published);
    const visible = published.at(-1);
    if (visible) {
      await expectChatText(visible);
    } else {
      expect(harness.chat.events).toEqual([]);
      expect(harness.chat.state.runs.get(RUN_ID)?.rawBuffer ?? "").toBe("");
    }
  },
);

it.each(["Before tool\n", ""])("projects an empty worker final after prefix %j", async (prefix) => {
  const live = await liveProjection();
  if (prefix) {
    live.start();
    live.end(message(prefix));
    live.runtime.handleSessionEvent({
      type: "tool_execution_start",
      toolCallId: "read-1",
      toolName: "read",
      args: {},
    });
  }
  live.start();
  live.preview(message("Draft with stale suffix"));
  await expectChatText(
    prefix ? "Before tool\n\nDraft with stale suffix" : "Draft with stale suffix",
  );
  live.end(message(""));
  await live.finish(prefix);
  expect(harness.chat.events.at(-1)).toMatchObject({
    state: "delta",
    deltaText: prefix,
    replace: true,
  });
});

it("replaces repeated bounded Unicode worker snapshots without replaying prior text", async () => {
  const live = await liveProjection();
  live.start();
  live.end(message("Before tool\n"));
  live.start();
  for (const suffix of ["", "A", "AB"]) {
    live.preview(message("🚀".repeat(9_000) + suffix), 0, suffix ? suffix.slice(-1) : undefined);
  }
  live.end(message("🚀".repeat(9_000) + "ABC"));
  const expected = "Before tool\n\n" + "🚀".repeat(1_023) + "…";
  await expectChatText(expected);
  expect(
    snapshots()
      .slice(1)
      .every((snapshot) => Buffer.byteLength(snapshot.text) <= 4_096),
  ).toBe(true);
  expect(snapshots().every((snapshot) => !snapshot.text.includes("\uFFFD"))).toBe(true);
  live.end(message("Short"));
  await expectChatText("Before tool\n\nShort");
  await live.finish();
});

it("does not resurrect a capped completed prefix when the active worker snapshot shrinks", async () => {
  const live = await liveProjection();
  const block = "x".repeat(16_000);
  let expectedText = "";
  for (let index = 0; index < 32; index += 1) {
    live.start();
    live.end(message(block));
    expectedText = `${expectedText}${index > 0 ? "\n\n" : ""}${block}`.slice(-500_000);
    await expectChatText(expectedText);
  }
  // The 31 paragraph separators leave 3,938 characters of the first item after capping.
  const retainedPrefix = "x".repeat(3_938) + ("\n\n" + "x".repeat(16_000)).repeat(30);
  await expectChatText(retainedPrefix + "\n\n" + "x".repeat(16_000));
  live.end(message("Short"));
  await expectChatText(retainedPrefix + "\n\nShort");
  live.end(message(""));
  await expectChatText(retainedPrefix);
  await live.finish();
});

it.each(["trailing", "leading"] as const)(
  "filters %s commentary without losing final text",
  async (position) => {
    const live = await liveProjection();
    live.start();
    const trailing = position === "trailing";
    const answer = signedText(
      trailing ? "Answer" : "Answer again",
      trailing ? "answer" : "final",
      "final_answer",
    );
    const commentary = signedText(
      trailing ? "Private commentary" : "Answer",
      "commentary",
      "commentary",
    );
    const content = trailing ? [answer, commentary] : [commentary, answer];
    live.preview(makeAgentAssistantMessage({ content: [trailing ? answer : commentary] }));
    if (trailing) {
      await expectChatText(answer.text);
    }
    const mixed = makeAgentAssistantMessage({ content });
    live.preview(mixed, 1);
    live.end(mixed);
    await live.finish(answer.text);
    if (trailing) {
      expect(
        snapshots()
          .map(({ text, delta }) => text + delta)
          .join(""),
      ).not.toContain(commentary.text);
    } else {
      expect(
        snapshots()
          .filter(({ phase }) => phase !== "commentary")
          .map(({ delta }) => delta)
          .join(""),
      ).toBe(answer.text);
    }
  },
);

it("recovers a missed worker preview by snapshot through reordered delivery and ACK replay", async () => {
  const gate = harness.addLiveEventGate("before-service", "preview");
  const live = await liveProjection();
  harness.addFault({ kind: "drop-response", method: "worker.live-event", restart: false });
  live.start();
  live.preview(message("Seen"));
  await gate.entered.promise;
  // The next source snapshot includes text whose incremental event was missed.
  live.preview(message("Seen plus recovered suffix"), 0, " suffix");
  live.end(message("Corrected"));
  gate.release.resolve();
  await live.finish("Corrected");
  expect(harness.connectionCount).toBeGreaterThan(1);
  expect(harness.liveDeltas.filter((delta) => delta === "Corrected")).toHaveLength(1);
});
