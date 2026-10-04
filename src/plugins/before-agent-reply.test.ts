import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureAgentRunLifecycleGeneration,
  withAgentRunLifecycleGeneration,
} from "../infra/agent-events.js";
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

function runHook(runId: string) {
  return runBeforeAgentReplyForTurn({
    runId,
    trigger: "user",
    event: { cleanedBody: runId },
    context: { runId, trigger: "user" },
  });
}

describe("before_agent_reply runner boundary", () => {
  beforeEach(() => {
    hookRunner.hasHooks.mockReset().mockReturnValue(true);
    hookRunner.runBeforeAgentReply.mockReset().mockResolvedValue(undefined);
  });

  it("keeps authority through observer finalization and rejects revoked effects", async () => {
    let current = true;
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
            current = false;
            await Promise.resolve();
            finalAuthority?.();
            effect();
            return result;
          },
        },
        () =>
          runBeforeAgentReplyForTurn({
            runId: "finalization-authority",
            trigger: "cron",
            event: { cleanedBody: "hello" },
            context: { trigger: "cron" },
            assertCurrent: () => {
              if (!current) {
                throw new Error("root reassigned");
              }
            },
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
    await runBeforeAgentReplyForTurn({
      runId,
      trigger: "user",
      event: { cleanedBody: runId },
      context,
    });

    const expectedContext = { ...context, trigger: "user" };
    expect(hookRunner.hasHooks).toHaveBeenCalledWith("before_agent_reply", expectedContext);
    expect(hookRunner.runBeforeAgentReply).toHaveBeenCalledWith(
      { cleanedBody: runId },
      expectedContext,
    );
  });

  it("does not dispatch for internal triggers", async () => {
    const trigger = "manual";
    await expect(
      runBeforeAgentReplyForTurn({
        runId: trigger,
        trigger,
        event: { cleanedBody: trigger },
        context: { runId: trigger, trigger },
      }),
    ).resolves.toBeUndefined();

    expect(hookRunner.hasHooks).not.toHaveBeenCalled();
    expect(hookRunner.runBeforeAgentReply).not.toHaveBeenCalled();
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

  it("defers its own hook until normal execution resumes without consuming the claim", async () => {
    let privatePreparation = true;
    const handled: string[] = [];
    hookRunner.runBeforeAgentReply.mockImplementation(async (_event, context) => {
      handled.push(context.runId);
      return { handled: true, reply: { text: `handled ${context.runId}` } };
    });
    await withAgentRunLifecycleGeneration(
      captureAgentRunLifecycleGeneration("deferred-parent"),
      () =>
        withBeforeAgentReplyObserver({ shouldDispatch: () => !privatePreparation }, async () => {
          expect(await runHook("deferred-parent")).toBeUndefined();
          expect(handled).toEqual([]);
          // A child has independent hook authority even while the parent's hook is deferred.
          expect(await runHook("independent-child")).toMatchObject({ handled: true });
          privatePreparation = false;
          expect(await runHook("deferred-parent")).toMatchObject({
            handled: true,
            reply: { text: "handled deferred-parent" },
          });
          await runHook("deferred-parent");
        }),
    );
    expect(handled).toEqual(["independent-child", "deferred-parent"]);
  });
});
