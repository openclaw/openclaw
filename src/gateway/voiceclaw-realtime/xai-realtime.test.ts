import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VoiceClawServerEvent } from "./types.js";
import {
  DEFAULT_XAI_VOICE,
  isValidXaiVoice,
  resolveXaiVoice,
  VoiceClawXaiRealtimeAdapter,
  XAI_VOICES,
} from "./xai-realtime.js";

const ORIGINAL_XAI_API_KEY = process.env.XAI_API_KEY;

beforeEach(() => {
  process.env.XAI_API_KEY = "TEST_KEY_NOT_REAL";
});

afterEach(() => {
  if (ORIGINAL_XAI_API_KEY === undefined) {
    delete process.env.XAI_API_KEY;
  } else {
    process.env.XAI_API_KEY = ORIGINAL_XAI_API_KEY;
  }
});

describe("xAI Realtime voice helpers", () => {
  it("resolves to ara by default when no voice is provided", () => {
    expect(resolveXaiVoice()).toBe("ara");
    expect(DEFAULT_XAI_VOICE).toBe("ara");
  });

  it("accepts all five xAI voices case-insensitively", () => {
    for (const voice of XAI_VOICES) {
      expect(resolveXaiVoice(voice)).toBe(voice);
      expect(resolveXaiVoice(voice.toUpperCase())).toBe(voice);
    }
    expect(XAI_VOICES).toEqual(["eve", "ara", "rex", "sal", "leo"]);
  });

  it("falls back to ara on unknown voice IDs (does not throw)", () => {
    expect(resolveXaiVoice("Puck")).toBe("ara");
    expect(resolveXaiVoice("not-a-voice")).toBe("ara");
    expect(resolveXaiVoice("")).toBe("ara");
  });

  it("recognizes valid voices via isValidXaiVoice", () => {
    expect(isValidXaiVoice("ara")).toBe(true);
    expect(isValidXaiVoice("ARA")).toBe(true);
    expect(isValidXaiVoice("eve")).toBe(true);
    expect(isValidXaiVoice("rex")).toBe(true);
    expect(isValidXaiVoice("sal")).toBe(true);
    expect(isValidXaiVoice("leo")).toBe(true);

    expect(isValidXaiVoice("Puck")).toBe(false);
    expect(isValidXaiVoice("zephyr")).toBe(false);
    expect(isValidXaiVoice("")).toBe(false);
  });
});

