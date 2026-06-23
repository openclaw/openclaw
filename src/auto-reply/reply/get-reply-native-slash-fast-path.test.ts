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

  it("marks native /compact terminal replies for delivery under message_tool_only (#90185)", async () => {
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
        commandName: "compact",
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
    if (!result.reply || Array.isArray(result.reply)) {
      throw new Error("expected single reply payload");
    }
    expect(getReplyPayloadMetadata(result.reply)?.deliverDespiteSourceReplySuppression).toBe(true);
    expect(typing.cleanup).toHaveBeenCalledTimes(1);
  });

  it("handles authorized text slash commands before model dispatch", async () => {
    handleCommandsMock.mockResolvedValueOnce({
      shouldContinue: false,
      reply: { text: "Trajectory exports can include prompts." },
    });

    const typing = createTypingController();
    const ctx = buildTestCtx({
      Body: "/export-trajectory bundle",
      BodyForCommands: "/export-trajectory bundle",
      CommandBody: "/export-trajectory bundle",
      CommandSource: "text",
      CommandAuthorized: true,
      SessionKey: "agent:dev:webchat",
      Provider: "webchat",
      Surface: "webchat",
      OriginatingChannel: "webchat",
      ChatType: "direct",
      CommandTurn: {
        kind: "text-slash",
        source: "text",
        authorized: true,
        commandName: "export-trajectory",
        body: "/export-trajectory bundle",
      },
    });

    const result = await maybeResolveNativeSlashCommandFastReply({
      ctx,
      cfg: markCompleteReplyConfig({
        session: { store: "/tmp/openclaw-text-slash-sessions.json" },
      } as OpenClawConfig),
      agentId: "dev",
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
        text: "Trajectory exports can include prompts.",
      }),
    });
    if (!result.handled || !result.reply || Array.isArray(result.reply)) {
      throw new Error("expected single handled reply");
    }
    expect(getReplyPayloadMetadata(result.reply)?.deliverDespiteSourceReplySuppression).toBe(true);
    expect(typing.cleanup).toHaveBeenCalledTimes(1);
  });

  it("leaves external text slash commands on the canonical session path", async () => {
    const typing = createTypingController();
    const ctx = buildTestCtx({
      Body: "/export-trajectory bundle",
      BodyForCommands: "/export-trajectory bundle",
      CommandBody: "/export-trajectory bundle",
      CommandSource: "text",
      CommandAuthorized: true,
      SessionKey: "agent:dev:telegram:group:123",
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "group",
      CommandTurn: {
        kind: "text-slash",
        source: "text",
        authorized: true,
        commandName: "export-trajectory",
        body: "/export-trajectory bundle",
      },
    });

    const result = await maybeResolveNativeSlashCommandFastReply({
      ctx,
      cfg: markCompleteReplyConfig({
        session: { store: "/tmp/openclaw-external-text-slash-sessions.json" },
      } as OpenClawConfig),
      agentId: "dev",
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

    expect(result).toEqual({ handled: false });
    expect(handleCommandsMock).not.toHaveBeenCalled();
    expect(typing.cleanup).not.toHaveBeenCalled();
  });
});
