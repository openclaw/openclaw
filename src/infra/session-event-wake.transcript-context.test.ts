import { afterEach, expect, it } from "vitest";
import {
  getCliHistoryWriter,
  runWithCliHistoryWriter,
} from "../config/sessions/cli-history-boundary.js";
import { runWithoutOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context-owner.js";
import {
  getOwnedSessionTranscriptWriterFence,
  withOwnedSessionTranscriptWrites,
  runWithOwnedSessionTranscriptWrite,
} from "../config/sessions/transcript-write-context.js";
import { AsyncWorkScope, trackAsyncWork } from "../shared/async-work-scope.js";
import {
  requestSessionEventWake,
  requestSessionEventWakeAndWait,
  setSessionEventWakeHandler,
} from "./session-event-wake.js";

let dispose = () => {};

afterEach(() => {
  dispose();
});

// Real timers on purpose: fake timers fire callbacks from the test's own async
// context, so they cannot observe the AsyncLocalStorage inheritance under test.
it("dispatches outside the requesting attempt transcript context", async () => {
  const observedFence = new Promise<ReturnType<typeof getOwnedSessionTranscriptWriterFence>>(
    (resolve) => {
      dispose = setSessionEventWakeHandler(async () => {
        resolve(getOwnedSessionTranscriptWriterFence());
        return { status: "ran", durationMs: 1 };
      });
    },
  );
  await withOwnedSessionTranscriptWrites(
    {
      sessionTarget: { expectedWriterRunId: "disposed-requesting-run" },
      withTranscriptWrite: async (run) => await run(),
    },
    async () =>
      requestSessionEventWake({
        source: "exec-event",
        intent: "event",
        reason: "exec-event",
        coalesceMs: 0,
      }),
  );
  expect(await observedFence).toBeUndefined();
});

it("dispatches queued sessions after the requesting attempt closes its work scope", async () => {
  const executed: string[] = [];
  dispose = setSessionEventWakeHandler(async (request) => {
    try {
      await trackAsyncWork(() => executed.push(request.sessionKey!));
      return { status: "ran", durationMs: 0 };
    } catch (error) {
      return { status: "failed", reason: String(error) };
    }
  });
  const request = (sessionKey: string) =>
    requestSessionEventWakeAndWait({
      source: "exec-event",
      intent: "event",
      reason: "exec-event",
      sessionKey,
      coalesceMs: 0,
    });
  const foreground = new AsyncWorkScope();
  const originating = "agent:main:dashboard:originating";
  const unrelated = "agent:main:dashboard:unrelated";
  const first = foreground.run(() => request(originating));
  const second = request(unrelated);
  await foreground.drain();

  expect(await Promise.all([first, second])).toEqual([
    { status: "ran", durationMs: 0 },
    { status: "ran", durationMs: 0 },
  ]);
  expect(executed).toEqual([originating, unrelated]);
});
it("detaches both writer contexts synchronously and asynchronously, restoring nested custody", async () => {
  const target = {
    agentId: "main",
    sessionId: "owner",
    sessionKey: "agent:main:owner",
    storePath: "/isolated/owner.sqlite",
  };
  const writes: string[] = [];
  const writer = {
    target,
    runId: "cli-owner",
    authFingerprint: "test",
    assertCurrent: () => {},
    assertReadable: () => {},
  };
  const observeDetached = () => {
    expect(getOwnedSessionTranscriptWriterFence()).toBeUndefined();
    expect(getCliHistoryWriter(target)).toBeUndefined();
  };
  await runWithCliHistoryWriter(writer, () =>
    withOwnedSessionTranscriptWrites(
      {
        sessionTarget: { ...target, expectedWriterRunId: "outer" },
        withTranscriptWrite: async (run) => {
          writes.push("outer");
          return await run();
        },
      },
      async () => {
        const observeOuter = () => {
          expect(getOwnedSessionTranscriptWriterFence()?.expectedWriterRunId).toBe("outer");
          expect(getCliHistoryWriter(target)).toBe(writer);
        };
        observeOuter();
        await runWithOwnedSessionTranscriptWrite({ sessionTarget: target }, () => {});
        const detached = runWithoutOwnedSessionTranscriptWrites(async () => {
          observeDetached();
          await Promise.resolve();
          observeDetached();
          await runWithOwnedSessionTranscriptWrite({ sessionTarget: target }, () => {});
        });
        observeOuter();
        await detached;
        observeOuter();
        await withOwnedSessionTranscriptWrites(
          {
            sessionTarget: { ...target, expectedWriterRunId: "inner" },
            withTranscriptWrite: async (run) => {
              writes.push("inner");
              return await run();
            },
          },
          async () => {
            expect(getOwnedSessionTranscriptWriterFence()?.expectedWriterRunId).toBe("inner");
            expect(
              runWithoutOwnedSessionTranscriptWrites(() => {
                observeDetached();
                return 42;
              }),
            ).toBe(42);
            await runWithOwnedSessionTranscriptWrite({ sessionTarget: target }, () => {});
            expect(getOwnedSessionTranscriptWriterFence()?.expectedWriterRunId).toBe("inner");
            expect(getCliHistoryWriter(target)).toBe(writer);
          },
        );
        observeOuter();
        await runWithOwnedSessionTranscriptWrite({ sessionTarget: target }, () => {});
        dispose = setSessionEventWakeHandler(async () => {
          observeDetached();
          await Promise.resolve();
          observeDetached();
          return { status: "ran", durationMs: 0 };
        });
        const result = requestSessionEventWakeAndWait(
          { source: "exec-event", intent: "event", reason: "exec-event", coalesceMs: 0 },
          { onQueued: observeDetached },
        );
        observeOuter();
        expect(await result).toEqual({ status: "ran", durationMs: 0 });
        observeOuter();
      },
    ),
  );
  observeDetached();
  expect(writes).toEqual(["outer", "inner", "outer"]);
});
