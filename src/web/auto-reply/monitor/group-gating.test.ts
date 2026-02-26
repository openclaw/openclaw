import { describe, expect, it, vi } from "vitest";
import { applyGroupGating } from "./group-gating.js";

// Mock heavy/external dependencies so we don't need a real config
vi.mock("./group-activation.js", () => ({
  resolveGroupPolicyFor: vi.fn(),
  resolveGroupActivationFor: vi.fn(() => "mention"),
  resolveGroupRequireMentionFor: vi.fn(() => true),
}));

vi.mock("../../../hooks/internal-hooks.js", () => ({
  triggerInternalHook: vi.fn(async () => {}),
  createInternalHookEvent: vi.fn(() => ({ type: "message", action: "received" })),
}));

vi.mock("../../../auto-reply/reply/history.js", () => ({
  recordPendingHistoryEntryIfEnabled: vi.fn(),
}));

vi.mock("./group-members.js", () => ({
  noteGroupMember: vi.fn(),
}));

vi.mock("../mentions.js", () => ({
  buildMentionConfig: vi.fn(() => ({ mentionRegexes: [], owners: [] })),
  debugMention: vi.fn(() => ({
    wasMentioned: true,
    details: {},
  })),
  resolveOwnerList: vi.fn(() => []),
}));

vi.mock("../../../channels/mention-gating.js", () => ({
  resolveMentionGating: vi.fn(() => ({
    effectiveWasMentioned: true,
    shouldSkip: false,
  })),
}));

vi.mock("../../../auto-reply/command-detection.js", () => ({
  hasControlCommand: vi.fn(() => false),
}));

vi.mock("../../../auto-reply/group-activation.js", () => ({
  parseActivationCommand: vi.fn(() => ({ hasCommand: false })),
  normalizeGroupActivation: vi.fn(() => undefined),
}));

vi.mock("./commands.js", () => ({
  stripMentionsForCommand: vi.fn((body: string) => body),
}));

import { triggerInternalHook } from "../../../hooks/internal-hooks.js";
import { resolveGroupPolicyFor, resolveGroupRequireMentionFor } from "./group-activation.js";

const resolveGroupPolicyForMock = vi.mocked(resolveGroupPolicyFor);
const resolveGroupRequireMentionForMock = vi.mocked(resolveGroupRequireMentionFor);
const triggerInternalHookMock = vi.mocked(triggerInternalHook);

function makeParams(overrides: Partial<Parameters<typeof applyGroupGating>[0]> = {}) {
  const conversationId = "120363098795789378@g.us";
  return {
    // oxlint-disable-next-line typescript/no-explicit-any
    cfg: {} as any,
    msg: {
      body: "hello",
      senderE164: "+15550001111",
      senderName: "Alice",
      senderJid: "15550001111@s.whatsapp.net",
      selfE164: "+15559999999",
      selfJid: "15559999999@s.whatsapp.net",
      timestamp: 1700000000,
      id: "msg-1",
      wasMentioned: false,
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any,
    conversationId,
    groupHistoryKey: conversationId,
    agentId: "main",
    sessionKey: "whatsapp:default:main",
    // oxlint-disable-next-line typescript/no-explicit-any
    baseMentionConfig: { mentionRegexes: [], owners: [] } as any,
    authDir: undefined,
    groupHistories: new Map(),
    groupHistoryLimit: 50,
    groupMemberNames: new Map(),
    logVerbose: vi.fn(),
    replyLogger: { debug: vi.fn() },
    ...overrides,
  };
}

describe("applyGroupGating — monitor mode (requireMention: monitor)", () => {
  it("returns shouldProcess=false for a monitor group (even when mentioned)", async () => {
    resolveGroupPolicyForMock.mockReturnValue({
      allowlistEnabled: true,
      allowed: true,
      groupConfig: { requireMention: "monitor" },
      defaultConfig: undefined,
    });
    resolveGroupRequireMentionForMock.mockReturnValue("monitor");

    const params = makeParams();
    const result = applyGroupGating(params);

    expect(result).toEqual({ shouldProcess: false });
    expect(params.logVerbose as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      expect.stringContaining("Monitor-only group"),
    );
  });

  it("fires internal hooks for monitor groups", async () => {
    resolveGroupPolicyForMock.mockReturnValue({
      allowlistEnabled: true,
      allowed: true,
      groupConfig: { requireMention: "monitor" },
      defaultConfig: undefined,
    });
    resolveGroupRequireMentionForMock.mockReturnValue("monitor");
    triggerInternalHookMock.mockResolvedValue(undefined);

    applyGroupGating(makeParams());

    expect(triggerInternalHookMock).toHaveBeenCalled();
  });

  it("returns shouldProcess=true for requireMention=true when mentioned", () => {
    resolveGroupPolicyForMock.mockReturnValue({
      allowlistEnabled: true,
      allowed: true,
      groupConfig: { requireMention: true },
      defaultConfig: undefined,
    });
    resolveGroupRequireMentionForMock.mockReturnValue(true);

    const result = applyGroupGating(makeParams());

    expect(result).toEqual({ shouldProcess: true });
  });

  it("returns shouldProcess=true for requireMention=false (always active)", () => {
    resolveGroupPolicyForMock.mockReturnValue({
      allowlistEnabled: true,
      allowed: true,
      groupConfig: { requireMention: false },
      defaultConfig: undefined,
    });
    resolveGroupRequireMentionForMock.mockReturnValue(false);

    const result = applyGroupGating(makeParams());

    expect(result).toEqual({ shouldProcess: true });
  });

  it("returns shouldProcess=false and fires hooks for non-allowlisted groups", () => {
    resolveGroupPolicyForMock.mockReturnValue({
      allowlistEnabled: true,
      allowed: false,
      groupConfig: undefined,
      defaultConfig: undefined,
    });
    resolveGroupRequireMentionForMock.mockReturnValue(true);
    triggerInternalHookMock.mockResolvedValue(undefined);

    const result = applyGroupGating(makeParams());

    expect(result).toEqual({ shouldProcess: false });
    expect(triggerInternalHookMock).toHaveBeenCalled();
  });
});
