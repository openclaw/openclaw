import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { defaultRuntime } from "../../runtime.js";
import {
  createFollowupTurnTestTurn,
  resetFollowupTurnTestState,
} from "./followup-turn-execution.test-support.js";
import type { resolveFollowupDeliveryDecision } from "./followup-delivery.js";
import { createQueueSettings, createQueueTestRun } from "./queue.test-helpers.js";
import { scheduleFollowupDrain } from "./queue/drain.js";
import { enqueueFollowupRun } from "./queue/enqueue.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./queue/state.js";
import type { prepareReplyAgentTurn } from "./reply-agent-turn-preparation.js";
import type { SessionEventExecution } from "./session-event-contract.js";
import { createMockTypingController } from "./test-helpers.js";

const runnerState = vi.hoisted(() => ({
  executeFollowupTurn: vi.fn(),
}));

// mock-isolation: The runner's authority-loss branch is exercised at its own
// boundary — executeFollowupTurn rejects and the catch handles the failure.
// The real turn executor normalizes accepted-input failures internally, so the
// boundary mock (same pattern as followup-runner.admission.test.ts) is what
// reaches the runner's catch.
vi.mock("./followup-turn-execution.js", () => ({
  executeFollowupTurn: (...args: unknown[]) => runnerState.executeFollowupTurn(...args),
}));

// mock-isolation: Keep database admission outside this diagnostic-preservation proof.
vi.mock("./reply-agent-turn-preparation.js", () => ({
  prepareReplyAgentTurn: async ({ queued }: Parameters<typeof prepareReplyAgentTurn>[0]) => ({
    kind: "admitted",
    turn: createFollowupTurnTestTurn({ runId: `execution-${queued.prompt}`, queued }),
  }),
}));

// mock-isolation: No result accounting is needed for a failed stub turn.
vi.mock("./agent-runner-result-accounting.js", () => ({
  accountFollowupTurn: async () => undefined,
}));

// mock-isolation: The turn fails before any delivery work; delivery owners stay stubbed.
vi.mock("./followup-delivery.js", () => ({
  resolveFollowupDeliveryDecision: async (): Promise<
    Awaited<ReturnType<typeof resolveFollowupDeliveryDecision>>
  > => ({ kind: "suppress", reason: "aborted" }),
  deliverFollowupDecision: async () => ({ kind: "completed", payloads: [] }),
}));

// mock-isolation: Synthetic operations; real lifecycle custody is covered by
// followup-runner.queue-custody.test.ts.
vi.mock("./reply-turn-admission-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./reply-turn-admission-lifecycle.js")>()),
  runWithReplyOperationLifecycleAdmission: async (
    _operation: unknown,
    run: () => Promise<unknown>,
  ) => await run(),
}));

const { createFollowupRunner } = await import("./followup-runner.js");
const key = "followup-authority-loss";

beforeEach(() => {
  vi.useFakeTimers();
  resetFollowupTurnTestState();
});

afterEach(() => {
  clearFollowupQueue(key);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.for(["original cause", "authority check cause"] as const)(
  "preserves the failing cause when operator authority is lost mid-execution (%s)",
  async (scenario, { signal }) => {
    const settled = createDeferred();
    const originalError = new Error("scheduled continuation failed before execution");
    const authorityError = new Error("operator authority was revoked");
    // Revocation happens mid-execution: admission and the pre-execution
    // authority checks must pass first, then the turn fails and the authority
    // is gone by the time the runner handles the failure.
    let authorityRevoked = false;
    runnerState.executeFollowupTurn.mockImplementation(async () => {
      authorityRevoked = true;
      throw originalError;
    });
    const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const internalEventExecution = {
      deliver: false as const,
      onFailed: vi.fn<NonNullable<SessionEventExecution["onFailed"]>>(),
      onStarted: vi.fn<SessionEventExecution["onStarted"]>(),
      onTerminal: vi.fn<SessionEventExecution["onTerminal"]>(),
    };
    const run = createQueueTestRun({ prompt: "continuation", messageId: "continuation" });
    run.run.sessionKey = key;
    run.run.internalEventExecution = internalEventExecution;
    run.operatorAuthority = {
      profileId: "test",
      scopes: [],
      assertCurrent: () => {
        if (authorityRevoked) {
          throw scenario === "authority check cause" ? authorityError : originalError;
        }
      },
    };
    run.turnAdoptionLifecycle = {
      admission: "cancel-only",
      onAdopted: () => {},
      onSettled: () => settled.resolve(),
    };
    const runner = createFollowupRunner({
      typing: createMockTypingController(),
      typingMode: "never",
      defaultModel: "gpt-test",
      opts: {},
    });
    expect(
      enqueueFollowupRun(key, run, createQueueSettings({ mode: "followup" }), "none", runner, false),
    ).toBe(true);
    scheduleFollowupDrain(key, runner);
    await withinTest(settled.promise, signal);
    await vi.runAllTimersAsync();

    expect(getExistingFollowupQueue(key)).toBeUndefined();
    // The original failure is what the session-event lifecycle reports; the
    // authority condition appears in the log alongside it.
    expect(internalEventExecution.onFailed).toHaveBeenCalledExactlyOnceWith(originalError);
    const authorityLog = errorSpy.mock.calls
      .map((call) => call.map((entry) => String(entry)).join(" "))
      .find((line) => line.includes("loss of operator authority"));
    expect(authorityLog).toBeDefined();
    expect(authorityLog).toContain(originalError.message);
    expect(authorityLog).toContain(
      scenario === "authority check cause" ? authorityError.message : originalError.message,
    );
  },
);
