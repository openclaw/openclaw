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

vi.mock("../../config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions.js")>();
  return {
    ...actual,
    resolveSessionFilePath: vi.fn().mockReturnValue("/tmp/test-session.jsonl"),
    resolveSessionFilePathOptions: vi.fn().mockReturnValue({}),
    resolveFreshSessionTotalTokens: vi.fn().mockReturnValue(100_000),
  };
});

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
import type { HandleCommandsParams } from "./commands-types.js";

function buildParams(overrides: Partial<HandleCommandsParams> = {}): HandleCommandsParams {
  return {
    command: {
      commandBodyNormalized: "/compact",
      isAuthorizedSender: true,
      senderIsOwner: true,
      ownerList: [],
      channel: "test",
      senderId: "test-user",
      surface: "test",
      rawBodyNormalized: "/compact",
    },
    sessionEntry: {
      sessionId: `test-session-${Date.now()}`,
    } as HandleCommandsParams["sessionEntry"],
    sessionKey: "main",
    ctx: {
      CommandBody: "/compact",
      RawBody: "/compact",
      Body: "/compact",
    } as HandleCommandsParams["ctx"],
    cfg: {} as HandleCommandsParams["cfg"],
    isGroup: false,
    storePath: "/tmp",
    agentId: "main",
    contextTokens: 50_000,
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    resolvedThinkLevel: undefined,
    resolvedVerboseLevel: "off" as const,
    resolvedReasoningLevel: "off" as const,
    resolveDefaultThinkingLevel: vi.fn().mockResolvedValue("default"),
    workspaceDir: "/tmp",
    agentDir: "/tmp",
    directives: {} as HandleCommandsParams["directives"],
    elevated: { enabled: false, allowed: false, failures: [] },
    defaultGroupActivation: () => "always" as const,
    ...overrides,
  } as HandleCommandsParams;
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
    const result = await handleCompactCommand(params, true);
    expect(result).not.toBeNull();
    expect(result?.reply?.text).toContain("Compacted");
  });

  it("blocks rapid second compaction with cooldown message", async () => {
    const sessionId = "cooldown-test-session";
    const params = buildParams({
      sessionEntry: { sessionId } as HandleCommandsParams["sessionEntry"],
    });

    const first = await handleCompactCommand(params, true);
    expect(first?.reply?.text).toContain("Compacted");

    const second = await handleCompactCommand(params, true);
    expect(second?.reply?.text).toContain("already run recently");
  });

  it("allows compaction after cooldown expires", async () => {
    const sessionId = "cooldown-expire-test";
    const params = buildParams({
      sessionEntry: { sessionId } as HandleCommandsParams["sessionEntry"],
    });

    await handleCompactCommand(params, true);

    vi.advanceTimersByTime(16_000);

    const result = await handleCompactCommand(params, true);
    expect(result?.reply?.text).toContain("Compacted");
  });
});
