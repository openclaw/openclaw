import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GetReplyOptions } from "../types.js";
import {
  createInlineToolDispatchFixture,
  createOpenClawToolsMock,
  mockCallArgs,
  runTestInlineActions,
} from "./get-reply-inline-actions.test-support.js";

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: () => undefined,
  getLoadedChannelPlugin: () => undefined,
  listChannelPlugins: () => [],
  normalizeChannelId: (value?: string) => value?.trim().toLowerCase() || null,
}));

describe("inline tool execution ownership", () => {
  beforeEach(() => {
    createOpenClawToolsMock.mockReset();
  });

  it.each(["before start", "at start", "during execution", "successful completion"] as const)(
    "preserves admitted inline tool ownership (%s)",
    async (revocation) => {
      const source = new AbortController();
      const execution = new AbortController();
      const revoked = new Error("operator authority ended");
      const entered = createDeferred();
      const settleTool = createDeferred();
      const order: string[] = [];
      const onAgentRunStart = vi.fn<NonNullable<GetReplyOptions["onAgentRunStart"]>>(() => {
        order.push("start");
        const cancel = () => execution.abort(source.signal.reason);
        if (source.signal.aborted) {
          cancel();
        } else {
          source.signal.addEventListener("abort", cancel, { once: true });
        }
      });
      const { typing, toolExecute, ctx, skillCommands } = createInlineToolDispatchFixture({
        body: "/send_status hello",
        toolName: "message",
        execute: async () => {
          order.push("execute");
          entered.resolve();
          if (execution.signal.aborted) {
            settleTool.resolve();
          } else {
            execution.signal.addEventListener("abort", () => settleTool.resolve(), { once: true });
          }
          await settleTool.promise;
          execution.signal.throwIfAborted();
          return { content: "sent" };
        },
        skill: { name: "send_status", skillName: "send-status", description: "Send status" },
        sourceFilePath: "/tmp/plugin/commands/send-status.md",
      });
      if (revocation === "before start" || revocation === "at start") {
        source.abort(revoked);
      }
      if (revocation === "before start") {
        execution.abort(revoked);
      }
      const result = runTestInlineActions({
        ctx,
        typing,
        cleanedBody: "/send_status hello",
        command: { isAuthorizedSender: true, senderIsOwner: true, senderId: "sender-1" },
        overrides: {
          cfg: { commands: { text: true } },
          allowTextCommands: true,
          skillCommands,
          opts: { runId: "inline-tool-run", abortSignal: execution.signal, onAgentRunStart },
        },
      });
      try {
        await Promise.race([entered.promise, result]);
        if (revocation === "before start") {
          expect(onAgentRunStart).not.toHaveBeenCalled();
        } else {
          expect(onAgentRunStart).toHaveBeenCalledExactlyOnceWith("inline-tool-run", undefined, {
            completionSource: "reply-dispatch",
            getResult: expect.any(Function),
          });
          expect(onAgentRunStart.mock.calls[0]?.[2]?.getResult()).toEqual({});
        }
        if (revocation === "during execution" || revocation === "successful completion") {
          expect(order).toEqual(["start", "execute"]);
          expect(mockCallArgs(toolExecute, "toolExecute")[2]).toBe(execution.signal);
          if (revocation === "during execution") {
            source.abort(revoked);
            expect(execution.signal.aborted).toBe(true);
          } else {
            settleTool.resolve();
          }
        } else {
          expect(toolExecute).not.toHaveBeenCalled();
        }
        await expect(result).resolves.toMatchObject({
          kind: "reply",
          reply: {
            text:
              revocation === "successful completion"
                ? "sent"
                : expect.stringContaining("operator authority ended"),
          },
        });
        expect(typing.cleanup).toHaveBeenCalledOnce();
      } finally {
        source.abort(revoked);
        execution.abort(revoked);
        await result;
      }
    },
  );
});
