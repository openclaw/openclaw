import { expect, it, vi } from "vitest";
import type { runReplyAgent } from "./agent-runner-run.js";
import type { runPreparedReply } from "./get-reply-run.js";
import {
  baseParams,
  createInboundTurn,
  createProviderSurface,
  createSessionTurn,
} from "./get-reply-run.test-support.js";
import { createCurrentReplyFacts } from "./get-reply.test-fixtures.js";
import {
  buildInboundUserContextPrefix,
  resolveInboundUserContextPromptJoiner,
} from "./inbound-meta.js";

export function registerCurrentReplyContextCases({
  runPrepared,
  requireRunReplyAgentCall,
  turn,
}: {
  runPrepared: (
    overrides?: Partial<Parameters<typeof runPreparedReply>[0]>,
  ) => ReturnType<typeof runPreparedReply>;
  requireRunReplyAgentCall: (index?: number) => Parameters<typeof runReplyAgent>[0];
  turn: (
    body: string,
    context: Record<string, unknown>,
  ) => Partial<Parameters<typeof runPreparedReply>[0]>;
}): void {
  it("threads inbound context as current-turn context without changing transcript text", async () => {
    vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce(
      ["Current message:", '[Replying to: "quoted status body"]', "#34974 obviyus:"].join("\n"),
    );
    vi.mocked(resolveInboundUserContextPromptJoiner).mockReturnValueOnce(" ");

    await runPrepared({
      ctx: { ...createInboundTurn("what does this mean?", "telegram", "group") },
      sessionCtx: {
        ...createSessionTurn("what does this mean?", "telegram", "group"),
        ReplyToSender: "Jake",
        ReplyToBody: "quoted status body",
        ReplyToIsQuote: true,
      },
    });

    const call = requireRunReplyAgentCall();
    const context = call.followupRun.currentInboundContext;
    expect(call.commandBody).toContain("what does this mean?");
    expect(call.commandBody).not.toContain("Reply target of current user message");
    expect(call.transcriptCommandBody).toBe("what does this mean?");
    expect(call.followupRun.prompt).toContain("what does this mean?");
    expect(call.followupRun.transcriptPrompt).toBe("what does this mean?");
    expect(context?.promptJoiner).toBe(" ");
    expect(context?.text).toContain("Current message:");
    expect(context?.text).toContain('[Replying to: "quoted status body"]');
    expect(context?.text).not.toContain("Reply target of current user message");
    expect(context?.reply).toEqual(createCurrentReplyFacts(true));
  });

  it("runs bare mention replies when the reply target is the current-turn context", async () => {
    vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce(
      [
        "Reply target of current user message:",
        "```json",
        JSON.stringify({ sender_label: "Bot", body: "quoted status body" }, null, 2),
        "```",
      ].join("\n"),
    );

    const result = await runPrepared({
      ...turn("", {
        ...createProviderSurface("telegram"),
        ChatType: "group",
        RawBody: "@bot",
        CommandBody: "@bot",
        ReplyToBody: "quoted status body",
        ReplyToSender: "Bot",
      }),
      command: {
        ...baseParams().command,
        rawBodyNormalized: "@bot",
        commandBodyNormalized: "",
      } as never,
    });

    expect(result).toEqual({ text: "ok" });
    const call = requireRunReplyAgentCall(-1);
    const context = call.followupRun.currentInboundContext;
    expect(call.transcriptCommandBody).toBe("");
    expect(call.followupRun.prompt).toBe("");
    expect(call.followupRun.transcriptPrompt).toBe("");
    expect(context?.text).toContain("Reply target of current user message");
    expect(context?.text).toContain("quoted status body");
    expect(context?.reply).toEqual(createCurrentReplyFacts(false));
  });
}
