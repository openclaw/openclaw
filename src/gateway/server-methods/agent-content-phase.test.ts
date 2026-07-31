import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  loadSessionEntryMock,
  resolveGatewayModelSupportsImagesMock,
  resolveSessionModelRefMock,
  parseMessageWithAttachmentsMock,
} = vi.hoisted(() => ({
  loadSessionEntryMock: vi.fn(),
  resolveGatewayModelSupportsImagesMock: vi.fn(),
  resolveSessionModelRefMock: vi.fn(),
  parseMessageWithAttachmentsMock: vi.fn(),
}));

vi.mock("../session-utils.js", () => ({
  loadSessionEntry: loadSessionEntryMock,
  resolveGatewayModelSupportsImages: resolveGatewayModelSupportsImagesMock,
  resolveSessionModelRef: resolveSessionModelRefMock,
}));

vi.mock("../chat-attachments.js", () => ({
  MediaOffloadError: class MediaOffloadError extends Error {},
  logAttachmentFailure: vi.fn(),
  parseMessageWithAttachments: parseMessageWithAttachmentsMock,
  resolveChatAttachmentMaxBytes: vi.fn(() => 1_000_000),
}));

import { prepareAgentContentPhase } from "./agent-content-phase.js";

describe("prepareAgentContentPhase ownership", () => {
  beforeEach(() => {
    loadSessionEntryMock.mockReset().mockReturnValue({
      cfg: { agents: { ownership: "explicit", entries: { work: {} } } },
      entry: { sessionId: "session-work" },
      canonicalKey: "incident-42",
    });
    resolveSessionModelRefMock.mockReset().mockReturnValue({
      provider: "openai",
      model: "gpt-5.6-luna",
    });
    resolveGatewayModelSupportsImagesMock.mockReset().mockResolvedValue(true);
    parseMessageWithAttachmentsMock.mockReset().mockResolvedValue({
      message: "inspect",
      images: [],
      imageOrder: [],
      media: [],
    });
  });

  it("keeps the selected agent when a loaded session has a bare canonical key", async () => {
    const respond = vi.fn();

    await prepareAgentContentPhase({
      request: { message: "inspect", idempotencyKey: "inspect-work-session" },
      cfg: { agents: { ownership: "explicit", entries: { work: {} } } },
      context: {
        loadGatewayModelCatalog: vi.fn(),
        logGateway: { warn: vi.fn() },
      } as never,
      respond,
      isRawModelRun: false,
      normalizedAttachments: [{ type: "file", mimeType: "image/png", content: "aGVsbG8=" }],
      requestedSessionKeyRaw: "incident-42",
      requestedSessionKey: "incident-42",
      agentId: "work",
      knownAgents: ["work"],
    });

    expect(resolveSessionModelRefMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "work",
    );
    expect(resolveGatewayModelSupportsImagesMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "work" }),
    );
    expect(respond).not.toHaveBeenCalled();
  });
});
