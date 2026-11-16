import { expect, it, vi } from "vitest";
import { runReplyAgent } from "./agent-runner-run.js";
import {
  baseParams,
  jsonContext,
  createPreparedReplyTurn as turn,
} from "./get-reply-run.test-support.js";
import type { RunPreparedReplyParams } from "./get-reply-run.types.js";
import { buildInboundUserContextPrefix } from "./inbound-meta.js";

export function registerEmptyInputTypingCases(
  runPrepared: (overrides: Partial<RunPreparedReplyParams>) => Promise<unknown>,
) {
  it.each([undefined, "visible_delivery"] as const)(
    "rejects blank pending inbound history (%s)",
    async (typingStartPolicy) => {
      const typing = {
        ...baseParams().typing,
        onReplyStart: vi.fn(async () => undefined),
        markRunComplete: vi.fn(),
        cleanup: vi.fn(),
      };
      vi.mocked(buildInboundUserContextPrefix).mockReturnValueOnce(
        jsonContext("Chat history since last reply:", [
          { sender: "Alice", timestamp_ms: 1_700_000_000_000, body: "" },
        ]),
      );

      const result = await runPrepared({
        typing,
        opts: { typingStartPolicy },
        ...turn(
          "",
          { ChatType: "group", WasMentioned: true },
          {
            Provider: "feishu",
            OriginatingChannel: "feishu",
            OriginatingTo: "chat-1",
            InboundHistory: [{ sender: "Alice", timestamp: 1_700_000_000_000, body: "\u0000  " }],
          },
        ),
      });

      expect(result).toEqual({
        text: "I didn't receive any text in your message. Please resend or add a caption.",
      });
      if (typingStartPolicy === "visible_delivery") {
        expect(typing.onReplyStart).not.toHaveBeenCalled();
        expect(typing.markRunComplete).toHaveBeenCalledOnce();
        expect(typing.cleanup).not.toHaveBeenCalled();
      }
      expect(vi.mocked(runReplyAgent)).not.toHaveBeenCalled();
    },
  );
}
