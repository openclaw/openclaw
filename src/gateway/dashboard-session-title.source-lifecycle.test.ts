import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  utility: vi.fn(),
  readTranscript: vi.fn(),
  load: vi.fn(),
  patch: vi.fn(),
}));

vi.mock("../agents/utility-model.js", () => ({
  resolveUtilityModelRefForAgent: mocks.utility,
}));
vi.mock("../auto-reply/reply/conversation-label-generator.js", () => ({
  generateConversationLabelWithFallback: mocks.generate,
}));
vi.mock("../config/sessions/session-accessor.js", () => ({
  patchSessionEntryCore: mocks.patch,
  loadSessionEntry: mocks.load,
}));
vi.mock("./session-transcript-title-reader.js", () => ({
  readSessionTitleFieldsFromTranscript: mocks.readTranscript,
}));

import type { WorktreeSourceStage } from "../agents/worktrees/types.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runWithAsyncWorkResources } from "../shared/async-work-resources.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  generateWorktreeSessionTitle,
  maybeGenerateSessionTitle,
} from "./dashboard-session-title.js";

const cfg: OpenClawConfig = {
  agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
};
const baseEntry: SessionEntry = { sessionId: "source-title-session", updatedAt: 1 };
let current: SessionEntry;

function titleParams(name: string) {
  return {
    cfg,
    agentId: "main",
    entry: baseEntry,
    sessionId: baseEntry.sessionId,
    sessionKey: `agent:main:dashboard:source-${name}`,
    storePath: "/synthetic/title-sessions.sqlite",
    userMessage: "Help me plan the release",
  };
}

function sourceStages(
  context: AsyncLocalStorage<string>,
  unwindFailure?: { after: Promise<void>; error: Error },
) {
  const entered: string[] = [];
  const closed: string[] = [];
  const asserted: string[] = [];
  const active = new Set<string>();
  const withSource: WorktreeSourceStage = async (run) => {
    const stage = `source:${entered.length + 1}`;
    entered.push(stage);
    active.add(stage);
    return await context.run(stage, async () => {
      try {
        const result = await run({
          assertCurrent: () => {
            if (!active.has(stage) || context.getStore() !== stage) {
              throw new Error("source stage is no longer current");
            }
            asserted.push(stage);
          },
        });
        if (unwindFailure) {
          await unwindFailure.after;
          throw unwindFailure.error;
        }
        return result;
      } finally {
        active.delete(stage);
        closed.push(stage);
      }
    });
  };
  return { withSource, entered, closed, asserted, active };
}

beforeEach(() => {
  current = { ...baseEntry };
  mocks.generate.mockReset();
  mocks.utility.mockReset().mockReturnValue(undefined);
  mocks.readTranscript.mockReset().mockReturnValue({
    firstUserMessage: null,
    lastMessagePreview: null,
  });
  mocks.load.mockReset().mockImplementation(() => ({ ...current }));
  mocks.patch.mockReset().mockImplementation(async (_scope, update, options) => {
    const patch = await update({ ...current });
    options.assertCommitAllowed?.();
    if (patch) {
      current = { ...current, ...patch };
    }
    return { ...current };
  });
});

