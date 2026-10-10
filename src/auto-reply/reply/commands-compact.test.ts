// Tests compact command behavior for session compaction and reply status.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  abortEmbeddedAgentRun,
  buildCompactParams,
  compactEmbeddedAgentSession,
  formatContextUsageShort,
  handleCompactCommand,
  incrementCompactionCount,
  requireCompactEmbeddedAgentSessionCall,
  requireIncrementCompactionCountCall,
  requireResolveAgentDirCall,
  requireResolveSessionAgentIdCall,
  resetCompactCommandMocks,
  waitForEmbeddedAgentRunEnd,
} from "./commands-compact.test-support.js";
import type { HandleCommandsParams } from "./commands-types.js";

const compactCommandConfig: OpenClawConfig = {
  commands: { text: true },
  channels: { whatsapp: { allowFrom: ["*"] } },
};

describe("handleCompactCommand", () => {
  beforeEach(resetCompactCommandMocks);

  it("returns null when command is not /compact", async () => {
    const result = await handleCompactCommand(
      buildCompactParams("/status", compactCommandConfig),
      true,
    );

    expect(result).toBeNull();
    expect(vi.mocked(compactEmbeddedAgentSession)).not.toHaveBeenCalled();
  });

  it("rejects unauthorized /compact commands", async () => {
    const params = buildCompactParams("/compact", compactCommandConfig);

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
    expect(vi.mocked(compactEmbeddedAgentSession)).not.toHaveBeenCalled();
  });

  it("routes manual compaction with explicit trigger and context metadata", async () => {
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: true,
      compacted: false,
    });
    const abortController = new AbortController();
    const ownerIds = Array.from({ length: 24 }, (_, index) =>
      index === 23 ? "owner" : `owner-${index}`,
    );
    const params = buildCompactParams("/compact", {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { store: "/tmp/openclaw-session-store.json" },
    });
    params.command.ownerList = ownerIds;
    params.command.senderIsOwner = true;

    const result = await handleCompactCommand(
      {
        ...params,
        ctx: {
          Provider: "whatsapp",
          Surface: "whatsapp",
          CommandSource: "text",
          CommandBody: "/compact: focus on decisions",
          commandText: "/compact: focus on decisions",
          From: "+15550001",
          To: "+15550002",
          SenderName: "Alice",
          SenderUsername: "alice_u",
          SenderE164: "+15551234567",
        },
        agentDir: "/tmp/openclaw-agent-compact",
        opts: { abortSignal: abortController.signal },
        sessionEntry: {
          sessionId: "session-1",
          updatedAt: Date.now(),
          groupId: "group-1",
          groupChannel: "#general",
          space: "workspace-1",
          spawnedBy: "agent:main:parent",
          totalTokens: 12345,
          authProfileOverride: "github-copilot:work",
        },
      } as HandleCommandsParams,
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(vi.mocked(compactEmbeddedAgentSession)).toHaveBeenCalledOnce();
    const call = requireCompactEmbeddedAgentSessionCall();
    expect(call.sessionId).toBe("session-1");
    expect(call.abortSignal).toBe(abortController.signal);
    expect(call.sessionKey).toBe("agent:main:main");
    expect(call.allowGatewaySubagentBinding).toBe(true);
    expect(call.trigger).toBe("manual");
    expect(call.customInstructions).toBe("focus on decisions");
    expect(call.messageChannel).toBe("whatsapp");
    expect(call.groupId).toBe("group-1");
    expect(call.groupChannel).toBe("#general");
    expect(call.groupSpace).toBe("workspace-1");
    expect(call.spawnedBy).toBe("agent:main:parent");
    expect(call.senderId).toBe("owner");
    expect(call.ownerNumbers).toHaveLength(16);
    expect(call.ownerNumbers?.at(-1)).toBe("owner");
    expect(call).not.toHaveProperty("senderIsOwner");
    expect(params.command.ownerList).toEqual(ownerIds);
    expect(call.senderName).toBe("Alice");
    expect(call.senderUsername).toBe("alice_u");
    expect(call.senderE164).toBe("+15551234567");
    expect(call.agentDir).toBe("/tmp/openclaw-agent-compact");
    expect(call.authProfileId).toBe("github-copilot:work");
    expect(call.authProfileIdSource).toBe("user");
    expect(vi.mocked(abortEmbeddedAgentRun)).not.toHaveBeenCalled();
    expect(vi.mocked(waitForEmbeddedAgentRunEnd)).not.toHaveBeenCalled();
  });

  it("treats already-under-target manual compaction as skipped", async () => {
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason: "already under target",
    });

    const result = await handleCompactCommand(
      {
        ...buildCompactParams("/compact", compactCommandConfig),
        sessionEntry: {
          sessionId: "session-1",
          updatedAt: Date.now(),
        },
      } as HandleCommandsParams,
      true,
    );

    expect(result?.reply?.text).toBe(
      "⚙️ Compaction skipped: context is already under the compaction target • Context 12.1k",
    );
    expect(result?.reply?.isStatusNotice).toBe(true);
    expect(vi.mocked(incrementCompactionCount)).not.toHaveBeenCalled();
  });

  it("does not hide a failed manual compaction with an empty-transcript reason", async () => {
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason: "no real conversation messages",
    });

    const result = await handleCompactCommand(
      {
        ...buildCompactParams("/compact", compactCommandConfig),
        sessionEntry: {
          sessionId: "session-1",
          updatedAt: Date.now(),
        },
      } as HandleCommandsParams,
      true,
    );

    expect(result?.reply?.text).toBe(
      "⚙️ Compaction failed: nothing compactable in this session yet • Context 12.1k",
    );
    expect(vi.mocked(incrementCompactionCount)).not.toHaveBeenCalled();
  });

  it("treats already_compacted manual compaction as skipped", async () => {
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason: "already_compacted",
    });

    const result = await handleCompactCommand(
      {
        ...buildCompactParams("/compact", compactCommandConfig),
        sessionEntry: {
          sessionId: "session-1",
          updatedAt: Date.now(),
        },
      } as HandleCommandsParams,
      true,
    );

    expect(result?.reply?.text).toBe(
      "⚙️ Compaction skipped: session is already compacted • Context 12.1k",
    );
    expect(result?.reply?.isStatusNotice).toBe(true);
  });

  it("targets the persisted native CLI session for manual compaction", async () => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () =>
        [
          {
            id: "claude-cli",
            modelProvider: "anthropic",
            config: { command: "claude" },
            bundleMcp: false,
          },
        ] as never,
    });
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: true,
      compacted: true,
      compactionKind: "native-harness",
      result: {
        summary: "",
        firstKeptEntryId: "",
        tokensBefore: 999,
        details: { completed: true },
      },
    });

    try {
      const result = await handleCompactCommand(
        {
          ...buildCompactParams("/compact", compactCommandConfig),
          provider: "anthropic",
          sessionEntry: {
            sessionId: "cli-session",
            updatedAt: Date.now(),
            totalTokens: 999,
            totalTokensFresh: true,
            cliSessionBindings: {
              "claude-cli": { sessionId: "native-claude-session" },
            },
          },
        } as HandleCommandsParams,
        true,
      );

      expect(requireCompactEmbeddedAgentSessionCall()).toMatchObject({
        agentHarnessId: "claude-cli",
        cliSessionId: "native-claude-session",
        trigger: "manual",
      });
      expect(requireResolveSessionAgentIdCall().sessionKey).toBe("agent:main:main");
      expect(requireResolveAgentDirCall()).toEqual([compactCommandConfig, "main"]);
      expect(incrementCompactionCount).toHaveBeenCalledOnce();
      expect(requireIncrementCompactionCountCall().compactionKind).toBe("native-harness");
      expect(requireIncrementCompactionCountCall().tokensAfter).toBeUndefined();
      expect(formatContextUsageShort).toHaveBeenLastCalledWith(null, null);
      expect(result?.reply?.text).toContain("Compaction finished (resulting context unknown) •");
      expect(result?.reply?.text).not.toContain("undefined");
    } finally {
      cliBackendsTesting.resetDepsForTest();
    }
  });

  it.each([{ provider: "openai", harness: "codex", expectedRuntime: "codex" }])(
    "uses the model picker's runtime only when it serves $provider (#117470)",
    async ({ provider, harness, expectedRuntime, ...testCase }) => {
      cliBackendsTesting.setDepsForTest({
        resolveRuntimeCliBackends: () =>
          [
            {
              id: "claude-cli",
              modelProvider: "anthropic",
              config: { command: "claude" },
              bundleMcp: false,
            },
            {
              id: "copilot",
              modelProvider: "github-copilot",
              config: { command: "copilot" },
              bundleMcp: false,
            },
          ] as never,
        resolvePluginSetupCliBackend: () => {
          throw new Error("manual compaction attempted synchronous CLI setup discovery");
        },
      });
      vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
        ok: false,
        compacted: false,
        reason: "runtime ownership probe",
      });

      try {
        await handleCompactCommand(
          {
            ...buildCompactParams("/compact", compactCommandConfig),
            provider,
            sessionEntry: {
              sessionId: "picker-session",
              updatedAt: Date.now(),
              ...("override" in testCase ? { agentRuntimeOverride: harness } : {}),
              agentHarnessId: harness,
            },
          } as HandleCommandsParams,
          true,
        );

        expect(requireCompactEmbeddedAgentSessionCall().agentHarnessId).toBe(expectedRuntime);
      } finally {
        cliBackendsTesting.resetDepsForTest();
        vi.mocked(compactEmbeddedAgentSession).mockReset();
      }
    },
  );

  it("reports server-side compaction with before and after tokens", async () => {
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: true,
      compacted: true,
      compactionKind: "server-endpoint",
      result: {
        kind: "server-endpoint",
        tokensBefore: 8_614,
        tokensAfter: 736,
      },
    });

    const result = await handleCompactCommand(
      {
        ...buildCompactParams("/compact", compactCommandConfig),
        sessionEntry: { sessionId: "server-session", updatedAt: Date.now() },
      } as HandleCommandsParams,
      true,
    );

    expect(result?.reply?.text).toContain("Server-side compaction (8614 → 736)");
    expect(requireIncrementCompactionCountCall().compactionKind).toBe("server-endpoint");
  });

  it("forwards the routed account id from the command context", async () => {
    // Group session keys carry no account identity, so manual /compact has to
    // pass it explicitly or it resolves the root history limit while prompt
    // preparation already used the account limit.
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({ ok: true, compacted: false });
    const params = {
      ...buildCompactParams("/compact", compactCommandConfig),
      provider: "anthropic",
      model: "claude-opus-4-6",
      contextTokens: 200_000,
      sessionEntry: { sessionId: "session", updatedAt: Date.now() },
    } as unknown as HandleCommandsParams;
    params.ctx.AccountId = "work";
    params.ctx.ConversationRoutePeerId = "peer";
    params.ctx.ChatType = "direct";

    await handleCompactCommand(params, true);

    expect(requireCompactEmbeddedAgentSessionCall().agentAccountId).toBe("work");
    expect(requireCompactEmbeddedAgentSessionCall()).toMatchObject({
      conversationRoutePeerId: "peer",
      chatType: "direct",
    });
  });
});
