import { afterEach, describe, expect, it } from "vitest";
import { classifyAbort, isNonRetryableAbort, isRestartAbort } from "./abort-classifier.js";
import { setGatewayRestarting, __testing } from "./restart.js";

afterEach(() => {
  __testing.resetSigusr1State();
});

function makeAbortError(message = "aborted"): Error {
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

describe("classifyAbort", () => {
  it("returns null for non-abort errors", () => {
    expect(classifyAbort(new Error("network"))).toBeNull();
    expect(classifyAbort(null)).toBeNull();
    expect(classifyAbort("string")).toBeNull();
  });

  it("classifies restart abort when gateway is restarting", () => {
    setGatewayRestarting(true);
    expect(classifyAbort(makeAbortError())).toBe("restart");
  });

  it("classifies transient abort when gateway is NOT restarting", () => {
    expect(classifyAbort(makeAbortError())).toBe("transient");
  });

  it("classifies user cancellation via cause.source", () => {
    const err = makeAbortError();
    (err as unknown as { cause: unknown }).cause = { source: "user" };
    expect(classifyAbort(err)).toBe("user");
  });

  it("classifies timeout abort via cause", () => {
    const cause = new Error("request timed out");
    cause.name = "TimeoutError";
    const err = makeAbortError();
    (err as unknown as { cause: unknown }).cause = cause;
    expect(classifyAbort(err)).toBe("timeout");
  });

  it("classifies timeout abort via reason string", () => {
    const err = makeAbortError();
    (err as unknown as { reason: string }).reason = "deadline exceeded";
    expect(classifyAbort(err)).toBe("timeout");
  });

  it("recognizes undici abort message without AbortError name", () => {
    const err = new Error("This operation was aborted");
    expect(classifyAbort(err)).toBe("transient");
  });
});

describe("isRestartAbort", () => {
  it("returns true only during restart", () => {
    const err = makeAbortError();
    expect(isRestartAbort(err)).toBe(false);
    setGatewayRestarting(true);
    expect(isRestartAbort(err)).toBe(true);
  });
});

describe("isNonRetryableAbort", () => {
  it("restart abort is non-retryable", () => {
    setGatewayRestarting(true);
    expect(isNonRetryableAbort(makeAbortError())).toBe(true);
  });

  it("user cancel is non-retryable", () => {
    const err = makeAbortError();
    (err as unknown as { cause: unknown }).cause = { source: "user" };
    expect(isNonRetryableAbort(err)).toBe(true);
  });

  it("transient abort IS retryable", () => {
    expect(isNonRetryableAbort(makeAbortError())).toBe(false);
  });

  it("timeout abort IS retryable", () => {
    const err = makeAbortError();
    (err as unknown as { cause: unknown }).cause = new Error("timed out");
    expect(isNonRetryableAbort(err)).toBe(false);
  });

  it("non-abort errors are not classified", () => {
    expect(isNonRetryableAbort(new Error("network"))).toBe(false);
  });
});