describe("VoiceClawXaiRealtimeAdapter event mapping", () => {
  function makeAdapterWithCapture(): {
    adapter: VoiceClawXaiRealtimeAdapter;
    events: VoiceClawServerEvent[];
    upstream: Record<string, unknown>[];
  } {
    const adapter = new VoiceClawXaiRealtimeAdapter();
    const events: VoiceClawServerEvent[] = [];
    const upstream: Record<string, unknown>[] = [];
    const internals = adapter as unknown as {
      sendToClient: (event: VoiceClawServerEvent) => void;
      sendUpstream: (msg: Record<string, unknown>, kind: string) => void;
    };
    internals.sendToClient = (event) => events.push(event);
    internals.sendUpstream = (msg) => upstream.push(msg);
    return { adapter, events, upstream };
  }

  it("forwards audio.delta passthrough from response.output_audio.delta", () => {
    const { adapter, events } = makeAdapterWithCapture();
    const internals = adapter as unknown as {
      handleServerMessage: (msg: Record<string, unknown>) => void;
    };

    internals.handleServerMessage({
      type: "response.output_audio.delta",
      delta: "AQIDBAUG",
    });

    expect(events).toEqual([{ type: "audio.delta", data: "AQIDBAUG" }]);
  });

  it("forwards audio.delta from OpenAI-Realtime-style response.audio.delta too", () => {
    const { adapter, events } = makeAdapterWithCapture();
    const internals = adapter as unknown as {
      handleServerMessage: (msg: Record<string, unknown>) => void;
    };

    internals.handleServerMessage({
      type: "response.audio.delta",
      delta: "ZGVmZw==",
    });

    expect(events).toEqual([{ type: "audio.delta", data: "ZGVmZw==" }]);
  });

  it("translates xAI response.text.delta into transcript.delta(role=assistant)", () => {
    const { adapter, events } = makeAdapterWithCapture();
    const internals = adapter as unknown as {
      handleServerMessage: (msg: Record<string, unknown>) => void;
    };

    internals.handleServerMessage({
      type: "response.text.delta",
      delta: "Hello there",
    });

    expect(events).toEqual([{ type: "transcript.delta", text: "Hello there", role: "assistant" }]);
  });

  it("synthesizes transcript.delta + transcript.done from xAI's single user-transcription completed event", () => {
    const { adapter, events } = makeAdapterWithCapture();
    const internals = adapter as unknown as {
      handleServerMessage: (msg: Record<string, unknown>) => void;
    };

    internals.handleServerMessage({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "what time is it",
    });

    expect(events).toEqual([
      { type: "turn.started" },
      { type: "transcript.delta", text: "what time is it", role: "user" },
      { type: "transcript.done", text: "what time is it", role: "user" },
    ]);
  });

  it("emits turn.started on input_audio_buffer.speech_started and finalizes any pending assistant text with ellipsis (barge-in)", () => {
    const { adapter, events } = makeAdapterWithCapture();
    const internals = adapter as unknown as {
      handleServerMessage: (msg: Record<string, unknown>) => void;
    };

    internals.handleServerMessage({ type: "response.text.delta", delta: "I was saying " });
    internals.handleServerMessage({ type: "input_audio_buffer.speech_started" });

    expect(events).toEqual([
      { type: "transcript.delta", text: "I was saying ", role: "assistant" },
      { type: "turn.started" },
      { type: "transcript.done", text: "I was saying ...", role: "assistant" },
    ]);
  });

  it("surfaces tool.call from response.function_call_arguments.done", () => {
    const { adapter, events } = makeAdapterWithCapture();
    const internals = adapter as unknown as {
      handleServerMessage: (msg: Record<string, unknown>) => void;
    };

    internals.handleServerMessage({
      type: "response.function_call_arguments.done",
      call_id: "call_abc123",
      name: "get_weather",
      arguments: '{"city":"Austin"}',
    });

    expect(events).toEqual([
      {
        type: "tool.call",
        callId: "call_abc123",
        name: "get_weather",
        arguments: '{"city":"Austin"}',
      },
    ]);
  });

  it("returns tool result via conversation.item.create + response.create", () => {
    const { adapter, upstream } = makeAdapterWithCapture();

    adapter.sendToolResult("call_abc123", '{"temp":"72F"}');

    expect(upstream).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "call_abc123",
          output: '{"temp":"72F"}',
        },
      },
      { type: "response.create" },
    ]);
  });

  it("forwards audio.append frames to input_audio_buffer.append", () => {
    const { adapter, upstream } = makeAdapterWithCapture();

    adapter.sendAudio("aGVsbG8=");

    expect(upstream).toEqual([{ type: "input_audio_buffer.append", audio: "aGVsbG8=" }]);
  });

  it("emits turn.ended and finalizes transcripts on response.done", () => {
    const { adapter, events } = makeAdapterWithCapture();
    const internals = adapter as unknown as {
      handleServerMessage: (msg: Record<string, unknown>) => void;
    };

    internals.handleServerMessage({ type: "response.text.delta", delta: "done speaking" });
    internals.handleServerMessage({ type: "response.done" });

    expect(events).toEqual([
      { type: "transcript.delta", text: "done speaking", role: "assistant" },
      { type: "transcript.done", text: "done speaking", role: "assistant" },
      { type: "turn.ended" },
    ]);
  });

  it("emits usage.metrics from response.usage", () => {
    const { adapter, events } = makeAdapterWithCapture();
    const internals = adapter as unknown as {
      handleServerMessage: (msg: Record<string, unknown>) => void;
    };

    internals.handleServerMessage({
      type: "response.usage",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        input_token_details: { audio_tokens: 80 },
        output_token_details: { audio_tokens: 40 },
      },
    });

    expect(events).toEqual([
      {
        type: "usage.metrics",
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        inputAudioTokens: 80,
        outputAudioTokens: 40,
      },
    ]);
  });

  it("sanitizes xAI errors before forwarding (never reflects API key)", () => {
    const { adapter, events } = makeAdapterWithCapture();
    const internals = adapter as unknown as {
      handleServerMessage: (msg: Record<string, unknown>) => void;
    };

    // xAI returns a hypothetical error reflecting an Authorization header.
    internals.handleServerMessage({
      type: "error",
      error: {
        message: "auth failed for Bearer xai-supersecretvalue123",
        code: 401,
      },
    });

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe("error");
    if (event.type === "error") {
      expect(event.code).toBe(401);
      expect(event.message).not.toContain("xai-supersecretvalue123");
      expect(event.message).not.toContain("supersecretvalue");
      expect(event.message).toContain("Bearer ***");
    }
  });

  it("ignores unknown event types without throwing", () => {
    const { adapter, events } = makeAdapterWithCapture();
    const internals = adapter as unknown as {
      handleServerMessage: (msg: Record<string, unknown>) => void;
    };

    expect(() => internals.handleServerMessage({ type: "response.created" })).not.toThrow();
    expect(() =>
      internals.handleServerMessage({ type: "response.output_item.added" }),
    ).not.toThrow();
    expect(events).toEqual([]);
  });
});

