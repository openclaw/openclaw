import { describe, expect, it, vi, beforeEach } from "vitest";
import { maybeCrossSessionInject } from "./cross-session-inject.js";
import type { OpenClawConfig } from "../../config/config.js";

// Mock the session transcript append function
vi.mock("../../config/sessions/transcript.js", () => ({
  appendAssistantMessageToSessionTranscript: vi.fn(async () => ({
    ok: true,
    sessionFile: "/tmp/sessions/test.jsonl",
  })),
}));

// Mock the logger
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { appendAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.js";

const mockAppend = vi.mocked(appendAssistantMessageToSessionTranscript);

function makeConfig(overrides?: {
  dmScope?: string;
  injectOutboundToTargetSession?: boolean;
}): OpenClawConfig {
  return {
    session: {
      dmScope: overrides?.dmScope as "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer" | undefined,
      injectOutboundToTargetSession: overrides?.injectOutboundToTargetSession,
    },
  } as unknown as OpenClawConfig;
}

describe("maybeCrossSessionInject", () => {
  beforeEach(() => {
    mockAppend.mockClear();
    mockAppend.mockResolvedValue({ ok: true, sessionFile: "/tmp/sessions/test.jsonl" });
  });

  it("does not inject when injectOutboundToTargetSession is false", async () => {
    const result = await maybeCrossSessionInject({
      cfg: makeConfig({ dmScope: "per-channel-peer", injectOutboundToTargetSession: false }),
      channel: "telegram",
      agentId: "main",
      targetPeerId: "12345",
      text: "Hello from agent",
    });

    expect(result.injected).toBe(false);
    expect(result.reason).toBe("disabled");
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it("does not inject when injectOutboundToTargetSession is undefined", async () => {
    const result = await maybeCrossSessionInject({
      cfg: makeConfig({ dmScope: "per-channel-peer" }),
      channel: "telegram",
      agentId: "main",
      targetPeerId: "12345",
      text: "Hello from agent",
    });

    expect(result.injected).toBe(false);
    expect(result.reason).toBe("disabled");
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it("does not inject when dmScope is 'main'", async () => {
    const result = await maybeCrossSessionInject({
      cfg: makeConfig({ dmScope: "main", injectOutboundToTargetSession: true }),
      channel: "telegram",
      agentId: "main",
      targetPeerId: "12345",
      text: "Hello from agent",
    });

    expect(result.injected).toBe(false);
    expect(result.reason).toBe("dmScope-not-isolated");
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it("does not inject when dmScope is undefined (defaults to main)", async () => {
    const result = await maybeCrossSessionInject({
      cfg: makeConfig({ injectOutboundToTargetSession: true }),
      channel: "telegram",
      agentId: "main",
      targetPeerId: "12345",
      text: "Hello from agent",
    });

    expect(result.injected).toBe(false);
    expect(result.reason).toBe("dmScope-not-isolated");
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it("injects when enabled with per-channel-peer dmScope", async () => {
    const result = await maybeCrossSessionInject({
      cfg: makeConfig({ dmScope: "per-channel-peer", injectOutboundToTargetSession: true }),
      channel: "telegram",
      agentId: "main",
      targetPeerId: "12345",
      text: "Hello from agent",
    });

    expect(result.injected).toBe(true);
    expect(mockAppend).toHaveBeenCalledOnce();
    expect(mockAppend).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:telegram:direct:12345",
      text: "Hello from agent",
      mediaUrls: undefined,
    });
  });

  it("injects when enabled with per-peer dmScope", async () => {
    const result = await maybeCrossSessionInject({
      cfg: makeConfig({ dmScope: "per-peer", injectOutboundToTargetSession: true }),
      channel: "telegram",
      agentId: "main",
      targetPeerId: "12345",
      text: "Hello from agent",
    });

    expect(result.injected).toBe(true);
    expect(mockAppend).toHaveBeenCalledOnce();
    expect(mockAppend).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:direct:12345",
      text: "Hello from agent",
      mediaUrls: undefined,
    });
  });

  it("injects when enabled with per-account-channel-peer dmScope", async () => {
    const result = await maybeCrossSessionInject({
      cfg: makeConfig({
        dmScope: "per-account-channel-peer",
        injectOutboundToTargetSession: true,
      }),
      channel: "telegram",
      agentId: "main",
      accountId: "mybot",
      targetPeerId: "12345",
      text: "Hello from agent",
    });

    expect(result.injected).toBe(true);
    expect(mockAppend).toHaveBeenCalledOnce();
    expect(mockAppend).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:telegram:mybot:direct:12345",
      text: "Hello from agent",
      mediaUrls: undefined,
    });
  });

  it("passes mediaUrls to the transcript append", async () => {
    const result = await maybeCrossSessionInject({
      cfg: makeConfig({ dmScope: "per-channel-peer", injectOutboundToTargetSession: true }),
      channel: "telegram",
      agentId: "main",
      targetPeerId: "12345",
      text: "Check this out",
      mediaUrls: ["https://example.com/photo.jpg"],
    });

    expect(result.injected).toBe(true);
    expect(mockAppend).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrls: ["https://example.com/photo.jpg"],
      }),
    );
  });

  it("does not inject when target peer is empty", async () => {
    const result = await maybeCrossSessionInject({
      cfg: makeConfig({ dmScope: "per-channel-peer", injectOutboundToTargetSession: true }),
      channel: "telegram",
      agentId: "main",
      targetPeerId: "  ",
      text: "Hello",
    });

    expect(result.injected).toBe(false);
    expect(result.reason).toBe("missing-target-peer");
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it("returns injected=false when appendAssistant returns ok=false", async () => {
    mockAppend.mockResolvedValue({ ok: false, reason: "unknown sessionKey: x" });

    const result = await maybeCrossSessionInject({
      cfg: makeConfig({ dmScope: "per-channel-peer", injectOutboundToTargetSession: true }),
      channel: "telegram",
      agentId: "main",
      targetPeerId: "12345",
      text: "Hello",
    });

    expect(result.injected).toBe(false);
    expect(result.reason).toBe("unknown sessionKey: x");
  });

  it("handles appendAssistant errors gracefully", async () => {
    mockAppend.mockRejectedValue(new Error("disk full"));

    const result = await maybeCrossSessionInject({
      cfg: makeConfig({ dmScope: "per-channel-peer", injectOutboundToTargetSession: true }),
      channel: "telegram",
      agentId: "main",
      targetPeerId: "12345",
      text: "Hello",
    });

    expect(result.injected).toBe(false);
    expect(result.reason).toBe("disk full");
  });
});
