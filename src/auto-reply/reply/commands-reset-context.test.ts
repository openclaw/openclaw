import { describe, expect, it, vi } from "vitest";
import type { HandleCommandsParams } from "./commands-types.js";
import { handleResetContextCommand } from "./commands-reset-context.js";

// Mock dependencies
vi.mock("../../agents/pi-embedded.js", () => ({
  isEmbeddedPiRunActive: vi.fn(() => false),
  abortEmbeddedPiRun: vi.fn(),
  waitForEmbeddedPiRunEnd: vi.fn(),
  compactEmbeddedPiSession: vi.fn(),
}));

vi.mock("../../config/sessions.js", () => ({
  resolveSessionFilePath: vi.fn(() => "/tmp/test-session.jsonl"),
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));

vi.mock("./session-updates.js", () => ({
  incrementCompactionCount: vi.fn(),
}));

import { compactEmbeddedPiSession } from "../../agents/pi-embedded.js";

function createMockParams(overrides: Partial<HandleCommandsParams> = {}): HandleCommandsParams {
  return {
    ctx: { Body: "/reset-context" } as HandleCommandsParams["ctx"],
    cfg: {} as HandleCommandsParams["cfg"],
    command: {
      surface: "telegram",
      channel: "telegram",
      ownerList: [],
      isAuthorizedSender: true,
      senderId: "user123",
      rawBodyNormalized: "/reset-context",
      commandBodyNormalized: "/reset-context",
    },
    agentId: "main",
    directives: {},
    elevated: { enabled: false, allowed: false, failures: [] },
    sessionEntry: {
      sessionId: "test-session-id",
      totalTokens: 50000,
      contextTokens: 200000,
    } as HandleCommandsParams["sessionEntry"],
    sessionStore: {},
    sessionKey: "test-session",
    storePath: "/tmp/sessions.json",
    workspaceDir: "/tmp/workspace",
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => "low",
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    contextTokens: 200000,
    isGroup: false,
    ...overrides,
  } as HandleCommandsParams;
}

describe("handleResetContextCommand", () => {
  it("returns null for non-reset-context commands", async () => {
    const params = createMockParams({
      command: {
        ...createMockParams().command,
        commandBodyNormalized: "/help",
      },
    });
    const result = await handleResetContextCommand(params, true);
    expect(result).toBeNull();
  });

  it("ignores unauthorized senders", async () => {
    const params = createMockParams({
      command: {
        ...createMockParams().command,
        isAuthorizedSender: false,
      },
    });
    const result = await handleResetContextCommand(params, true);
    expect(result).toEqual({ shouldContinue: false });
  });

  it("returns error when session id is missing", async () => {
    const params = createMockParams({
      sessionEntry: undefined,
    });
    const result = await handleResetContextCommand(params, true);
    expect(result?.reply?.text).toContain("недоступен");
    expect(result?.shouldContinue).toBe(false);
  });

  it("happy path: compacts and confirms when context ≤70%", async () => {
    vi.mocked(compactEmbeddedPiSession).mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        tokensBefore: 80000,
        tokensAfter: 40000, // 20% of 200k = well under 70%
      },
    });

    const params = createMockParams();
    const result = await handleResetContextCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("✅");
    expect(result?.reply?.text).toContain("Сжато");
    expect(result?.reply?.text).toContain("20%"); // 40k / 200k = 20%
  });

  it("warns when context >70% after compaction", async () => {
    vi.mocked(compactEmbeddedPiSession).mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        tokensBefore: 180000,
        tokensAfter: 150000, // 75% of 200k = over 70%
      },
    });

    const params = createMockParams();
    const result = await handleResetContextCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("⚠️");
    expect(result?.reply?.text).toContain("слишком большой");
    expect(result?.reply?.text).toContain("75%");
    expect(result?.reply?.text).toContain("/new");
  });
});
