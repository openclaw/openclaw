import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../agents/pi-embedded.js", () => ({
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  abortEmbeddedPiRun: vi.fn(),
  waitForEmbeddedPiRunEnd: vi.fn().mockResolvedValue(undefined),
  compactEmbeddedPiSession: vi.fn().mockResolvedValue({
    ok: true,
    compacted: true,
    result: { tokensBefore: 50_000, tokensAfter: 10_000 },
  }),
}));

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    loadConfig: vi.fn().mockReturnValue({}),
  };
});

vi.mock("../../config/sessions.js", () => ({
  resolveSessionFilePath: vi.fn().mockReturnValue("/tmp/test-session.jsonl"),
  resolveSessionFilePathOptions: vi.fn().mockReturnValue({}),
  resolveFreshSessionTotalTokens: vi.fn().mockReturnValue(100_000),
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));

vi.mock("./session-updates.js", () => ({
  incrementCompactionCount: vi.fn().mockResolvedValue(undefined),
}));

import { handleCompactCommand } from "./commands-compact.js";

function buildParams(overrides: Record<string, unknown> = {}) {
  return {
    command: {
      commandBodyNormalized: "/compact",
      isAuthorizedSender: true,
      senderIsOwner: true,
      ownerList: [],
      channel: "test",
      senderId: "test-user",
      ...(overrides.command as Record<string, unknown>),
    },
    sessionEntry: {
      sessionId: `test-session-${Date.now()}`,
      ...(overrides.sessionEntry as Record<string, unknown>),
    },
    sessionKey: "main",
    ctx: { CommandBody: "/compact", RawBody: "/compact", Body: "/compact" },
    cfg: {},
    isGroup: false,
    storePath: "/tmp",
    agentId: "main",
    contextTokens: 50_000,
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    resolvedThinkLevel: undefined,
    resolveDefaultThinkingLevel: vi.fn().mockResolvedValue("default"),
    sessionStore: {},
    workspaceDir: "/tmp",
    agentDir: "/tmp",
    ...overrides,
  } as Parameters<typeof handleCompactCommand>[0];
}

describe("handleCompactCommand cooldown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows first compaction", async () => {
    const params = buildParams();
    const result = await handleCompactCommand(params);
    expect(result).not.toBeNull();
    expect(result?.reply?.text).toContain("Compacted");
  });

  it("blocks rapid second compaction with cooldown message", async () => {
    const sessionId = "cooldown-test-session";
    const params = buildParams({
      sessionEntry: { sessionId },
    });

    const first = await handleCompactCommand(params);
    expect(first?.reply?.text).toContain("Compacted");

    const second = await handleCompactCommand(params);
    expect(second?.reply?.text).toContain("already run recently");
  });

  it("allows compaction after cooldown expires", async () => {
    const sessionId = "cooldown-expire-test";
    const params = buildParams({
      sessionEntry: { sessionId },
    });

    await handleCompactCommand(params);

    vi.advanceTimersByTime(16_000);

    const result = await handleCompactCommand(params);
    expect(result?.reply?.text).toContain("Compacted");
  });
});
