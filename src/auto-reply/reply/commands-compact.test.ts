import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { parseInlineDirectives } from "./directive-handling.js";

vi.mock("../../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn(),
  compactEmbeddedPiSession: vi.fn(async () => ({
    ok: true,
    compacted: true,
    result: {
      summary: "Compacted",
      firstKeptEntryId: "entry-1",
      tokensBefore: 20,
      tokensAfter: 10,
    },
  })),
  isEmbeddedPiRunActive: vi.fn(() => false),
  waitForEmbeddedPiRunEnd: vi.fn(async () => undefined),
}));

vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: vi.fn(async ({ run }) => {
    const provider = "fallback-provider";
    const model = "fallback-model";
    const result = await run(provider, model);
    return { result, provider, model, attempts: [] };
  }),
}));

vi.mock("../../agents/pi-embedded-helpers.js", () => ({
  isTransientHttpError: vi.fn(() => false),
}));

vi.mock("../../config/sessions.js", () => ({
  resolveFreshSessionTotalTokens: vi.fn(() => 0),
  resolveSessionFilePath: vi.fn(() => "/tmp/session.jsonl"),
  resolveSessionFilePathOptions: vi.fn(() => ({})),
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));

vi.mock("../status.js", () => ({
  formatContextUsageShort: vi.fn(() => "context"),
  formatTokenCount: vi.fn(() => "count"),
}));

vi.mock("./mentions.js", () => ({
  stripMentions: vi.fn((text) => text),
  stripStructuralPrefixes: vi.fn((text) => text),
}));

vi.mock("./session-updates.js", () => ({
  incrementCompactionCount: vi.fn(async () => undefined),
}));

import { runWithModelFallback } from "../../agents/model-fallback.js";
import { isTransientHttpError } from "../../agents/pi-embedded-helpers.js";
import { compactEmbeddedPiSession } from "../../agents/pi-embedded.js";
import { handleCompactCommand } from "./commands-compact.js";

describe("handleCompactCommand", () => {
  const makeParams = (): HandleCommandsParams =>
    ({
      ctx: { CommandBody: "/compact" } as HandleCommandsParams["ctx"],
      cfg: {} as OpenClawConfig,
      command: {
        commandBodyNormalized: "/compact",
        channel: "test-channel",
        from: "user",
        to: "bot",
        isAuthorizedSender: true,
        senderId: "user",
        channelId: "chan",
        ownerList: [],
        senderIsOwner: true,
        rawBodyNormalized: "/compact",
        surface: "direct",
      },
      agentId: "agent",
      directives: parseInlineDirectives("/compact"),
      elevated: { enabled: false, allowed: false, failures: [] },
      sessionEntry: {
        sessionId: "sess",
        updatedAt: Date.now(),
        sessionFile: "/tmp/sess",
        groupId: undefined,
        groupChannel: undefined,
        space: undefined,
        spawnedBy: undefined,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        contextTokens: 0,
        skillsSnapshot: undefined,
        groupActivationNeedsSystemIntro: false,
      },
      sessionStore: {},
      sessionKey: "sessKey",
      sessionScope: "per-sender",
      workspaceDir: "/tmp/ws",
      storePath: "/tmp/store",
      defaultGroupActivation: () => "always",
      resolvedThinkLevel: "high",
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "off",
      resolvedElevatedLevel: "off",
      resolveDefaultThinkingLevel: async () => undefined,
      provider: "primary-provider",
      model: "primary-model",
      contextTokens: 0,
      isGroup: false,
      skillCommands: [],
    }) as const;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs compaction through model fallback execution path", async () => {
    await handleCompactCommand(makeParams(), true);

    expect(runWithModelFallback).toHaveBeenCalled();
    expect(compactEmbeddedPiSession).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "fallback-provider",
        model: "fallback-model",
      }),
    );
  });

  it("retries with fallback model when primary compaction fails", async () => {
    vi.mocked(runWithModelFallback).mockImplementationOnce(async ({ run }) => {
      try {
        await run("primary-provider", "primary-model");
      } catch {
        // expected: first attempt fails
      }
      const result = await run("fallback-provider", "fallback-model");
      return {
        result,
        provider: "fallback-provider",
        model: "fallback-model",
        attempts: [],
      };
    });

    vi.mocked(compactEmbeddedPiSession)
      .mockResolvedValueOnce({
        ok: false,
        compacted: false,
        reason: "500 overloaded",
      })
      .mockResolvedValueOnce({
        ok: true,
        compacted: true,
        result: {
          summary: "Compacted",
          firstKeptEntryId: "entry-1",
          tokensBefore: 20,
          tokensAfter: 10,
        },
      });

    await handleCompactCommand(makeParams(), true);

    expect(compactEmbeddedPiSession).toHaveBeenCalledTimes(2);
    expect(compactEmbeddedPiSession).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ provider: "primary-provider", model: "primary-model" }),
    );
    expect(compactEmbeddedPiSession).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ provider: "fallback-provider", model: "fallback-model" }),
    );
  });

  it("retries the full fallback cycle once for transient HTTP errors", async () => {
    vi.useFakeTimers();
    vi.mocked(runWithModelFallback)
      .mockRejectedValueOnce(new Error("502 Bad Gateway"))
      .mockResolvedValueOnce({
        result: {
          ok: true,
          compacted: true,
          result: {
            summary: "Compacted",
            firstKeptEntryId: "entry-1",
            tokensBefore: 20,
            tokensAfter: 10,
          },
        },
        provider: "fallback-provider",
        model: "fallback-model",
        attempts: [],
      });
    vi.mocked(isTransientHttpError).mockImplementation((text: string) => text.includes("502"));

    const pending = handleCompactCommand(makeParams(), true);
    await vi.advanceTimersByTimeAsync(2_500);
    await pending;

    expect(runWithModelFallback).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("rethrows AbortError without retrying", async () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    vi.mocked(runWithModelFallback).mockRejectedValueOnce(abortError);

    await expect(handleCompactCommand(makeParams(), true)).rejects.toBe(abortError);
    expect(runWithModelFallback).toHaveBeenCalledTimes(1);
  });
});
