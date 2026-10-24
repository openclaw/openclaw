import { describe, expect, it, vi } from "vitest";
import { SessionTranscriptProjectionUnavailableError } from "../../config/sessions/session-transcript-projection-error.js";
import {
  classifyAcceptedChatSendFailure,
  createAcceptedChatSendRetry,
  shouldRetainAcceptedChatSendRetryIdentity,
} from "./chat-send-retry.js";

const projectionError = new SessionTranscriptProjectionUnavailableError("sess-main");

describe("accepted chat-send retry classification", () => {
  it.each([
    [{ error: projectionError, phase: "pre-ack" }, "client-retry"],
    [{ error: projectionError, phase: "post-ack" }, "retry"],
    [{ error: new Error("dispatch failed"), phase: "post-ack" }, "terminal"],
    [
      { error: new Error("dispatch failed"), phase: "post-ack", executionStarted: true },
      "reconcile",
    ],
    [
      { error: new Error("dispatch failed"), phase: "post-ack", sideEffectsObserved: true },
      "reconcile",
    ],
  ] as const)("classifies %j as %s", (params, expected) => {
    expect(classifyAcceptedChatSendFailure(params)).toBe(expected);
  });

  it("drops same-ID retry authority only for reconciliation-only failures", () => {
    expect(shouldRetainAcceptedChatSendRetryIdentity("reconcile")).toBe(false);
    expect(shouldRetainAcceptedChatSendRetryIdentity("terminal")).toBe(true);
    expect(shouldRetainAcceptedChatSendRetryIdentity("retry")).toBe(true);
  });

  it("stops at the bounded attempt count", async () => {
    const operation = vi.fn().mockRejectedValue(projectionError);
    const waitForRetry = vi.fn().mockResolvedValue(undefined);

    await expect(
      createAcceptedChatSendRetry({
        waitForRetry,
        classify: (error) => classifyAcceptedChatSendFailure({ error, phase: "post-ack" }),
      })(operation),
    ).rejects.toBe(projectionError);

    expect(operation).toHaveBeenCalledTimes(3);
    expect(waitForRetry).toHaveBeenCalledTimes(2);
  });

  it("shares the bounded retry budget between setup and the admitted resolver", async () => {
    const resolver = vi.fn().mockRejectedValue(projectionError);
    const waitForRetry = vi.fn().mockResolvedValue(undefined);
    const retry = createAcceptedChatSendRetry({
      waitForRetry,
      classify: (error) => classifyAcceptedChatSendFailure({ error, phase: "post-ack" }),
    });
    let setupAttempts = 0;
    await expect(
      retry(async () => {
        setupAttempts += 1;
        if (setupAttempts === 1) {
          throw projectionError;
        }
        return await retry(resolver);
      }),
    ).rejects.toBe(projectionError);

    expect(setupAttempts).toBe(2);
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(waitForRetry).toHaveBeenCalledTimes(2);
  });
});

it.each([false, true])(
  "never replays a dispatch after SQLite contention (effects=%s)",
  async (effects) => {
    const error = Object.assign(new Error("database is locked"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 5,
    });
    const operation = vi.fn().mockRejectedValue(error);
    const waitForRetry = vi.fn();
    await expect(
      createAcceptedChatSendRetry({
        waitForRetry,
        classify: (failure) =>
          classifyAcceptedChatSendFailure({
            error: failure,
            phase: "post-ack",
            sideEffectsObserved: effects,
          }),
      })(operation),
    ).rejects.toBe(error);
    expect(operation).toHaveBeenCalledOnce();
    expect(waitForRetry).not.toHaveBeenCalled();
  },
);
