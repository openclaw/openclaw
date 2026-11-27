// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { ComposerDictationSession, placeComposerDictation } from "./composer-dictation-session.ts";
import {
  controllers,
  createClient,
  emit,
  request,
  sessionResult,
  transcript,
} from "./composer-dictation.test-support.ts";
import { ComposerDictationOwner } from "./composer-dictation.ts";

async function start(onCapture = vi.fn(() => vi.fn())) {
  const onCommit = vi.fn();
  const options = {
    client: createClient(),
    connected: true,
    enabled: true,
    realtimeTalkActive: false,
    onError: vi.fn(),
    onCommit,
    onCapture,
  };
  const controller = new ComposerDictationOwner(options);
  controllers.push(controller);
  const sessionStart = vi.spyOn(ComposerDictationSession.prototype, "start");
  expect(controller.startDirect()).toBe(true);
  await vi.dynamicImportSettled();
  await sessionStart.mock.results.at(-1)?.value;
  return { controller, options, onCommit, review: onCapture.mock.results.at(-1)?.value };
}

describe("file-reference capture finality", () => {
  it("waits for successful close acknowledgement after completed final event", async () => {
    const close = createDeferred();
    request.mockImplementation(async (method) =>
      method === "talk.session.create"
        ? sessionResult()
        : method === "talk.session.close"
          ? close.promise
          : {},
    );
    const { controller, onCommit, review } = await start();
    transcript("reference file a.ts end reference");
    const stopped = controller.finishActive();
    await vi.advanceTimersByTimeAsync(0);
    emit({ type: "close", reason: "completed" });
    await vi.advanceTimersByTimeAsync(0);
    expect(onCommit).not.toHaveBeenCalled();
    close.resolve();
    await stopped;
    expect(onCommit).toHaveBeenCalledOnce();
    expect(review).toHaveBeenCalledExactlyOnceWith(undefined, true);
  });

  it.each(["partial-only", "late-partial", "close-error", "rpc-error", "disconnect", "timeout"])(
    "keeps %s transcript outside reference review",
    async (failure) => {
      if (failure === "rpc-error") {
        request.mockImplementation(async (method) => {
          if (method === "talk.session.create") {
            return sessionResult();
          }
          if (method === "talk.session.close") {
            throw new Error("synthetic close failure");
          }
          return {};
        });
      }
      const { controller, options, review } = await start();
      if (failure === "partial-only") {
        emit({ type: "partial", text: "reference file a.ts end reference" });
      } else {
        transcript("reference file a.ts end reference");
      }
      const stopped = controller.finishActive();
      await vi.advanceTimersByTimeAsync(0);
      if (failure === "late-partial") {
        emit({ type: "partial", text: "unfinished" });
      }
      if (failure === "disconnect") {
        // The actual pending-session owner receives disconnect through its regular update.
        controller.update({ ...options, connected: false });
      } else if (failure === "timeout") {
        await vi.advanceTimersByTimeAsync(10001);
      } else {
        emit({ type: "close", reason: failure === "close-error" ? "error" : "completed" });
      }
      await stopped;
      expect(review?.mock.calls.some(([, final]) => final === true)).toBe(false);
    },
  );

  it.each(["cancel", "disconnect", "late-partial", "late-error"])(
    "fences %s while close acknowledgement is pending",
    async (failure) => {
      const close = createDeferred();
      request.mockImplementation(async (method) =>
        method === "talk.session.create"
          ? sessionResult()
          : method === "talk.session.close"
            ? close.promise
            : {},
      );
      const { controller, options, onCommit, review } = await start();
      transcript("reference file a.ts end reference");
      const stopped = controller.finishActive();
      await vi.advanceTimersByTimeAsync(0);
      emit({ type: "close", reason: "completed" });
      await vi.advanceTimersByTimeAsync(0);
      expect(controller.transcribing).toBe(true);
      if (failure === "cancel") {
        controller.cancel();
      }
      if (failure === "disconnect") {
        controller.update({ ...options, connected: false });
      }
      if (failure === "late-partial") {
        emit({ type: "partial", text: "unfinished" });
      }
      if (failure === "late-error") {
        emit({ type: "error", message: "synthetic late failure" });
      }
      if (failure === "cancel" || failure === "disconnect") {
        await stopped;
      }
      close.resolve();
      await stopped;
      expect(review?.mock.calls.some(([, final]) => final === true)).toBe(false);
      if (failure === "cancel") {
        expect(onCommit).not.toHaveBeenCalled();
      }
      expect(controller.transcribing).toBe(false);
    },
  );

  it("reports only actual UTF-16-safe inserted bytes in the placement range", () => {
    const result = placeComposerDictation("🦊 reference file a.ts end reference", null, {
      value: "Hi ",
      start: 3,
      end: 3,
      maxLength: 6,
    });
    expect(result.value).toBe("Hi 🦊 ");
    expect(result.value.slice(result.from, result.to)).toBe("🦊 ");
    expect(result.previousValue).toBe("Hi ");
  });
});
