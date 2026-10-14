import { beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import type { GetReplyOptions } from "../types.js";
import {
  createInlineToolDispatchFixture,
  createOpenClawToolsMock,
  createTypingController,
  mockCallArgs,
  runTestInlineActions,
} from "./get-reply-inline-actions.test-support.js";
import { buildTestCtx } from "./test-ctx.js";

const { handleCommandsMock } = vi.hoisted(() => ({ handleCommandsMock: vi.fn() }));

// mock-isolation: observe dispatch without running command handlers or their session/export effects.
vi.mock("./commands.js", () => ({ handleCommands: handleCommandsMock }));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: () => undefined,
  getLoadedChannelPlugin: () => undefined,
  listChannelPlugins: () => [],
  normalizeChannelId: (value?: string) => value?.trim().toLowerCase() || null,
}));

describe("inline tool execution ownership", () => {
  beforeEach(() => {
    createOpenClawToolsMock.mockReset();
    handleCommandsMock.mockReset().mockResolvedValue({ shouldContinue: true, reply: undefined });
  });

  it.each(["settled", "failed", "authority revoked"] as const)(
    "waits for workspace attribution before command dispatch (%s)",
    async (outcome) => {
      const entered = createDeferred();
      const baseline = createDeferred();
      let active = true;
      const result = runTestInlineActions({
        ctx: buildTestCtx({ Body: "/export-session", CommandBody: "/export-session" }),
        typing: createTypingController(),
        cleanedBody: "/export-session",
        command: {
          isAuthorizedSender: true,
          senderIsOwner: true,
          assertOwnerCurrent: () => {
            if (!active) {
              throw new Error("command authority ended");
            }
          },
        },
        overrides: {
          cfg: { commands: { text: true } },
          allowTextCommands: true,
          opts: {
            awaitSessionDiffBaseline: async () => {
              entered.resolve();
              await baseline.promise;
            },
          },
        },
      });
      try {
        await awaitGateBeforeSettlement(entered.promise, result, "Command bypassed attribution");
        expect(handleCommandsMock).not.toHaveBeenCalled();
        if (outcome === "failed") {
          baseline.reject(new Error("attribution failed"));
          await expect(result).rejects.toThrow("attribution failed");
        } else if (outcome === "authority revoked") {
          active = false;
          baseline.resolve();
          await expect(result).rejects.toThrow("command authority ended");
        } else {
          baseline.resolve();
          await expect(result).resolves.toMatchObject({ kind: "continue" });
        }
        expect(handleCommandsMock).toHaveBeenCalledTimes(outcome === "settled" ? 1 : 0);
      } finally {
        baseline.resolve();
        await result.catch(() => undefined);
      }
    },
  );

  it.each(["settled", "failed", "authority revoked"] as const)(
    "waits for workspace attribution before direct skill effects (%s)",
    async (outcome) => {
      const entered = createDeferred();
      const baseline = createDeferred();
      let active = true;
      const { typing, toolExecute, ctx, skillCommands } = createInlineToolDispatchFixture({
        body: "/send_status hello",
        toolName: "message",
        execute: async () => ({ content: "sent" }),
        skill: { name: "send_status", skillName: "send-status", description: "Send status" },
        sourceFilePath: "/tmp/plugin/commands/send-status.md",
      });
      const result = runTestInlineActions({
        ctx,
        typing,
        cleanedBody: "/send_status hello",
        command: {
          isAuthorizedSender: true,
          senderIsOwner: true,
          assertOwnerCurrent: () => {
            if (!active) {
              throw new Error("command authority ended");
            }
          },
        },
        overrides: {
          cfg: { commands: { text: true } },
          allowTextCommands: true,
          skillCommands,
          opts: {
            awaitSessionDiffBaseline: async () => {
              entered.resolve();
              await baseline.promise;
            },
          },
        },
      });
      try {
        await awaitGateBeforeSettlement(entered.promise, result, "Skill bypassed attribution");
        expect(toolExecute).not.toHaveBeenCalled();
        if (outcome === "failed") {
          baseline.reject(new Error("attribution failed"));
        } else {
          active = outcome !== "authority revoked";
          baseline.resolve();
        }
        await expect(result).resolves.toMatchObject({
          kind: "reply",
          reply: {
            text:
              outcome === "settled"
                ? "sent"
                : expect.stringContaining(
                    outcome === "failed" ? "attribution failed" : "command authority ended",
                  ),
          },
        });
        expect(toolExecute).toHaveBeenCalledTimes(outcome === "settled" ? 1 : 0);
      } finally {
        baseline.resolve();
        await result;
      }
    },
  );

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
          expect(onAgentRunStart).toHaveBeenCalledExactlyOnceWith(
            "inline-tool-run",
            undefined,
            { completionSource: "reply-dispatch", getResult: expect.any(Function) },
            null,
          );
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
