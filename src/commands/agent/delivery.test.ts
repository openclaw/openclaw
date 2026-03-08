import { describe, expect, it, vi } from "vitest";
import { AGENT_LANE_NESTED } from "../../agents/lanes.js";

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
    });
  });

  it("does NOT call appendAssistantMessageToSessionTranscript when deliver=true", async () => {
    mockAppendTranscript.mockClear();
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
    });
  });
});
