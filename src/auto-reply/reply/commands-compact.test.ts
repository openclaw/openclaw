import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function compactParams(overrides: Partial<HandleCommandsParams> = {}): HandleCommandsParams {
  return {
    ...buildCompactParams("/compact", compactCommandConfig),
    sessionEntry: { sessionId: "session-1", updatedAt: Date.now() },
    ...overrides,
  };
}

function cliBackend(id = "claude-cli", modelProvider = "anthropic") {
  return {
    id,
    modelProvider,
    config: { command: id === "claude-cli" ? "claude" : id },
    bundleMcp: false,
  };
}

describe("handleCompactCommand", () => {
  beforeEach(resetCompactCommandMocks);
  afterEach(() => {
    cliBackendsTesting.resetDepsForTest();
    vi.mocked(compactEmbeddedAgentSession).mockReset();
  });

  it.each([
    ["/status", true, null],
    ["/compact", false, { shouldContinue: false }],
  ] as const)("gates %s (authorized=%s)", async (body, authorized, expected) => {
    const params = buildCompactParams(body, compactCommandConfig);
    Object.assign(params.command, {
      isAuthorizedSender: authorized,
      senderId: authorized ? "owner" : "unauthorized",
    });
    const result = await handleCompactCommand(params, true);
    expect(result).toEqual(expected);
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
      ...compactCommandConfig,
      session: { store: "/tmp/openclaw-session-store.json" },
    });
    params.command.ownerList = ownerIds;
    params.command.senderIsOwner = true;

    const result = await handleCompactCommand(
      {
        ...params,
        ctx: {
          ...params.ctx,
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
    expect(call).toMatchObject({
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
      authProfileId: "github-copilot:work",
      authProfileIdSource: "user",
    });
    expect(call.abortSignal).toBe(abortController.signal);
    expect(call.ownerNumbers).toHaveLength(16);
    expect(call.ownerNumbers?.at(-1)).toBe("owner");
    expect(call).not.toHaveProperty("senderIsOwner");
    expect(params.command.ownerList).toEqual(ownerIds);
    expect(vi.mocked(abortEmbeddedAgentRun)).not.toHaveBeenCalled();
    expect(vi.mocked(waitForEmbeddedAgentRunEnd)).not.toHaveBeenCalled();
  });

  it.each([
    ["already under target", "skipped: context is already under the compaction target", true],
    ["no real conversation messages", "failed: nothing compactable in this session yet", false],
    ["already_compacted", "skipped: session is already compacted", true],
  ] as const)("reports manual compaction reason %s", async (reason, message, statusNotice) => {
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason,
    });
    const result = await handleCompactCommand(compactParams(), true);
    expect(result?.reply?.text).toBe(`⚙️ Compaction ${message} • Context 12.1k`);
    if (statusNotice) {
      expect(result?.reply?.isStatusNotice).toBe(true);
    }
    expect(vi.mocked(incrementCompactionCount)).not.toHaveBeenCalled();
  });

  it("targets the persisted native CLI session for manual compaction", async () => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [cliBackend()] as never,
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

    const result = await handleCompactCommand(
      compactParams({
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
      }),
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
  });

  it("uses the model picker runtime for OpenAI (#117470)", async () => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () =>
        [cliBackend(), cliBackend("copilot", "github-copilot")] as never,
      resolvePluginSetupCliBackend: () => {
        throw new Error("manual compaction attempted synchronous CLI setup discovery");
      },
    });
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason: "runtime ownership probe",
    });

    await handleCompactCommand(
      {
        ...buildCompactParams("/compact", compactCommandConfig),
        provider: "openai",
        sessionEntry: {
          sessionId: "picker-session",
          updatedAt: Date.now(),
          agentHarnessId: "codex",
        },
      } as HandleCommandsParams,
      true,
    );

    expect(requireCompactEmbeddedAgentSessionCall().agentHarnessId).toBe("codex");
  });

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
      compactParams({ sessionEntry: { sessionId: "server-session", updatedAt: Date.now() } }),
      true,
    );

    expect(result?.reply?.text).toContain("Server-side compaction (8614 → 736)");
    expect(requireIncrementCompactionCountCall().compactionKind).toBe("server-endpoint");
  });

  it("forwards the routed account id from the command context", async () => {
    // Group session keys lack account identity; forward the prompt preparation account.
    vi.mocked(compactEmbeddedAgentSession).mockResolvedValueOnce({ ok: true, compacted: false });
    const params = compactParams({
      provider: "anthropic",
      model: "claude-opus-4-6",
      contextTokens: 200_000,
      sessionEntry: { sessionId: "session", updatedAt: Date.now() },
    });
    params.ctx.AccountId = "work";
    params.ctx.ConversationRoutePeerId = "peer";
    params.ctx.ChatType = "direct";

    await handleCompactCommand(params, true);

    expect(requireCompactEmbeddedAgentSessionCall()).toMatchObject({
      agentAccountId: "work",
      conversationRoutePeerId: "peer",
      chatType: "direct",
    });
  });
});
