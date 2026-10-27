import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { describe, expect, it } from "vitest";
import { PreparedModelRuntimeRecoveryError } from "../../agents/prepared-model-runtime-admission-errors.js";
import {
  createIngressRetryPolicy,
  DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
  resolveIngressRetryDelayMs,
  shouldDeadLetterRetryableIngressEvent,
} from "./ingress-retry-policy.js";

const codedError = (message: string, code: string) => Object.assign(new Error(message), { code });
const wrapError = (cause: Error) =>
  Object.assign(new Error("BotError in middleware"), {
    error: new Error("telegram spooled update processing failed", { cause }),
  });

function disposition(
  err: unknown,
  attempts: number,
  options: Partial<Parameters<ReturnType<typeof createIngressRetryPolicy>["failure"]>[0]> = {},
) {
  return createIngressRetryPolicy({}).failure({
    err,
    event: { id: "input", receivedAt: 1_000, attempts },
    formatError: coerceErrorMessage,
    now: 2_000,
    ...options,
  });
}

describe("ingress retry policy", () => {
  it("counts real recovery failures independently of other dispatch attempts", () => {
    const policy = createIngressRetryPolicy({});
    const error = wrapError(new PreparedModelRuntimeRecoveryError("main", "attempt-failed", 7_000));
    const event = { id: "input", receivedAt: 1_000, attempts: 8 };
    const fail = (err: unknown) =>
      policy.failure({ err, event, formatError: coerceErrorMessage, now: 2_000 });
    expect(fail(error)).toMatchObject({
      kind: "release",
      attempt: 9,
      recordAttempt: true,
    });
    expect(fail(new Error("transient dispatch failure"))).toMatchObject({ kind: "release" });
    expect(fail(error)).toMatchObject({
      kind: "fail",
      reason: "runtime-recovery-failed",
    });
    policy.clear(event.id);
    expect(fail(error)).toMatchObject({ kind: "release" });
  });

  it("preserves backoff across drains of the same live queue without spending an attempt", () => {
    const queue = {};
    const policy = createIngressRetryPolicy(queue);
    const event = { id: "input", receivedAt: 1_000, attempts: 1 };
    const fail = (reason: "attempt-failed" | "backoff") =>
      policy.failure({
        err: new PreparedModelRuntimeRecoveryError("main", reason, 7_000),
        event,
        formatError: coerceErrorMessage,
      });
    expect(fail("attempt-failed")).toMatchObject({ kind: "release" });
    expect(fail("backoff")).toMatchObject({ kind: "release", attempt: 1, recordAttempt: false });
    const nextDrain = createIngressRetryPolicy(queue);
    expect(nextDrain.delay(event, undefined, 2_000)).toBe(5_000);
    expect(nextDrain.delay(event, undefined, 7_000)).toBe(0);
    expect(fail("attempt-failed")).toMatchObject({
      kind: "fail",
      reason: "runtime-recovery-failed",
    });
  });

  it("isolates queue owners and clears recovery state for completed rows", () => {
    const policy = createIngressRetryPolicy({});
    const event = { id: "input", receivedAt: 1_000 };
    const params = {
      err: new PreparedModelRuntimeRecoveryError("main", "attempt-failed", 7_000),
      event,
      formatError: coerceErrorMessage,
    };
    policy.failure(params);
    expect(createIngressRetryPolicy({}).delay(event, undefined, 2_000)).toBe(0);
    policy.clear(event.id);
    expect(policy.delay(event, undefined, 2_000)).toBe(0);
    expect(policy.failure(params)).toMatchObject({ kind: "release" });
    policy.clear(event.id);
    expect(policy.delay(event, undefined, 2_000)).toBe(0);
  });

  it.each([
    {
      name: "default cap",
      config: undefined,
      expected: [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 180_000, 180_000],
    },
    {
      name: "independent exponent cap",
      config: { baseMs: 1_000, maxMs: 1_000_000 },
      expected: [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 256_000],
    },
  ])("preserves the exact retry schedule through attempt 10: $name", ({ config, expected }) => {
    expect(
      expected.map((_, index) =>
        resolveIngressRetryDelayMs(
          {
            receivedAt: 0,
            attempts: index + 1,
            lastAttemptAt: 0,
            lastError: "boom",
          },
          config,
          0,
        ),
      ),
    ).toEqual(expected);
  });

  it.each([
    {
      name: "no prior error → immediate",
      event: { receivedAt: 0, attempts: 2 },
      now: 10_000,
      expected: 0,
    },
    {
      name: "attempt 1 → base delay remaining",
      event: {
        receivedAt: 0,
        attempts: 1,
        lastAttemptAt: 1000,
        lastError: "boom",
      },
      now: 1500,
      expected: 500,
    },
    {
      name: "attempt 3 → exponential delay remaining",
      event: {
        receivedAt: 0,
        attempts: 3,
        lastAttemptAt: 1000,
        lastError: "boom",
      },
      // base * 2^(3-1) = 4000; remaining from t=1000 at now=2000 → 3000
      now: 2000,
      expected: 3000,
    },
    {
      name: "past window → 0",
      event: {
        receivedAt: 0,
        attempts: 1,
        lastAttemptAt: 1000,
        lastError: "boom",
      },
      now: 5000,
      expected: 0,
    },
  ])("retry delay: $name", ({ event, now, expected }) => {
    expect(resolveIngressRetryDelayMs(event, undefined, now)).toBe(expected);
  });

  it("does not dead-letter an old event below the attempt floor", () => {
    const receivedAt = 1_000;
    expect(
      shouldDeadLetterRetryableIngressEvent(
        { receivedAt },
        DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS - 1,
        undefined,
        receivedAt + DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS + 1,
      ),
    ).toBe(false);
  });

  it("disposition prefers non-retryable fail", () => {
    expect(
      disposition(new Error("missing harness"), 0, {
        now: undefined,
        formatError: (err) => String(err),
        resolveNonRetryableFailure: () => ({
          reason: "missing-agent-harness",
          message: "missing harness",
        }),
      }),
    ).toEqual({
      kind: "fail",
      reason: "missing-agent-harness",
      message: "missing harness",
      attempt: 1,
    });
  });

  it("disposition dead-letters only when both gates pass", () => {
    const attempt = DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS - 1;
    const deadline = 1_000 + DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS;
    const young = disposition(new Error("transient"), attempt, { now: deadline - 1 });
    expect(young.kind).toBe("release");
    const aged = disposition(new Error("transient"), attempt, { now: deadline });
    expect(aged).toMatchObject({
      kind: "fail",
      reason: "retry-limit-exceeded",
      attempt: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
    });
  });

  it("dead-letters a restart tombstone by structured code instead of wording", () => {
    const message = "This generation is terminal.";
    const tombstone = codedError(message, "SESSION_RESTART_RECOVERY_TOMBSTONE");
    const wrapped = wrapError(tombstone);
    expect(
      disposition(wrapped, 0, {
        config: { maxAttempts: 8, deadLetterMinAgeMs: 24 * 60 * 60 * 1000 },
      }),
    ).toEqual({
      kind: "fail",
      reason: "restart-recovery-tombstone",
      message: wrapped.message,
      attempt: 1,
    });
    expect(disposition(tombstone, 425)).toMatchObject({
      kind: "fail",
      reason: "restart-recovery-tombstone",
      attempt: 426,
    });
  });

  it.each([undefined, "SESSION_WORK_START_INVALIDATED"])(
    "keeps tombstone-like text retryable without its code: %s",
    (code) => {
      const err = Object.assign(
        new Error("Session ended during restart recovery. Use /new or /reset."),
        { code },
      );
      expect(disposition(err, 0)).toEqual({ kind: "release", attempt: 1, message: err.message });
    },
  );

  it.each(["code", "cause", "errors"])(
    "releases a transient failure when its %s getter throws",
    (field) => {
      const err = Object.defineProperty(new Error("temporary failure"), field, {
        get() {
          throw new Error("unavailable diagnostic field");
        },
      });
      expect(disposition(err, 0)).toEqual({
        kind: "release",
        attempt: 1,
        message: "temporary failure",
      });
    },
  );

  it("finds the terminal code beside an inaccessible wrapper field", () => {
    const err = Object.assign(new Error("reply admission refused"), {
      error: Object.assign(new Error("terminal generation"), {
        code: "SESSION_RESTART_RECOVERY_TOMBSTONE",
      }),
    });
    Object.defineProperty(err, "cause", {
      get() {
        throw new Error("unavailable diagnostic field");
      },
    });
    expect(disposition(err, 0)).toEqual({
      kind: "fail",
      reason: "restart-recovery-tombstone",
      attempt: 1,
      message: "reply admission refused",
    });
  });

  it("keeps wrapped session-start conflicts under both retry and age gates", () => {
    const maxAttempts = 3;
    const message = 'Session "agent:main:telegram:direct:1" changed while starting work. Retry.';
    const wrapped = wrapError(codedError(message, "SESSION_WORK_START_CHANGED"));
    const config = { maxAttempts };
    const beforeLimit = disposition(wrapped, maxAttempts - 2, { config });
    expect(beforeLimit).toMatchObject({
      kind: "release",
      attempt: maxAttempts - 1,
    });
    expect(disposition(new Error(message), maxAttempts - 1, { config })).toMatchObject({
      kind: "release",
      attempt: maxAttempts,
    });
    expect(
      disposition(codedError(message, "SESSION_WORK_START_INVALIDATED"), maxAttempts - 1, {
        config,
      }),
    ).toMatchObject({ kind: "release", attempt: maxAttempts });
    const atLimit = disposition(wrapped, maxAttempts - 1, { config });
    expect(atLimit).toEqual({
      kind: "release",
      message: wrapped.message,
      attempt: maxAttempts,
    });
    expect(
      disposition(wrapped, maxAttempts - 1, {
        config: { maxAttempts },
        now: 1_000 + DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
      }),
    ).toMatchObject({ kind: "fail", reason: "retry-limit-exceeded", attempt: maxAttempts });
  });
});
