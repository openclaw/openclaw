import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { handleCompactCommand } from "./commands-compact.js";
import type { HandleCommandsParams } from "./commands-types.js";

vi.mock("./commands-compact.runtime.js", () => ({
  abortEmbeddedPiRun: vi.fn(),
  compactEmbeddedPiSession: vi.fn(),
  enqueueSystemEvent: vi.fn(),
  formatContextUsageShort: vi.fn(() => "Context 12.1k"),
  formatTokenCount: vi.fn((value: number) => `${value}`),
  incrementCompactionCount: vi.fn(),
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  resolveFreshSessionTotalTokens: vi.fn(() => 12_345),
  resolveSessionFilePath: vi.fn(() => "/tmp/session.json"),
  resolveSessionFilePathOptions: vi.fn(() => ({})),
  waitForEmbeddedPiRunEnd: vi.fn().mockResolvedValue(undefined),
}));

const { compactEmbeddedPiSession } = await import("./commands-compact.runtime.js");

function buildCompactParams(
  commandBodyNormalized: string,
  cfg: OpenClawConfig,
): HandleCommandsParams {
  return {
    cfg,
    ctx: {
      Provider: "whatsapp",
      Surface: "whatsapp",
      CommandSource: "text",
      CommandBody: commandBodyNormalized,
    },
    command: {
      commandBodyNormalized,
      isAuthorizedSender: true,
      senderIsOwner: false,
      senderId: "owner",
      channel: "whatsapp",
      ownerList: [],
    },
    sessionKey: "agent:main:main",
    sessionStore: {},
    resolveDefaultThinkingLevel: async () => "medium",
  } as unknown as HandleCommandsParams;
}

describe("handleCompactCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when command is not /compact", async () => {
    const result = await handleCompactCommand(
      buildCompactParams("/status", {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig),
      true,
    );

    expect(result).toBeNull();
    expect(vi.mocked(compactEmbeddedPiSession)).not.toHaveBeenCalled();
  });

  it("rejects unauthorized /compact commands", async () => {
    const params = buildCompactParams("/compact", {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig);

    const result = await handleCompactCommand(
      {
        ...params,
        command: {
          ...params.command,
          isAuthorizedSender: false,
          senderId: "unauthorized",
        },
      } as HandleCommandsParams,
      true,
    );

    expect(result).toEqual({ shouldContinue: false });
    expect(vi.mocked(compactEmbeddedPiSession)).not.toHaveBeenCalled();
  });

  it("routes manual compaction with explicit trigger and context metadata", async () => {
    vi.mocked(compactEmbeddedPiSession).mockResolvedValueOnce({
      ok: true,
      compacted: false,
    });

    const result = await handleCompactCommand(
      {
        ...buildCompactParams("/compact", {
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
          session: { store: "/tmp/openclaw-session-store.json" },
        } as OpenClawConfig),
        ctx: {
          Provider: "whatsapp",
          Surface: "whatsapp",
          CommandSource: "text",
          CommandBody: "/compact: focus on decisions",
          From: "+15550001",
          To: "+15550002",
          SenderName: "Alice",
          SenderUsername: "alice_u",
          SenderE164: "+15551234567",
        },
        agentDir: "/tmp/openclaw-agent-compact",
        sessionEntry: {
          sessionId: "session-1",
          updatedAt: Date.now(),
          groupId: "group-1",
          groupChannel: "#general",
          space: "workspace-1",
          spawnedBy: "agent:main:parent",
          totalTokens: 12345,
        },
      } as HandleCommandsParams,
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(vi.mocked(compactEmbeddedPiSession)).toHaveBeenCalledOnce();
    expect(vi.mocked(compactEmbeddedPiSession)).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        allowGatewaySubagentBinding: true,
        trigger: "manual",
        customInstructions: "focus on decisions",
        messageChannel: "whatsapp",
        groupId: "group-1",
        groupChannel: "#general",
        groupSpace: "workspace-1",
        spawnedBy: "agent:main:parent",
        senderId: "owner",
        senderName: "Alice",
        senderUsername: "alice_u",
        senderE164: "+15551234567",
        agentDir: "/tmp/openclaw-agent-compact",
      }),
    );
  });
});
