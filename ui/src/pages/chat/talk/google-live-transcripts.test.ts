import { describe, expect, it, vi } from "vitest";
import { waitForFast } from "../../../test-helpers/wait-for.ts";
import {
  createClient,
  createSession,
  flushMicrotasks,
  installGoogleLiveTestFixture,
  startTransport,
} from "./google-live.test-support.ts";
import { GoogleLiveRealtimeTalkTransport } from "./google-live.ts";
import { prepareRealtimeTalkTestInput } from "./input.test-support.ts";

const GOOGLE_LIVE_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";

async function startModel(model?: string) {
  const onTranscript = vi.fn();
  const onStatus = vi.fn();
  const transport = new GoogleLiveRealtimeTalkTransport(
    { ...createSession(GOOGLE_LIVE_URL), ...(model ? { model } : {}) },
    {
      input: await prepareRealtimeTalkTestInput(),
      callbacks: { onTranscript, onStatus },
      client: createClient(),
      sessionKey: "main",
    },
  );
  return { transport, ws: await startTransport(transport), onTranscript, onStatus };
}

describe("Google Live browser transcript finality", () => {
  installGoogleLiveTestFixture();

  it.each([
    { name: "default 3.1", model: undefined },
    { name: "3.8", model: "gemini-3.8-live" },
    { name: "3.8 Extended Thinking", model: "gemini-3.8-live-extended-thinking" },
    { name: "prefixed 3.8", model: "models/gemini-3.8-live" },
  ])("finalizes both live $name spoken turns before the session closes", async ({ model }) => {
    const { transport, ws, onTranscript } = await startModel(model);
    for (const [input, output] of [
      ["Please reply with the single word glacier.", "Glacier."],
      ["Now reply with the single word crystal.", "Crystal."],
    ]) {
      for (const serverContent of [
        { inputTranscription: { text: input } },
        { outputTranscription: { text: output } },
        { generationComplete: true },
        { turnComplete: true },
      ]) {
        ws.emitContent(serverContent);
        await flushMicrotasks();
      }
    }
    expect(onTranscript.mock.calls.map(([entry]) => entry).filter((entry) => entry.final)).toEqual([
      { role: "user", text: "Please reply with the single word glacier.", final: true },
      { role: "assistant", text: "Glacier.", final: true },
      { role: "user", text: "Now reply with the single word crystal.", final: true },
      { role: "assistant", text: "Crystal.", final: true },
    ]);
    expect(
      onTranscript.mock.calls
        .filter(([entry]) => entry.role === "user")
        .map(([entry]) => entry.final),
    ).toEqual([true, true]);
    ws.emitContent({ inputTranscription: { finished: true } });
    await flushMicrotasks();
    transport.stop();
    expect(onTranscript.mock.calls.filter(([entry]) => entry.final)).toHaveLength(4);
  });

  it("accumulates 2.5 fragments and honors a finish-only message", async () => {
    const { transport, ws, onTranscript } = await startModel(
      "gemini-2.5-flash-native-audio-preview-12-2025",
    );
    for (const transcription of [{ text: "Last " }, { text: "words" }, { finished: true }]) {
      ws.emitContent({ inputTranscription: transcription });
      await flushMicrotasks();
    }
    expect(onTranscript.mock.calls.map(([entry]) => entry)).toEqual([
      { role: "user", text: "Last ", final: false },
      { role: "user", text: "words", final: false },
      { role: "user", text: "Last words", final: true },
    ]);
    transport.stop();
  });

  const interrupted = { interrupted: true };
  const complete = { turnComplete: true };
  const nextInput = { inputTranscription: { text: "New question" } };
  it.each([
    ["before next input", [interrupted, complete, nextInput]],
    ["after next input", [interrupted, nextInput, complete]],
    ["in interruption frame", [{ ...interrupted, ...complete }, nextInput]],
  ] as const)(
    "preserves interrupted speech and the next utterance when completion arrives %s",
    async (_name, boundary) => {
      const { transport, ws, onTranscript } = await startModel();
      for (const serverContent of [
        { outputTranscription: { text: "Interrupted " } },
        { outputTranscription: { text: "response" } },
        ...boundary,
        { outputTranscription: { text: "Next response", finished: true } },
        { turnComplete: true },
      ]) {
        ws.emitContent(serverContent);
        await flushMicrotasks();
      }
      expect(
        onTranscript.mock.calls.filter(([entry]) => entry.final).map(([entry]) => entry.text),
      ).toEqual(["Interrupted response", "New question", "Next response"]);
      transport.stop();
      expect(onTranscript.mock.calls.filter(([entry]) => entry.final)).toHaveLength(3);
    },
  );

  it("releases the UTF-8 transcript budget on finality and closes on overflow without persisting a partial", async () => {
    const { ws, onTranscript, onStatus } = await startModel();
    const atLimit = "é".repeat(128 * 1024);
    for (const outputTranscription of [
      { text: atLimit },
      { finished: true },
      { text: atLimit },
      { text: "é" },
      { finished: true },
    ]) {
      ws.emitContent({ outputTranscription });
      await flushMicrotasks();
    }
    expect(
      onTranscript.mock.calls.filter(([entry]) => entry.final).map(([entry]) => entry.text),
    ).toEqual([atLimit]);
    expect(onTranscript).toHaveBeenCalledTimes(3);
    expect(onStatus).toHaveBeenCalledWith(
      "error",
      "Google Live transcript exceeded the 256 KiB UTF-8 pending buffer limit",
    );
    expect(ws.readyState).toBe(3);
  });

  it("stays active across a filler utterance and tool call", async () => {
    const { transport, ws, onTranscript } = await startModel("gemini-3.8-live-extended-thinking");

    ws.emitContent({
      outputTranscription: { text: "Checking now." },
      turnComplete: true,
      interactionStatus: "IN_PROGRESS",
    });
    await waitForFast(() =>
      expect(onTranscript).toHaveBeenLastCalledWith({
        role: "assistant",
        text: "Checking now.",
        final: true,
      }),
    );

    ws.emitCalls({ id: "call-unknown", name: "unknown_tool", args: {} });
    await waitForFast(() =>
      expect(ws.messages).toContainEqual({
        toolResponse: {
          functionResponses: [
            {
              id: "call-unknown",
              name: "unknown_tool",
              response: { error: 'Tool "unknown_tool" is not available in browser Talk' },
            },
          ],
        },
      }),
    );
    expect(ws.readyState).toBe(1);

    ws.emitContent({
      outputTranscription: { text: "The answer is 42." },
      turnComplete: true,
      interactionStatus: "IDLE",
    });
    await waitForFast(() =>
      expect(onTranscript).toHaveBeenLastCalledWith({
        role: "assistant",
        text: "The answer is 42.",
        final: true,
      }),
    );
    expect(ws.readyState).toBe(1);
    transport.stop();
  });
});