describe("worktree title source lifecycle", () => {
  it.each([false, true])(
    "uses fresh source authority for persistence (late completion: %s)",
    async (late) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const context = new AsyncLocalStorage<string>();
      const owner = new AsyncWorkScope();
      const source = sourceStages(context);
      const started = createDeferredCore();
      const continueGeneration = createDeferredCore();
      const persisted = createDeferredCore();
      const generationContexts: Array<string | undefined> = [];
      let continuationAborted: boolean | undefined;
      let writeContext: string | undefined;
      let acceptanceContext: string | undefined;
      let writeAssertions: string[] = [];
      mocks.generate.mockImplementation(async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
        generationContexts.push(context.getStore());
        started.resolve();
        await continueGeneration.promise;
        generationContexts.push(context.getStore());
        continuationAborted = abortSignal?.aborted;
        return "Scoped release planning";
      });
      mocks.load.mockImplementation(() => {
        if (current.displayName) {
          acceptanceContext = context.getStore();
        }
        return { ...current };
      });
      mocks.patch.mockImplementation(async (_scope, update, options) => {
        const patch = await update({ ...current });
        await Promise.resolve();
        writeContext = context.getStore();
        const before = source.asserted.length;
        options.assertCommitAllowed?.();
        writeAssertions = source.asserted.slice(before);
        current = { ...current, ...patch };
        return { ...current };
      });
      const onError = vi.fn();
      const onPersisted = vi.fn(() => persisted.resolve());
      const request = context.run("caller", () =>
        owner.run(() =>
          generateWorktreeSessionTitle({
            ...titleParams("success"),
            withSource: source.withSource,
            onError,
            onPersisted,
          }),
        ),
      );
      const settled = request.then(
        () => undefined,
        () => undefined,
      );
      try {
        await Promise.race([
          started.promise,
          request.then(() => {
            throw new Error("title completed before generation started");
          }),
        ]);
        await nextTurn();
        expect(source.entered.length).toBeGreaterThan(0);
        expect(source.closed).toEqual(source.entered);
        expect(source.active.size).toBe(0);
        expect(mocks.patch).not.toHaveBeenCalled();
        if (late) {
          await vi.advanceTimersByTimeAsync(30_000);
          await expect(request).resolves.toBeUndefined();
          expect(onError).toHaveBeenCalledOnce();
        }
        continueGeneration.resolve();
        await persisted.promise;
        if (!late) {
          await expect(request).resolves.toBe("Scoped release planning");
          expect(source.entered).toContain(acceptanceContext);
          expect(acceptanceContext).not.toBe(writeContext);
          expect(acceptanceContext).not.toBe(source.entered[0]);
          expect(onError).not.toHaveBeenCalled();
        }
        expect(generationContexts).toEqual(["caller", "caller"]);
        expect(continuationAborted).toBe(false);
        expect(source.entered).toContain(writeContext);
        expect(writeContext).not.toBe(source.entered[0]);
        expect(writeAssertions).toEqual([writeContext]);
        expect(source.closed).toEqual(source.entered);
        expect(onPersisted).toHaveBeenCalledOnce();
        expect(current.displayName).toBe("Scoped release planning");
      } finally {
        continueGeneration.resolve();
        await settled;
        await owner.drain();
        context.disable();
        vi.useRealTimers();
      }
    },
  );

  it("keeps duplicate cancellation separate from the original title owner", async () => {
    const context = new AsyncLocalStorage<string>();
    const owner = new AsyncWorkScope();
    const duplicateOwner = new AsyncWorkScope();
    const source = sourceStages(context);
    const started = createDeferredCore();
    const generation = createDeferredCore<string>();
    let signal: AbortSignal | undefined;
    let cancellationContext: string | undefined;
    let duplicateSources = 0;
    const duplicateSource: WorktreeSourceStage = async () => {
      duplicateSources += 1;
      throw new Error("duplicate must not acquire title generation custody");
    };
    mocks.generate.mockImplementation(async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
      signal = abortSignal;
      if (abortSignal) {
        abortSignal.addEventListener(
          "abort",
          () => {
            cancellationContext = context.getStore();
            generation.reject(abortSignal.reason);
          },
          { once: true },
        );
      }
      started.resolve();
      return await generation.promise;
    });
    const params = titleParams("duplicate");
    const first = context.run("owner", () =>
      owner.run(() => maybeGenerateSessionTitle({ ...params, withSource: source.withSource })),
    );
    const settled = first.then(
      () => undefined,
      () => undefined,
    );
    try {
      await Promise.race([
        started.promise,
        first.then(() => {
          throw new Error("title completed before generation started");
        }),
      ]);
      const duplicate = context.run("duplicate", () =>
        duplicateOwner.run(() =>
          maybeGenerateSessionTitle({ ...params, withSource: duplicateSource }),
        ),
      );
      context.run("duplicate", () => duplicateOwner.beginClose(new Error("duplicate closed")));
      await duplicateOwner.drain();
      expect(signal?.aborted).toBe(false);
      expect(duplicateSources).toBe(0);

      const originalClosed = new Error("original title owner closed");
      const duplicateRejected = expect(duplicate).rejects.toBe(originalClosed);
      context.run("unrelated", () => owner.beginClose(originalClosed));
      await expect(first).rejects.toBe(originalClosed);
      await duplicateRejected;
      expect(signal?.reason).toBe(originalClosed);
      expect(cancellationContext).toBe("owner");
      expect(mocks.generate).toHaveBeenCalledOnce();
      expect(mocks.patch).not.toHaveBeenCalled();
      expect(source.closed).toEqual(source.entered);
    } finally {
      generation.resolve("Fixture cleanup");
      await settled;
      await Promise.all([owner.drain(), duplicateOwner.drain()]);
      context.disable();
    }
  });

  it("joins async resource cleanup before rejecting a generation source unwind failure", async () => {
    const context = new AsyncLocalStorage<string>();
    const owner = new AsyncWorkScope();
    const failure = new Error("source scope unwind failed");
    const generationAcquired = createDeferredCore();
    const source = sourceStages(context, { after: generationAcquired.promise, error: failure });
    const cleanupStarted = createDeferredCore();
    const finishCleanup = createDeferredCore();
    const events: string[] = [];
    let signal: AbortSignal | undefined;
    let cancellationContext: string | undefined;
    let cleanupContext: string | undefined;
    let requestSettled = false;
    mocks.generate.mockImplementation(({ abortSignal }: { abortSignal?: AbortSignal }) => {
      signal = abortSignal;
      if (abortSignal) {
        abortSignal.addEventListener(
          "abort",
          () => {
            cancellationContext = context.getStore();
            events.push("cancelled");
          },
          { once: true },
        );
      }
      return runWithAsyncWorkResources(async (onAcquired) => {
        onAcquired({
          release: async () => {
            cleanupContext = context.getStore();
            events.push("cleanup-started");
            cleanupStarted.resolve();
            await finishCleanup.promise;
            events.push("cleanup-finished");
          },
        });
        generationAcquired.resolve();
        events.push("logical-result");
        return "Unpublished title";
      });
    });
    const request = context.run("caller", () =>
      owner.run(() =>
        maybeGenerateSessionTitle({ ...titleParams("unwind"), withSource: source.withSource }),
      ),
    );
    const outcome = request.then(
      (value) => {
        requestSettled = true;
        events.push("resolved");
        return { value };
      },
      (error: unknown) => {
        requestSettled = true;
        events.push("rejected");
        return { error };
      },
    );
    try {
      await Promise.race([
        cleanupStarted.promise,
        outcome.then(() => {
          throw new Error("title settled before cleanup started");
        }),
      ]);
      await nextTurn();
      expect(source.closed).toEqual(["source:1"]);
      expect(signal?.aborted).toBe(true);
      expect(signal?.reason).toBe(failure);
      expect(cancellationContext).toBe("caller");
      expect(cleanupContext).toBe("caller");
      expect(events).toContain("logical-result");
      expect(requestSettled).toBe(false);
      expect(mocks.patch).not.toHaveBeenCalled();
      finishCleanup.resolve();
      await expect(outcome).resolves.toEqual({ error: failure });
      expect(events.indexOf("cleanup-finished")).toBeLessThan(events.indexOf("rejected"));
      expect(current).toEqual(baseEntry);
    } finally {
      generationAcquired.resolve();
      finishCleanup.resolve();
      await outcome;
      await owner.drain();
      context.disable();
    }
  });

  it("cancels generation when its parent closes and joins its owned resource cleanup", async () => {
    const context = new AsyncLocalStorage<string>();
    const owner = new AsyncWorkScope();
    const source = sourceStages(context);
    const started = createDeferredCore();
    const generation = createDeferredCore<string>();
    const cleanupStarted = createDeferredCore();
    const finishCleanup = createDeferredCore();
    let signal: AbortSignal | undefined;
    let cancellationContext: string | undefined;
    let cleanupContext: string | undefined;
    let cleanupFinished = false;
    let requestSettled = false;
    mocks.generate.mockImplementation(({ abortSignal }: { abortSignal?: AbortSignal }) => {
      signal = abortSignal;
      abortSignal?.addEventListener(
        "abort",
        () => {
          cancellationContext = context.getStore();
          generation.reject(abortSignal.reason);
        },
        { once: true },
      );
      return runWithAsyncWorkResources(async (onAcquired) => {
        onAcquired({
          release: async () => {
            cleanupContext = context.getStore();
            cleanupStarted.resolve();
            await finishCleanup.promise;
            cleanupFinished = true;
          },
        });
        started.resolve();
        return await generation.promise;
      });
    });
    const request = context.run("caller", () =>
      owner.run(() =>
        maybeGenerateSessionTitle({ ...titleParams("timeout"), withSource: source.withSource }),
      ),
    );
    const outcome = request.then(
      (value) => {
        requestSettled = true;
        return { value };
      },
      (error: unknown) => {
        requestSettled = true;
        return { error };
      },
    );
    try {
      await started.promise;
      await nextTurn();
      expect(source.closed).toEqual(source.entered);
      const cancellation = new Error("title owner closed");
      context.run("unrelated", () => owner.beginClose(cancellation));
      await nextTurn();
      expect(signal?.aborted).toBe(true);
      expect(signal?.reason).toBe(cancellation);
      expect(cancellationContext).toBe("caller");
      await cleanupStarted.promise;
      expect(cleanupContext).toBe("caller");
      expect(requestSettled).toBe(false);
      expect(mocks.patch).not.toHaveBeenCalled();
      finishCleanup.resolve();
      await expect(outcome).resolves.toEqual({ error: signal?.reason });
      expect(cleanupFinished).toBe(true);
      expect(current).toEqual(baseEntry);
    } finally {
      context.run("caller", () => owner.beginClose(new Error("Fixture cleanup")));
      generation.resolve("Fixture cleanup");
      finishCleanup.resolve();
      try {
        await outcome;
        await owner.drain();
      } finally {
        context.disable();
      }
    }
  });
});
