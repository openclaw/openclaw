import { describe, expect, it, vi } from "vitest";
import { AGENT_LANE_NESTED } from "../../agents/lanes.js";

const MAX_NESTED_TRANSCRIPT_TEXT_CHARS = 8_000;
const MAX_NESTED_TRANSCRIPT_MEDIA_URLS = 16;
const mockAppendTranscript = vi
  .fn()
  .mockResolvedValue({ ok: true, sessionFile: "/tmp/test.jsonl" });
vi.mock("../../config/sessions.js", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    appendAssistantMessageToSessionTranscript: (...args: unknown[]) =>
      mockAppendTranscript(...args),
  };
});

// Stub outbound delivery infra so we don't need real config/plugins.
vi.mock("../../infra/outbound/agent-delivery.js", () => ({
  resolveAgentDeliveryPlan: () => ({
    resolvedChannel: "internal",
    resolvedTo: null,
    resolvedAccountId: null,
    resolvedThreadId: null,
    deliveryTargetMode: undefined,
  }),
  resolveAgentOutboundTarget: () => ({
    resolvedTarget: null,
    resolvedTo: null,
    targetMode: "implicit",
  }),
}));
vi.mock("../../infra/outbound/channel-selection.js", () => ({
  resolveMessageChannelSelection: vi.fn(),
}));
vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: vi.fn(),
}));
vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: () => undefined,
  normalizeChannelId: (id: string) => id,
}));

import { deliverAgentCommandResult } from "./delivery.js";

function makeRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
  };
}

function makeDeps() {
  return {} as Parameters<typeof deliverAgentCommandResult>[0]["deps"];
}

function makeCfg() {
  return {} as Parameters<typeof deliverAgentCommandResult>[0]["cfg"];
}