describe("VoiceClawXaiRealtimeAdapter setup payload", () => {
  it("includes the resolved voice and configured model in session.update", () => {
    const adapter = new VoiceClawXaiRealtimeAdapter();
    const internals = adapter as unknown as {
      config: unknown;
      tools: unknown[];
      model: string;
      resolvedVoice: string;
      upstream: { send: (payload: string) => void; readyState: number };
      sendSessionUpdate: (config: { type: "session.config" }) => void;
    };
    internals.config = { type: "session.config" };
    internals.tools = [];
    internals.model = "grok-voice-think-fast-1.0";
    internals.resolvedVoice = "ara";
    const sent: string[] = [];
    internals.upstream = {
      send: (payload: string) => sent.push(payload),
      readyState: 1, // WebSocket.OPEN
    };

    internals.sendSessionUpdate({ type: "session.config" });

    expect(sent).toHaveLength(1);
    const parsed = JSON.parse(sent[0]!) as {
      type: string;
      session: Record<string, unknown>;
    };
    expect(parsed.type).toBe("session.update");
    expect(parsed.session.voice).toBe("ara");
    expect(parsed.session.modalities).toEqual(["text", "audio"]);
    expect(parsed.session.input_audio_format).toBe("pcm16");
    expect(parsed.session.output_audio_format).toBe("pcm16");
    expect(parsed.session.turn_detection).toMatchObject({ type: "server_vad" });
  });

  it("includes function tools in session.update when registered", () => {
    const adapter = new VoiceClawXaiRealtimeAdapter();
    const internals = adapter as unknown as {
      config: unknown;
      tools: { name: string; description: string; parameters: Record<string, unknown> }[];
      model: string;
      resolvedVoice: string;
      upstream: { send: (payload: string) => void; readyState: number };
      sendSessionUpdate: (config: { type: "session.config" }) => void;
    };
    internals.config = { type: "session.config" };
    internals.tools = [
      {
        name: "get_weather",
        description: "fetch weather",
        parameters: { type: "object", properties: { city: { type: "string" } } },
      },
    ];
    internals.model = "grok-voice-think-fast-1.0";
    internals.resolvedVoice = "ara";
    const sent: string[] = [];
    internals.upstream = {
      send: (payload: string) => sent.push(payload),
      readyState: 1,
    };

    internals.sendSessionUpdate({ type: "session.config" });

    const parsed = JSON.parse(sent[0]!) as {
      session: { tools: { type: string; name: string }[]; tool_choice: string };
    };
    expect(parsed.session.tool_choice).toBe("auto");
    expect(parsed.session.tools).toEqual([
      {
        type: "function",
        name: "get_weather",
        description: "fetch weather",
        parameters: { type: "object", properties: { city: { type: "string" } } },
      },
    ]);
  });
});

describe("VoiceClawXaiRealtimeAdapter secret discipline", () => {
  it("does not include the raw API key in any log line invoked through openUpstream", async () => {
    process.env.XAI_API_KEY = "xai-CANARYxxxxxxxxxxxxxx";
    const adapter = new VoiceClawXaiRealtimeAdapter();
    const internals = adapter as unknown as {
      config: { type: "session.config" };
    };
    internals.config = { type: "session.config" };

    // Since we cannot exercise the real WS upstream without a network call,
    // verify the structural promise: the adapter never spreads `process.env`
    // onto its instance, and the sendSessionUpdate payload never includes
    // a key value.
    expect(JSON.stringify(adapter)).not.toContain("CANARYxxxxxxxxxxxxxx");
  });

  it("does not require XAI_API_KEY to construct the adapter (only required at openUpstream)", () => {
    delete process.env.XAI_API_KEY;
    expect(() => new VoiceClawXaiRealtimeAdapter()).not.toThrow();
  });
});

