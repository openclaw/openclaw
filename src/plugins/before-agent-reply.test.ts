import { beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { captureGuardedFetchRequestAuthority } from "../infra/net/fetch-request-authority.js";
import {
  buildHandledBeforeAgentReplyPayloads,
  runBeforeAgentReplyForTurn,
  withBeforeAgentReplyObserver,
} from "./before-agent-reply.js";

const hookRunner = vi.hoisted(() => ({
  hasHooks: vi.fn(),
  runBeforeAgentReply: vi.fn(),
}));

vi.mock("./hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookRunner,
}));

function runHook(
  runId: string,
  overrides: Partial<Parameters<typeof runBeforeAgentReplyForTurn>[0]> = {},
) {
  return runBeforeAgentReplyForTurn({
    runId,
    trigger: "user",
    event: { cleanedBody: runId },
    context: { runId, trigger: "user" },
    ...overrides,
  });
}

describe("before_agent_reply runner boundary", () => {
  beforeEach(() => {
    hookRunner.hasHooks.mockReset().mockReturnValue(true);
    hookRunner.runBeforeAgentReply.mockReset().mockResolvedValue(undefined);
  });

  it.each(["settled", "failed", "revoked"] as const)(
    "settles attribution before observer or reply-claim effects (%s)",
    async (outcome) => {
      const entered = createDeferred();
      const baseline = createDeferred();
      const authority = new AbortController();
      const beforeDispatch = vi.fn(async () => undefined);
      const afterDispatch = vi.fn(async (result) => result);
      const pending = withBeforeAgentReplyObserver({ beforeDispatch, afterDispatch }, () =>
        runHook(`attribution-${outcome}`, {
          awaitSessionDiffBaseline: async () => {
            entered.resolve();
            await baseline.promise;
          },
          assertCurrent: () => authority.signal.throwIfAborted(),
        }),
      );
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          pending,
          "Reply hook bypassed attribution",
        );
        expect(beforeDispatch).not.toHaveBeenCalled();
        expect(hookRunner.runBeforeAgentReply).not.toHaveBeenCalled();
        const error = outcome === "failed" ? "attribution failed" : "reply authority ended";
        if (outcome === "failed") {
          baseline.reject(new Error(error));
        } else {
          if (outcome === "revoked") {
            authority.abort(new Error("reply authority ended"));
          }
          baseline.resolve();
        }
        await (outcome === "settled" ? pending : expect(pending).rejects.toThrow(error));
        const dispatches = outcome === "settled" ? 1 : 0;
        expect(beforeDispatch).toHaveBeenCalledTimes(dispatches);
        expect(hookRunner.runBeforeAgentReply).toHaveBeenCalledTimes(dispatches);
      } finally {
        baseline.resolve();
        await pending.catch(() => undefined);
      }
    },
  );

  it.each([
    { name: "no reply-claim hook", trigger: "user", hasHooks: false, lookups: 1 },
    { name: "an internal trigger", trigger: "manual", hasHooks: true, lookups: 0 },
  ])(
    "does not dispatch or wait for attribution with $name",
    async ({ trigger, hasHooks, lookups }) => {
      hookRunner.hasHooks.mockReturnValue(hasHooks);
      const awaitSessionDiffBaseline = vi.fn(async () => {});
      await expect(
        runHook(`no-dispatch-${trigger}`, {
          trigger,
          context: { trigger },
          awaitSessionDiffBaseline,
        }),
      ).resolves.toBeUndefined();
      expect(awaitSessionDiffBaseline).not.toHaveBeenCalled();
      expect(hookRunner.hasHooks).toHaveBeenCalledTimes(lookups);
      expect(hookRunner.runBeforeAgentReply).not.toHaveBeenCalled();
    },
  );

  it("keeps authority through observer finalization and rejects revoked effects", async () => {
    const authority = new AbortController();
    let finalAuthority: (() => void) | undefined;
    const effect = vi.fn();
    hookRunner.runBeforeAgentReply.mockResolvedValue({ handled: true });
    await expect(
      withBeforeAgentReplyObserver(
        {
          beforeDispatch: async () => undefined,
          afterDispatch: async (result) => {
            finalAuthority = captureGuardedFetchRequestAuthority();
            expect(finalAuthority).toBeTypeOf("function");
            finalAuthority?.();
            authority.abort(new Error("root reassigned"));
            await Promise.resolve();
            finalAuthority?.();
            effect();
            return result;
          },
        },
        () =>
          runHook("finalization-authority", {
            trigger: "cron",
            context: { trigger: "cron" },
            assertCurrent: () => authority.signal.throwIfAborted(),
          }),
      ),
    ).rejects.toThrow("root reassigned");
    expect(effect).not.toHaveBeenCalled();
    expect(finalAuthority).toThrow("no longer active");
  });

  it("preserves the complete reply payload", () => {
    const reply = {
      text: "claimed",
      channelData: { native: true },
      sensitiveMedia: true,
      videoAsNote: true,
    };

    expect(buildHandledBeforeAgentReplyPayloads(reply)).toEqual([reply]);
  });

  it("uses the validated turn trigger when context disagrees", async () => {
    const runId = "mismatch";
    const context = { runId, trigger: "heartbeat" };
    await runHook(runId, { context });

    const expectedContext = { ...context, trigger: "user" };
    expect(hookRunner.hasHooks).toHaveBeenCalledWith("before_agent_reply", expectedContext);
    expect(hookRunner.runBeforeAgentReply).toHaveBeenCalledWith(
      { cleanedBody: runId },
      expectedContext,
    );
  });

  it("keeps a nested run from checkpointing its parent admission", async () => {
    const beforeDispatch = vi.fn(async () => undefined);
    const afterDispatch = vi.fn(async (result) => result);
    hookRunner.runBeforeAgentReply.mockImplementation(async (_event, context) => {
      if (context.runId === "parent") {
        await runHook("child");
      }
      return undefined;
    });

    await withBeforeAgentReplyObserver({ beforeDispatch, afterDispatch }, () => runHook("parent"));

    expect(hookRunner.runBeforeAgentReply).toHaveBeenCalledTimes(2);
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(afterDispatch).toHaveBeenCalledOnce();
  });
});
