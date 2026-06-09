import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import { markCompleteReplyConfig } from "./get-reply-fast-path.js";
import { buildTestCtx } from "./test-ctx.js";
import type { TypingController } from "./typing.js";

const { handleCommandsMock } = vi.hoisted(() => ({
  handleCommandsMock: vi.fn(),
}));

vi.mock("./commands.runtime.js", () => ({
  handleCommands: (...args: unknown[]) => handleCommandsMock(...args),
}));

const { maybeResolveNativeSlashCommandFastReply } =
  await import("./get-reply-native-slash-fast-path.js");

const createTypingController = (): TypingController => ({
  onReplyStart: async () => {},
  startTypingLoop: async () => {},
  startTypingOnText: async () => {},
  refreshTypingTtl: () => {},
  isActive: () => false,
  markRunComplete: () => {},
  markDispatchIdle: () => {},
  cleanup: vi.fn(),
});

describe("maybeResolveNativeSlashCommandFastReply", () => {
  beforeEach(() => {
    handleCommandsMock.mockReset();
  });

  it("marks native /compact terminal replies for delivery under message_tool_only (#87107)", async () => {
    handleCommandsMock.mockResolvedValueOnce({
      shouldContinue: false,
      reply: { text: "⚙️ Compaction skipped: no real conversation messages yet • Context 12.1k" },
    });

    const typing = createTypingController();
    const ctx = buildTestCtx({
      Body: "/compact",
      CommandBody: "/compact",
      CommandSource: "native",
      CommandAuthorized: true,
      SessionKey: "telegram:slash:123",
      CommandTargetSessionKey: "agent:main:main",
      CommandTurn: {
        kind: "native",
        source: "native",
        authorized: true,
        body: "/compact",
      },
    });

    const result = await maybeResolveNativeSlashCommandFastReply({
      ctx,
      cfg: markCompleteReplyConfig({
        session: { store: "/tmp/openclaw-native-slash-sessions.json" },
      } as OpenClawConfig),
      agentId: "main",
      agentDir: "/tmp/agent",
      agentCfg: undefined,
      commandAuthorized: true,
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      aliasIndex: { byKey: new Map(), byAlias: new Map() },
      provider: "openai",
      model: "gpt-5.5",
      workspaceDir: "/tmp/workspace",
      typing,
    });

    expect(handleCommandsMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      handled: true,
      reply: expect.objectContaining({
        text: "⚙️ Compaction skipped: no real conversation messages yet • Context 12.1k",
      }),
    });
    if (!result.handled) {
      throw new Error("expected handled");
    }
    expect(
      getReplyPayloadMetadata(result.reply as object)?.deliverDespiteSourceReplySuppression,
    ).toBe(true);
    expect(typing.cleanup).toHaveBeenCalledTimes(1);
  });
});