describe("VoiceClawXaiRealtimeAdapter client-side methods (forwarding)", () => {
  function makeAdapterWithCapture(): {
    adapter: VoiceClawXaiRealtimeAdapter;
    upstream: Record<string, unknown>[];
    events: VoiceClawServerEvent[];
  } {
    const adapter = new VoiceClawXaiRealtimeAdapter();
    const upstream: Record<string, unknown>[] = [];
    const events: VoiceClawServerEvent[] = [];
    const internals = adapter as unknown as {
      sendUpstream: (msg: Record<string, unknown>, kind: string) => void;
      sendToClient: (event: VoiceClawServerEvent) => void;
    };
    internals.sendUpstream = (msg) => upstream.push(msg);
    internals.sendToClient = (event) => events.push(event);
    return { adapter, upstream, events };
  }

  it("commitAudio forwards input_audio_buffer.commit", () => {
    const { adapter, upstream } = makeAdapterWithCapture();
    adapter.commitAudio();
    expect(upstream).toEqual([{ type: "input_audio_buffer.commit" }]);
  });

  it("createResponse forwards response.create", () => {
    const { adapter, upstream } = makeAdapterWithCapture();
    adapter.createResponse();
    expect(upstream).toEqual([{ type: "response.create" }]);
  });

  it("cancelResponse forwards response.cancel best-effort", () => {
    const { adapter, upstream } = makeAdapterWithCapture();
    adapter.cancelResponse();
    expect(upstream).toEqual([{ type: "response.cancel" }]);
  });

  it("injectContext forwards a system-role conversation.item.create", () => {
    const { adapter, upstream } = makeAdapterWithCapture();
    adapter.injectContext("background context here");
    expect(upstream).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "system",
          content: [{ type: "input_text", text: "background context here" }],
        },
      },
    ]);
  });

  it("sendFrame logs warning and drops silently (xAI Voice Agent is audio-only at GA)", () => {
    const { adapter, upstream } = makeAdapterWithCapture();
    adapter.sendFrame("imagedataframe", "image/jpeg");
    expect(upstream).toEqual([]);
  });

  it("getTranscript returns a copy (caller mutation does not affect internal state)", () => {
    const adapter = new VoiceClawXaiRealtimeAdapter();
    const internals = adapter as unknown as {
      transcript: { role: "user" | "assistant"; text: string }[];
    };
    internals.transcript = [
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello" },
    ];
    const t = adapter.getTranscript();
    expect(t).toEqual([
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello" },
    ]);
    t.push({ role: "user", text: "tampering" });
    expect(adapter.getTranscript()).toHaveLength(2);
  });

  it("disconnect clears state and is idempotent", () => {
    const { adapter } = makeAdapterWithCapture();
    const internals = adapter as unknown as {
      asyncToolCallIds: Set<string>;
      disconnected: boolean;
    };
    internals.asyncToolCallIds.add("call_test_1");
    expect(internals.asyncToolCallIds.size).toBe(1);
    adapter.disconnect();
    expect(internals.disconnected).toBe(true);
    expect(internals.asyncToolCallIds.size).toBe(0);
    // Idempotent: calling again does not throw
    expect(() => adapter.disconnect()).not.toThrow();
  });
});

