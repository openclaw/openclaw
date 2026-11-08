import { beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import type { GetReplyOptions } from "../types.js";
import { runInlineFixture } from "./get-reply-inline-actions.shard-test-support.js";
import {
  createInlineToolDispatchFixture,
  createOpenClawToolsMock,
  createTypingController,
  mockCallArgs,
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

function dispatchFixture(kind: "command" | "skill", execute = async () => ({ content: "sent" })) {
  const body = kind === "command" ? "/export-session" : "/send_status hello";
  const skill =
    kind === "skill"
      ? createInlineToolDispatchFixture({
          body,
          toolName: "message",
          execute,
          skill: { name: "send_status", skillName: "send-status", description: "Send status" },
          sourceFilePath: "/tmp/plugin/commands/send-status.md",
        })
      : undefined;
  const typing = skill?.typing ?? createTypingController();
  return {
    ...(skill ?? { ctx: buildTestCtx({ Body: body, CommandBody: body }), typing }),
    effect: skill?.toolExecute ?? handleCommandsMock,
  };
}

beforeEach(() => {
  createOpenClawToolsMock.mockReset();
  handleCommandsMock.mockReset().mockResolvedValue({ shouldContinue: true, reply: undefined });
});

it.each([
  ["command", "settled"],
  ["command", "failed"],
  ["command", "authority revoked"],
  ["skill", "settled"],
  ["skill", "failed"],
  ["skill", "authority revoked"],
] as const)("waits for workspace attribution before %s dispatch (%s)", async (kind, outcome) => {
  const entered = createDeferred();
  const baseline = createDeferred();
  let active = true;
  const fixture = dispatchFixture(kind);
  const { effect } = fixture;
  const result = runInlineFixture(
    fixture,
    {
      opts: {
        awaitSessionDiffBaseline: async () => {
          entered.resolve();
          await baseline.promise;
        },
      },
    },
    {
      assertOwnerCurrent: () => {
        if (!active) {
          throw new Error("command authority ended");
        }
      },
    },
  );
  try {
    await awaitGateBeforeSettlement(entered.promise, result, "Dispatch bypassed attribution");
    expect(effect).not.toHaveBeenCalled();
    if (outcome === "failed") {
      baseline.reject(new Error("attribution failed"));
    } else {
      active = outcome !== "authority revoked";
      baseline.resolve();
    }
    const error = outcome === "failed" ? "attribution failed" : "command authority ended";
    if (kind === "command" && outcome !== "settled") {
      await expect(result).rejects.toThrow(error);
    } else {
      const text = outcome === "settled" ? "sent" : expect.stringContaining(error);
      await expect(result).resolves.toMatchObject(
        kind === "command" ? { kind: "continue" } : { kind: "reply", reply: { text } },
      );
    }
    expect(effect).toHaveBeenCalledTimes(outcome === "settled" ? 1 : 0);
  } finally {
    baseline.resolve();
    await result.catch(() => undefined);
  }
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
    const fixture = dispatchFixture("skill", async () => {
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
    });
    if (revocation === "before start" || revocation === "at start") {
      source.abort(revoked);
    }
    if (revocation === "before start") {
      execution.abort(revoked);
    }
    const { typing, effect: toolExecute } = fixture;
    const result = runInlineFixture(
      fixture,
      { opts: { runId: "inline-tool-run", abortSignal: execution.signal, onAgentRunStart } },
      { senderId: "sender-1" },
    );
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
      const text =
        revocation === "successful completion" ? "sent" : expect.stringContaining(revoked.message);
      await expect(result).resolves.toMatchObject({ kind: "reply", reply: { text } });
      expect(typing.cleanup).toHaveBeenCalledOnce();
    } finally {
      source.abort(revoked);
      execution.abort(revoked);
      await result;
    }
  },
);
