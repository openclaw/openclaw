import { describe, expect, it, vi } from "vitest";
import {
  createClient,
  createSession,
  createTransport,
  encodeJsonFrame,
  flushMicrotasks,
  installGoogleLiveTestFixture,
  startTransport,
} from "./google-live.test-support.ts";
import { GoogleLiveRealtimeTalkTransport } from "./google-live.ts";
import { prepareRealtimeTalkTestInput } from "./input.test-support.ts";
import type { RealtimeTalkTransportContext } from "./shared.ts";

const GOOGLE_LIVE_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";

async function createModelTransport(
  model: string | undefined,
  callbacks: RealtimeTalkTransportContext["callbacks"],
) {
  return new GoogleLiveRealtimeTalkTransport(
    { ...createSession(GOOGLE_LIVE_URL), ...(model ? { model } : {}) },
    {
      input: await prepareRealtimeTalkTestInput(),
      callbacks,
      client: createClient(),
      sessionKey: "main",
    },
  );
}

describe("Google Live browser transcript finality", () => {
  installGoogleLiveTestFixture();

  it.each([
    { name: "default 3.1", model: undefined },
    { name: "3.8", model: "gemini-3.8-live" },
    { name: "3.8 Extended Thinking", model: "gemini-3.8-live-extended-thinking" },
    { name: "prefixed 3.8", model: "models/gemini-3.8-live" },
  ])("finalizes both live $name spoken turns before the session closes", async ({ model }) => {
    const onTranscript = vi.fn();
    const transport = await createModelTransport(model, { onTranscript });
    const ws = await startTransport(transport);
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
        ws.emitMessage(encodeJsonFrame({ serverContent }));
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
    ws.emitMessage(encodeJsonFrame({ serverContent: { inputTranscription: { finished: true } } }));
    await flushMicrotasks();
    transport.stop();
    expect(onTranscript.mock.calls.filter(([entry]) => entry.final)).toHaveLength(4);
  });

  it("accumulates 2.5 fragments and honors a finish-only message", async () => {
    const onTranscript = vi.fn();
    const transport = await createModelTransport("gemini-2.5-flash-native-audio-preview-12-2025", {
      onTranscript,
    });
    const ws = await startTransport(transport);
    for (const transcription of [{ text: "Last " }, { text: "words" }, { finished: true }]) {
      ws.emitMessage(encodeJsonFrame({ serverContent: { inputTranscription: transcription } }));
      await flushMicrotasks();
    }
    expect(onTranscript.mock.calls.map(([entry]) => entry)).toEqual([
      { role: "user", text: "Last ", final: false },
      { role: "user", text: "words", final: false },
      { role: "user", text: "Last words", final: true },
    ]);
    transport.stop();
  });

  it.each([
    {
      name: "before the next input transcript",
      boundary: [
        { interrupted: true },
        { turnComplete: true },
        { inputTranscription: { text: "New question" } },
      ],
    },
    {
      name: "after an independently ordered input transcript",
      boundary: [
        { interrupted: true },
        { inputTranscription: { text: "New question" } },
        { turnComplete: true },
      ],
    },
    {
      name: "in the interruption frame",
      boundary: [
        { interrupted: true, turnComplete: true },
        { inputTranscription: { text: "New question" } },
      ],
    },
  ])(
    "preserves interrupted speech and the next utterance when completion arrives $name",
    async ({ boundary }) => {
      const onTranscript = vi.fn();
      const transport = await createTransport({ onTranscript });
      const ws = await startTransport(transport);
      for (const serverContent of [
        { outputTranscription: { text: "Interrupted " } },
        { outputTranscription: { text: "response" } },
        ...boundary,
        { outputTranscription: { text: "Next response", finished: true } },
        { turnComplete: true },
      ]) {
        ws.emitMessage(encodeJsonFrame({ serverContent }));
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
    const onTranscript = vi.fn();
    const onStatus = vi.fn();
    const transport = await createTransport({ onTranscript, onStatus });
    const ws = await startTransport(transport);
    const atLimit = "é".repeat(128 * 1024);
    for (const outputTranscription of [
      { text: atLimit },
      { finished: true },
      { text: atLimit },
      { text: "é" },
      { finished: true },
    ]) {
      ws.emitMessage(encodeJsonFrame({ serverContent: { outputTranscription } }));
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
});