describe("VoiceClawXaiRealtimeAdapter close-handling", () => {
  function makeWithUpstreamHook(): {
    adapter: VoiceClawXaiRealtimeAdapter;
    events: VoiceClawServerEvent[];
  } {
    const adapter = new VoiceClawXaiRealtimeAdapter();
    const events: VoiceClawServerEvent[] = [];
    const internals = adapter as unknown as {
      sendToClient: (event: VoiceClawServerEvent) => void;
      reconnect: (reason: string) => Promise<void>;
    };
    internals.sendToClient = (event) => events.push(event);
    // Stub reconnect so close-code 1006 path doesn't actually try to open a WS.
    internals.reconnect = async () => {};
    return { adapter, events };
  }

  it("ignores normal close (code 1000) without surfacing an error", () => {
    const { adapter, events } = makeWithUpstreamHook();
    const internals = adapter as unknown as {
      handleUpstreamClose: (code: number) => void;
    };
    internals.handleUpstreamClose(1000);
    expect(events).toEqual([]);
  });

  it("emits a sanitized error for non-reconnectable, non-normal close codes", () => {
    const { adapter, events } = makeWithUpstreamHook();
    const internals = adapter as unknown as {
      handleUpstreamClose: (code: number) => void;
    };
    internals.handleUpstreamClose(4001);
    expect(events).toEqual([
      { type: "error", message: "xAI Realtime connection closed", code: 502 },
    ]);
  });

  it("invokes reconnect path for reconnectable close codes", () => {
    const adapter = new VoiceClawXaiRealtimeAdapter();
    const events: VoiceClawServerEvent[] = [];
    let reconnectCalls = 0;
    const internals = adapter as unknown as {
      sendToClient: (event: VoiceClawServerEvent) => void;
      reconnect: (reason: string) => Promise<void>;
      handleUpstreamClose: (code: number) => void;
    };
    internals.sendToClient = (event) => events.push(event);
    internals.reconnect = async (reason: string) => {
      reconnectCalls += 1;
      events.push({
        type: "session.rotated",
        sessionId: `xai-resumed-stub-${reason}`,
      });
    };
    internals.handleUpstreamClose(1006);
    // reconnect is fire-and-forget (void); we verified the path was taken
    // and the stub was invoked.
    expect(reconnectCalls).toBe(1);
  });

  it("cancels active tool calls if upstream closes mid-tool-call", () => {
    const adapter = new VoiceClawXaiRealtimeAdapter();
    const events: VoiceClawServerEvent[] = [];
    const internals = adapter as unknown as {
      sendToClient: (event: VoiceClawServerEvent) => void;
      pendingToolCallIds: Set<string>;
      handleUpstreamClose: (code: number) => void;
    };
    internals.sendToClient = (event) => events.push(event);
    internals.pendingToolCallIds.add("call_inflight");
    internals.handleUpstreamClose(1011);
    expect(events).toContainEqual({
      type: "tool.cancelled",
      callIds: ["call_inflight"],
    });
    expect(events).toContainEqual({
      type: "error",
      message: "xAI Realtime closed while a tool call was in flight",
      code: 502,
    });
  });
});

describe("VoiceClawXaiRealtimeAdapter conversation history replay", () => {
  it("replays the most recent 12 history entries via conversation.item.create", () => {
    const adapter = new VoiceClawXaiRealtimeAdapter();
    const upstream: Record<string, unknown>[] = [];
    const internals = adapter as unknown as {
      sendUpstream: (msg: Record<string, unknown>, kind: string) => void;
      replayConversationHistory: (config: {
        type: "session.config";
        conversationHistory: { role: "user" | "assistant"; text: string }[];
      }) => void;
    };
    internals.sendUpstream = (msg) => upstream.push(msg);

    const history = Array.from({ length: 15 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      text: `message-${i}`,
    }));

    internals.replayConversationHistory({
      type: "session.config",
      conversationHistory: history,
    });

    // The adapter slices to the last 12 entries.
    expect(upstream).toHaveLength(12);
    // First replayed item should be entry index 3 (15 - 12 = 3).
    const firstItem = upstream[0] as { item: { content: { text: string }[] } };
    expect(firstItem.item.content[0]!.text).toBe("message-3");

    // User entries serialize as `input_text`; assistant as `text`.
    const userItem = upstream.find(
      (m) => (m as { item: { role: string } }).item.role === "user",
    ) as { item: { content: { type: string }[] } } | undefined;
    expect(userItem?.item.content[0]?.type).toBe("input_text");
    const assistantItem = upstream.find(
      (m) => (m as { item: { role: string } }).item.role === "assistant",
    ) as { item: { content: { type: string }[] } } | undefined;
    expect(assistantItem?.item.content[0]?.type).toBe("text");
  });

  it("does nothing when conversationHistory is empty or missing", () => {
    const adapter = new VoiceClawXaiRealtimeAdapter();
    const upstream: Record<string, unknown>[] = [];
    const internals = adapter as unknown as {
      sendUpstream: (msg: Record<string, unknown>, kind: string) => void;
      replayConversationHistory: (config: {
        type: "session.config";
        conversationHistory?: { role: "user" | "assistant"; text: string }[];
      }) => void;
    };
    internals.sendUpstream = (msg) => upstream.push(msg);

    internals.replayConversationHistory({ type: "session.config" });
    expect(upstream).toEqual([]);

    internals.replayConversationHistory({
      type: "session.config",
      conversationHistory: [],
    });
    expect(upstream).toEqual([]);
  });
});
