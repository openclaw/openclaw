import { expect, it, vi } from "vitest";
import type { runReplyAgent } from "./agent-runner-run.js";
import type { runPreparedReply } from "./get-reply-run.js";
import { createInboundBody, createSessionBody } from "./get-reply-run.test-support.js";
import { buildInboundMetaSystemPrompt } from "./inbound-meta.js";

export function registerReplyPromptContextCases({
  runPrepared,
  requireRunReplyAgentCall,
}: {
  runPrepared: (
    overrides?: Partial<Parameters<typeof runPreparedReply>[0]>,
  ) => ReturnType<typeof runPreparedReply>;
  requireRunReplyAgentCall: () => Parameters<typeof runReplyAgent>[0];
}): void {
  it.each(["user_request", "heartbeat", "room_event"] as const)(
    "keeps generated inbound metadata in trusted turn context for %s",
    async (kind) => {
      const inboundMeta =
        await vi.importActual<typeof import("./inbound-meta.js")>("./inbound-meta.js");
      vi.mocked(buildInboundMetaSystemPrompt).mockImplementation(
        inboundMeta.buildInboundMetaSystemPrompt,
      );
      const context = {
        Provider: "telegram",
        Surface: "webchat",
        OriginatingChannel: "telegram",
        AccountId: "work",
        ChatType: "direct",
        ...(kind === "heartbeat"
          ? { InternalTurnSource: "heartbeat" as const }
          : { InboundEventKind: kind }),
      };
      await runPrepared({
        isNewSession: false,
        opts: kind === "heartbeat" ? { isHeartbeat: true } : undefined,
        ctx: { ...createInboundBody("Synthetic turn"), ...context },
        sessionCtx: { ...createSessionBody("Synthetic turn"), ...context },
      });
      const { followupRun } = requireRunReplyAgentCall();
      expect(followupRun.run.extraSystemPrompt ?? "").not.toContain("openclaw.inbound_meta");
      expect(followupRun.run.extraSystemPromptStatic).toBe("");
      const metadata = followupRun.currentInboundContext?.fragments?.find((fragment) =>
        fragment.text.startsWith("### Message Context"),
      );
      expect(metadata?.kind).toBe("runtime-instruction");
      expect(JSON.parse(/```json\n([\s\S]*?)\n```/.exec(metadata?.text ?? "")![1]!)).toEqual({
        schema: "openclaw.inbound_meta.v2",
        account_id: "work",
        channel: "telegram",
        provider: "telegram",
        surface: "webchat",
        chat_type: "direct",
      });
    },
  );

  it("includes current exec overrides in the queued runner prompt", async () => {
    await runPrepared({
      execOverrides: {
        host: "gateway",
        security: "full",
        ask: "always",
        node: "worker-1",
      },
      resolvedElevatedLevel: "off",
    });

    const prompt = requireRunReplyAgentCall().followupRun.run.extraSystemPromptStatic;
    expect(prompt).toContain(
      "Current session exec defaults: host=gateway security=full ask=always node=worker-1.",
    );
    expect(prompt).toContain("Current elevated level: off.");
    expect(prompt).toContain("Do not assume a prior denial still applies");
  });
}