describe("deliverAgentCommandResult – transcript mirror", () => {
  it("writes to child session transcript when deliver=false and lane=nested", async () => {
    mockAppendTranscript.mockClear();
    mockAppendTranscript.mockResolvedValue({ ok: true, sessionFile: "/tmp/test.jsonl" });
    const runtime = makeRuntime();
    await deliverAgentCommandResult({
      cfg: makeCfg(),
      deps: makeDeps(),
      runtime,
      opts: {
        message: "test",
        deliver: false,
        lane: AGENT_LANE_NESTED,
        sessionKey: "child-session-abc",
        inputProvenance: { kind: "inter_session" },
      },
      outboundSession: undefined,
      sessionEntry: undefined,
      result: { payloads: [{ text: "Hello from agent", mediaUrls: [] }], meta: {} as never },
      payloads: [{ text: "Hello from agent", mediaUrls: [] }],
    });

    expect(mockAppendTranscript).toHaveBeenCalledOnce();
    expect(mockAppendTranscript).toHaveBeenCalledWith({
      sessionKey: "child-session-abc",
      text: "Hello from agent",
      mediaUrls: undefined,
      agentId: undefined,
    });
  });

  it("does NOT call appendAssistantMessageToSessionTranscript when deliver=true", async () => {
    mockAppendTranscript.mockClear();
    mockAppendTranscript.mockResolvedValue({ ok: true, sessionFile: "/tmp/test.jsonl" });
    const runtime = makeRuntime();
    // deliver=true but with internal channel → will throw; wrap to catch.
    try {
      await deliverAgentCommandResult({
        cfg: makeCfg(),
        deps: makeDeps(),
        runtime,
        opts: {
          message: "test",
          deliver: true,
          lane: AGENT_LANE_NESTED,
          sessionKey: "child-session-abc",
          inputProvenance: { kind: "inter_session" },
        },
        outboundSession: undefined,
        sessionEntry: undefined,
        result: { payloads: [{ text: "response", mediaUrls: [] }], meta: {} as never },
        payloads: [{ text: "response", mediaUrls: [] }],
      });
    } catch {
      // expected – delivery channel is required error
    }

    expect(mockAppendTranscript).not.toHaveBeenCalled();
  });

  it("does NOT call appendAssistantMessageToSessionTranscript when lane is not nested", async () => {
    mockAppendTranscript.mockClear();
    mockAppendTranscript.mockResolvedValue({ ok: true, sessionFile: "/tmp/test.jsonl" });
    const runtime = makeRuntime();
    await deliverAgentCommandResult({
      cfg: makeCfg(),
      deps: makeDeps(),
      runtime,
      opts: {
        message: "test",
        deliver: false,
        lane: undefined,
        sessionKey: "child-session-abc",
      },
      outboundSession: undefined,
      sessionEntry: undefined,
      result: { payloads: [{ text: "response", mediaUrls: [] }], meta: {} as never },
      payloads: [{ text: "response", mediaUrls: [] }],
    });

    expect(mockAppendTranscript).not.toHaveBeenCalled();
  });

  it("includes mediaUrls when present", async () => {
    mockAppendTranscript.mockClear();
    mockAppendTranscript.mockResolvedValue({ ok: true, sessionFile: "/tmp/test.jsonl" });
    const runtime = makeRuntime();
    await deliverAgentCommandResult({
      cfg: makeCfg(),
      deps: makeDeps(),
      runtime,
      opts: {
        message: "test",
        deliver: false,
        lane: AGENT_LANE_NESTED,
        sessionKey: "session-media",
        inputProvenance: { kind: "inter_session" },
      },
      outboundSession: undefined,
      sessionEntry: undefined,
      result: {
        payloads: [{ text: "pic", mediaUrls: ["https://example.com/img.png"] }],
        meta: {} as never,
      },
      payloads: [{ text: "pic", mediaUrls: ["https://example.com/img.png"] }],
    });

    expect(mockAppendTranscript).toHaveBeenCalledOnce();
    expect(mockAppendTranscript).toHaveBeenCalledWith({
      sessionKey: "session-media",
      text: "pic",
      mediaUrls: ["https://example.com/img.png"],
      agentId: undefined,
    });
  });

  it("caps mirrored text and media urls before appending transcript", async () => {
    mockAppendTranscript.mockClear();
    mockAppendTranscript.mockResolvedValue({ ok: true, sessionFile: "/tmp/test.jsonl" });
    const runtime = makeRuntime();
    const oversizedText = "x".repeat(MAX_NESTED_TRANSCRIPT_TEXT_CHARS + 50);
    const mediaUrls = Array.from({ length: MAX_NESTED_TRANSCRIPT_MEDIA_URLS + 5 }, (_, index) => {
      return `https://example.com/media-${index}.png`;
    });

    await deliverAgentCommandResult({
      cfg: makeCfg(),
      deps: makeDeps(),
      runtime,
      opts: {
        message: "test",
        deliver: false,
        lane: AGENT_LANE_NESTED,
        sessionKey: "session-capped",
        inputProvenance: { kind: "inter_session" },
      },
      outboundSession: undefined,
      sessionEntry: undefined,
      result: {
        payloads: [{ text: oversizedText, mediaUrls }],
        meta: {} as never,
      },
      payloads: [{ text: oversizedText, mediaUrls }],
    });

    expect(mockAppendTranscript).toHaveBeenCalledOnce();
    expect(mockAppendTranscript).toHaveBeenCalledWith({
      agentId: undefined,
      sessionKey: "session-capped",
      text: `${"x".repeat(MAX_NESTED_TRANSCRIPT_TEXT_CHARS - "\n\n[truncated]".length)}\n\n[truncated]`,
      mediaUrls: mediaUrls.slice(0, MAX_NESTED_TRANSCRIPT_MEDIA_URLS),
    });
  });

  it("resolves mirror agentId from outbound session context before opts.agentId", async () => {
    mockAppendTranscript.mockClear();
    mockAppendTranscript.mockResolvedValue({ ok: true, sessionFile: "/tmp/test.jsonl" });
    const runtime = makeRuntime();

    await deliverAgentCommandResult({
      cfg: makeCfg(),
      deps: makeDeps(),
      runtime,
      opts: {
        message: "test",
        agentId: "wrong-fallback",
        deliver: false,
        lane: AGENT_LANE_NESTED,
        sessionKey: "agent:main:child-session",
        inputProvenance: { kind: "inter_session" },
      },
      outboundSession: {
        key: "agent:ops:child-session",
        agentId: "ops",
      },
      sessionEntry: undefined,
      result: { payloads: [{ text: "agent reply", mediaUrls: [] }], meta: {} as never },
      payloads: [{ text: "agent reply", mediaUrls: [] }],
    });

    expect(mockAppendTranscript).toHaveBeenCalledWith({
      agentId: "ops",
      sessionKey: "agent:ops:child-session",
      text: "agent reply",
      mediaUrls: undefined,
    });
  });

  it("resolves mirror agentId from session key when outbound session agentId is missing", async () => {
    mockAppendTranscript.mockClear();
    mockAppendTranscript.mockResolvedValue({ ok: true, sessionFile: "/tmp/test.jsonl" });
    const runtime = makeRuntime();

    await deliverAgentCommandResult({
      cfg: makeCfg(),
      deps: makeDeps(),
      runtime,
      opts: {
        message: "test",
        deliver: false,
        lane: AGENT_LANE_NESTED,
        sessionKey: "agent:research:thread:123",
        inputProvenance: { kind: "inter_session" },
      },
      outboundSession: undefined,
      sessionEntry: undefined,
      result: { payloads: [{ text: "agent reply", mediaUrls: [] }], meta: {} as never },
      payloads: [{ text: "agent reply", mediaUrls: [] }],
    });

    expect(mockAppendTranscript).toHaveBeenCalledWith({
      agentId: "research",
      sessionKey: "agent:research:thread:123",
      text: "agent reply",
      mediaUrls: undefined,
    });
  });

  it("skips nested transcript mirror when provenance is missing or not inter_session", async () => {
    mockAppendTranscript.mockClear();
    const runtimeMissing = makeRuntime();
    const runtimeWrong = makeRuntime();

    await deliverAgentCommandResult({
      cfg: makeCfg(),
      deps: makeDeps(),
      runtime: runtimeMissing,
      opts: {
        message: "test",
        deliver: false,
        lane: AGENT_LANE_NESTED,
        sessionKey: "child-session-abc",
      },
      outboundSession: undefined,
      sessionEntry: undefined,
      result: { payloads: [{ text: "blocked", mediaUrls: [] }], meta: {} as never },
      payloads: [{ text: "blocked", mediaUrls: [] }],
    });

    await deliverAgentCommandResult({
      cfg: makeCfg(),
      deps: makeDeps(),
      runtime: runtimeWrong,
      opts: {
        message: "test",
        deliver: false,
        lane: AGENT_LANE_NESTED,
        sessionKey: "child-session-abc",
        inputProvenance: { kind: "external_user" },
      },
      outboundSession: undefined,
      sessionEntry: undefined,
      result: { payloads: [{ text: "blocked", mediaUrls: [] }], meta: {} as never },
      payloads: [{ text: "blocked", mediaUrls: [] }],
    });

    expect(mockAppendTranscript).not.toHaveBeenCalled();
    expect(runtimeMissing.log).toHaveBeenCalledWith(
      expect.stringContaining("transcript mirror skipped (unauthorized nested mirror)"),
    );
    expect(runtimeWrong.log).toHaveBeenCalledWith(
      expect.stringContaining("transcript mirror skipped (unauthorized nested mirror)"),
    );
  });

  it("mirrors nested transcript when provenance is inter_session", async () => {
    mockAppendTranscript.mockClear();
    mockAppendTranscript.mockResolvedValue({ ok: true, sessionFile: "/tmp/test.jsonl" });
    const runtime = makeRuntime();

    await deliverAgentCommandResult({
      cfg: makeCfg(),
      deps: makeDeps(),
      runtime,
      opts: {
        message: "test",
        deliver: false,
        lane: AGENT_LANE_NESTED,
        sessionKey: "child-session-abc",
        inputProvenance: { kind: "inter_session" },
      },
      outboundSession: undefined,
      sessionEntry: undefined,
      result: { payloads: [{ text: "allowed", mediaUrls: [] }], meta: {} as never },
      payloads: [{ text: "allowed", mediaUrls: [] }],
    });

    expect(mockAppendTranscript).toHaveBeenCalledOnce();
  });

  it("does not abort nested run when transcript append rejects", async () => {
    mockAppendTranscript.mockClear();
    mockAppendTranscript.mockRejectedValue(new Error("sensitive transcript path leaked"));
    const runtime = makeRuntime();

    await expect(
      deliverAgentCommandResult({
        cfg: makeCfg(),
        deps: makeDeps(),
        runtime,
        opts: {
          message: "test",
          deliver: false,
          lane: AGENT_LANE_NESTED,
          sessionKey: "child-session-abc",
          inputProvenance: { kind: "inter_session" },
        },
        outboundSession: undefined,
        sessionEntry: undefined,
        result: { payloads: [{ text: "Hello from agent", mediaUrls: [] }], meta: {} as never },
        payloads: [{ text: "Hello from agent", mediaUrls: [] }],
      }),
    ).resolves.toEqual({
      payloads: [
        { text: "Hello from agent", mediaUrl: null, mediaUrls: undefined, channelData: undefined },
      ],
      meta: {},
    });

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("transcript mirror skipped (unexpected transcript error)"),
    );
    expect(runtime.error).not.toHaveBeenCalledWith(
      expect.stringContaining("sensitive transcript path leaked"),
    );
  });

  it("mirrors nested transcript before json-mode early return", async () => {
    mockAppendTranscript.mockClear();
    mockAppendTranscript.mockResolvedValue({ ok: true, sessionFile: "/tmp/test.jsonl" });
    const runtime = makeRuntime();

    await deliverAgentCommandResult({
      cfg: makeCfg(),
      deps: makeDeps(),
      runtime,
      opts: {
        message: "test",
        deliver: false,
        json: true,
        lane: AGENT_LANE_NESTED,
        sessionKey: "json-session",
        inputProvenance: { kind: "inter_session" },
      },
      outboundSession: undefined,
      sessionEntry: undefined,
      result: { payloads: [{ text: "json reply", mediaUrls: [] }], meta: {} as never },
      payloads: [{ text: "json reply", mediaUrls: [] }],
    });

    expect(mockAppendTranscript).toHaveBeenCalledOnce();
    expect(mockAppendTranscript).toHaveBeenCalledWith({
      agentId: undefined,
      sessionKey: "json-session",
      text: "json reply",
      mediaUrls: undefined,
    });
    expect(runtime.log).toHaveBeenCalledTimes(1);
  });

  it("falls back to opts.agentId when no session context is available", async () => {
    mockAppendTranscript.mockClear();
    mockAppendTranscript.mockResolvedValue({ ok: true, sessionFile: "/tmp/test.jsonl" });
    const runtime = makeRuntime();

    await deliverAgentCommandResult({
      cfg: makeCfg(),
      deps: makeDeps(),
      runtime,
      opts: {
        message: "test",
        agentId: "research",
        deliver: false,
        lane: AGENT_LANE_NESTED,
        sessionKey: "agent-session",
        inputProvenance: { kind: "inter_session" },
      },
      outboundSession: undefined,
      sessionEntry: undefined,
      result: { payloads: [{ text: "agent reply", mediaUrls: [] }], meta: {} as never },
      payloads: [{ text: "agent reply", mediaUrls: [] }],
    });

    expect(mockAppendTranscript).toHaveBeenCalledWith({
      agentId: "research",
      sessionKey: "agent-session",
      text: "agent reply",
      mediaUrls: undefined,
    });
  });

  it("logs sanitized append failures returned by transcript helper", async () => {
    mockAppendTranscript.mockClear();
    mockAppendTranscript.mockResolvedValue({
      ok: false,
      reason: "unknown sessionKey: super-secret-session",
    });
    const runtime = makeRuntime();

    await expect(
      deliverAgentCommandResult({
        cfg: makeCfg(),
        deps: makeDeps(),
        runtime,
        opts: {
          message: "test",
          deliver: false,
          lane: AGENT_LANE_NESTED,
          sessionKey: "child-session-abc",
          inputProvenance: { kind: "inter_session" },
        },
        outboundSession: undefined,
        sessionEntry: undefined,
        result: { payloads: [{ text: "Hello from agent", mediaUrls: [] }], meta: {} as never },
        payloads: [{ text: "Hello from agent", mediaUrls: [] }],
      }),
    ).resolves.toEqual({
      payloads: [
        { text: "Hello from agent", mediaUrl: null, mediaUrls: undefined, channelData: undefined },
      ],
      meta: {},
    });

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("transcript mirror skipped (transcript unavailable)"),
    );
    expect(runtime.error).not.toHaveBeenCalledWith(expect.stringContaining("super-secret-session"));
  });
});
