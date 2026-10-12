import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAskUserTool,
  isAskUserPromptPending,
  normalizeAskUserParams,
  reserveAskUserPromptDelivery,
} from "./ask-user-tool.js";
import { resetPendingAskUserQuestionsForTest } from "./ask-user-tool.test-support.js";

type GatewayCall = Extract<
  NonNullable<Parameters<typeof createAskUserTool>[0]["gatewayCall"]>,
  (...args: never[]) => unknown
>;

const validArgs = {
  questions: [
    {
      id: "deploy_target",
      header: "Deployment target",
      question: "Where should this deploy?",
      options: [
        { label: "Staging (Recommended)", description: "Safer default" },
        { label: "Production" },
      ],
    },
  ],
};

function gatewayStub(
  implementation: (
    method: string,
    opts: Record<string, unknown>,
    params: Record<string, unknown>,
    extra?: { signal?: AbortSignal },
  ) => Promise<unknown>,
) {
  const mock = vi.fn((...args: Parameters<typeof implementation>) => {
    const response = implementation(...args);
    return response;
  });
  return {
    mock,
    call: mock as unknown as GatewayCall,
  };
}

afterEach(() => {
  resetPendingAskUserQuestionsForTest();
});

describe("ask_user prompt delivery wall-clock skew", () => {
  // Production deadlines seed and read the remaining budget with performance.now()
  // (monotonic) while these tests drive time with vi.useFakeTimers +
  // advanceTimersByTime, which only advance Date.now(). Restore performance.now
  // per-test so it can diverge from Date.now(), modeling an NTP correction or
  // manual clock change mid-prompt. Kept on the describe scope so
  // `typescript(unbound-method)` does not flag a bare `performance.now`.
  let performanceNowSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    performanceNowSpy = vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  });

  it("keeps the prompt expiry bounded when the wall clock rewinds", async () => {
    performanceNowSpy.mockRestore();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const questions = normalizeAskUserParams(validArgs).questions;
      const reservation = reserveAskUserPromptDelivery({
        toolCallId: "call-wall-clock-rewind",
        sessionKey: "agent:main:wall-clock-rewind",
        questions,
        timeoutSeconds: 30,
      });
      if (!reservation) {
        throw new Error("expected prompt reservation");
      }
      // The Gateway lookup stalls forever so isAskUserPromptPending only exits
      // via the expiry deadline armed by readAskUserQuestionStatusBeforeExpiry.
      const gateway = gatewayStub(async () => await new Promise(() => {}));

      // Rewind the wall clock by 30 minutes after the prompt is seeded but
      // before the expiry revalidation reads the remaining budget. A
      // wall-clock-based budget would recompute to ~30 minutes; the monotonic
      // budget must still expire at 30 seconds of real elapsed time.
      vi.setSystemTime(-30 * 60_000);

      const pending = isAskUserPromptPending(reservation.questionId, gateway.call);
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(pending).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds the recheck loop under a wall-clock rewind when the Gateway status is indeterminate", async () => {
    performanceNowSpy.mockRestore();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const questions = normalizeAskUserParams(validArgs).questions;
      const reservation = reserveAskUserPromptDelivery({
        toolCallId: "call-recheck-rewind",
        sessionKey: "agent:main:recheck-rewind",
        questions,
        timeoutSeconds: 5,
      });
      if (!reservation) {
        throw new Error("expected prompt reservation");
      }
      // Gateway returns a questions array whose status is missing — the
      // production reader extracts undefined, triggering the recheck loop.
      const gateway = gatewayStub(async () => ({ questions: [{ id: reservation.questionId }] }));

      vi.setSystemTime(-30 * 60_000);

      const pending = isAskUserPromptPending(reservation.questionId, gateway.call);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(pending).resolves.toBe(false);
      expect(gateway.mock).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
