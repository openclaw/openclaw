import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveAgentDirMock,
  resolveSessionAgentIdMock,
} from "./commands-agent-scope.test-support.js";
import type { HandleCommandsParams } from "./commands-types.js";

vi.mock("./commands-compact.runtime.js", () => ({
  abortEmbeddedPiRun: vi.fn(),
  appendSessionRecoveryEvent: vi.fn().mockResolvedValue(undefined),
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

const {
  appendSessionRecoveryEvent,
  compactEmbeddedPiSession,
  incrementCompactionCount,
  resolveSessionFilePathOptions,
} = await import("./commands-compact.runtime.js");
const { handleCompactCommand } = await import("./commands-compact.js");

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
    resolveAgentDirMock.mockImplementation(
      (_cfg: unknown, agentId: string) => `/tmp/workspace/.openclaw/agents/${agentId}/agent`,
    );
    resolveSessionAgentIdMock.mockReturnValue("main");
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

  it("records compact recovery lifecycle events around manual compaction", async () => {
    vi.mocked(compactEmbeddedPiSession).mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        summary: "compacted",
        firstKeptEntryId: "entry-2",
        tokensBefore: 1000,
        tokensAfter: 200,
      },
    });

    await handleCompactCommand(
      {
        ...buildCompactParams("/compact", {
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
        } as OpenClawConfig),
        storePath: "/tmp/openclaw-session-store.json",
        ctx: {
          Provider: "whatsapp",
          Surface: "whatsapp",
          ChatType: "direct",
          CommandSource: "text",
          CommandBody: "/compact: focus on decisions",
        },
        sessionEntry: {
          sessionId: "session-1",
          updatedAt: Date.now(),
          contextTokens: 4096,
        },
        contextTokens: 4096,
      } as HandleCommandsParams,
      true,
    );

    expect(vi.mocked(appendSessionRecoveryEvent)).toHaveBeenCalledTimes(3);
    expect(
      vi.mocked(appendSessionRecoveryEvent).mock.calls.map(([event]) => event.eventType),
    ).toEqual(["compact.requested", "compact.started", "compact.completed"]);
    expect(vi.mocked(appendSessionRecoveryEvent)).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        storePath: "/tmp/openclaw-session-store.json",
        eventType: "compact.requested",
        sessionKey: "agent:main:main",
        sessionId: "session-1",
        agentId: "main",
        source: expect.objectContaining({
          kind: "compact",
          provider: "whatsapp",
          surface: "whatsapp",
          channel: "whatsapp",
          chatType: "direct",
        }),
        details: expect.objectContaining({
          trigger: "manual",
          commandSource: "text",
          customInstructionsPresent: true,
          sessionFile: "/tmp/session.json",
          contextTokens: 4096,
        }),
      }),
    );
    expect(vi.mocked(appendSessionRecoveryEvent)).toHaveBeenLastCalledWith(
      expect.objectContaining({
        eventType: "compact.completed",
        details: expect.objectContaining({
          ok: true,
          compacted: true,
          tokensBefore: 1000,
          tokensAfter: 200,
          firstKeptEntryId: "entry-2",
        }),
      }),
    );
  });

  it("records compact failed recovery event when compaction returns a failure", async () => {
    vi.mocked(compactEmbeddedPiSession).mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason: "model unavailable",
    });

    await handleCompactCommand(
      {
        ...buildCompactParams("/compact", {
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
        } as OpenClawConfig),
        storePath: "/tmp/openclaw-session-store.json",
        sessionEntry: {
          sessionId: "session-1",
          updatedAt: Date.now(),
        },
      } as HandleCommandsParams,
      true,
    );

    expect(
      vi.mocked(appendSessionRecoveryEvent).mock.calls.map(([event]) => event.eventType),
    ).toEqual(["compact.requested", "compact.started", "compact.failed"]);
    expect(vi.mocked(appendSessionRecoveryEvent)).toHaveBeenLastCalledWith(
      expect.objectContaining({
        eventType: "compact.failed",
        details: expect.objectContaining({
          ok: false,
          compacted: false,
          reason: "model unavailable",
        }),
      }),
    );
  });

  it("uses the canonical session agent when resolving the compaction session file", async () => {
    vi.mocked(compactEmbeddedPiSession).mockResolvedValueOnce({
      ok: true,
      compacted: false,
    });
    resolveSessionAgentIdMock.mockReturnValue("target");

    await handleCompactCommand(
      {
        ...buildCompactParams("/compact", {
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
          session: { store: "/tmp/openclaw-session-store.json" },
        } as OpenClawConfig),
        agentId: "main",
        sessionKey: "agent:target:whatsapp:direct:12345",
        sessionEntry: {
          sessionId: "session-1",
          updatedAt: Date.now(),
        },
      } as HandleCommandsParams,
      true,
    );

    expect(resolveSessionAgentIdMock).toHaveBeenCalledWith({
      sessionKey: "agent:target:whatsapp:direct:12345",
      config: expect.any(Object),
    });
    expect(vi.mocked(resolveSessionFilePathOptions)).toHaveBeenCalledWith({
      agentId: "target",
      storePath: undefined,
    });
  });

  it("uses the canonical session agent directory for compaction runtime inputs", async () => {
    vi.mocked(compactEmbeddedPiSession).mockResolvedValueOnce({
      ok: true,
      compacted: false,
    });
    resolveSessionAgentIdMock.mockReturnValue("target");
    resolveAgentDirMock.mockReturnValue("/tmp/target-agent");

    await handleCompactCommand(
      {
        ...buildCompactParams("/compact", {
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
        } as OpenClawConfig),
        agentId: "main",
        agentDir: "/tmp/main-agent",
        sessionKey: "agent:target:whatsapp:direct:12345",
        sessionEntry: {
          sessionId: "session-1",
          updatedAt: Date.now(),
        },
      } as HandleCommandsParams,
      true,
    );

    expect(vi.mocked(compactEmbeddedPiSession)).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: "/tmp/target-agent",
      }),
    );
    expect(resolveAgentDirMock).toHaveBeenCalledWith(expect.any(Object), "target");
  });

  it("prefers the target session entry for compaction runtime metadata", async () => {
    vi.mocked(compactEmbeddedPiSession).mockResolvedValueOnce({
      ok: true,
      compacted: false,
    });

    await handleCompactCommand(
      {
        ...buildCompactParams("/compact", {
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
        } as OpenClawConfig),
        sessionKey: "agent:target:whatsapp:direct:12345",
        sessionEntry: {
          sessionId: "wrapper-session",
          updatedAt: Date.now(),
          groupId: "wrapper-group",
          groupChannel: "#wrapper",
          space: "wrapper-space",
          spawnedBy: "agent:wrapper",
          skillsSnapshot: { prompt: "wrapper", skills: [] },
          contextTokens: 111,
        },
        sessionStore: {
          "agent:target:whatsapp:direct:12345": {
            sessionId: "target-session",
            updatedAt: Date.now(),
            groupId: "target-group",
            groupChannel: "#target",
            space: "target-space",
            spawnedBy: "agent:target-parent",
            skillsSnapshot: { prompt: "target", skills: [] },
            contextTokens: 222,
          },
        },
      } as HandleCommandsParams,
      true,
    );

    expect(vi.mocked(compactEmbeddedPiSession)).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "target-session",
        groupId: "target-group",
        groupChannel: "#target",
        groupSpace: "target-space",
        spawnedBy: "agent:target-parent",
        skillsSnapshot: { prompt: "target", skills: [] },
      }),
    );
  });

  it("prefers the target session entry when incrementing compaction count", async () => {
    vi.mocked(compactEmbeddedPiSession).mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        summary: "compacted",
        firstKeptEntryId: "first-kept",
        tokensBefore: 999,
        tokensAfter: 321,
      },
    });

    await handleCompactCommand(
      {
        ...buildCompactParams("/compact", {
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
        } as OpenClawConfig),
        sessionKey: "agent:target:whatsapp:direct:12345",
        sessionEntry: {
          sessionId: "wrapper-session",
          updatedAt: Date.now(),
        },
        sessionStore: {
          "agent:target:whatsapp:direct:12345": {
            sessionId: "target-session",
            updatedAt: Date.now(),
          },
        },
      } as HandleCommandsParams,
      true,
    );

    expect(vi.mocked(incrementCompactionCount)).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionEntry: expect.objectContaining({
          sessionId: "target-session",
        }),
        tokensAfter: 321,
      }),
    );
  });
});
