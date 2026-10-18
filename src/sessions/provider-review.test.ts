import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSessionWorkStartError } from "../config/sessions/lifecycle.js";
import type { SessionProviderReview } from "../config/sessions/provider-review.types.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import {
  clearAgentRunContext,
  getAgentRunContext,
  getAgentRunLifecycleGeneration,
  registerAgentRunContext,
  resetAgentRunRegistryForTest,
} from "../infra/agent-run-registry.js";
import {
  captureAgentRunProviderReview,
  readAgentRunProviderReview,
} from "./provider-review-terminal.js";
import {
  acceptProviderReviewAcknowledgment,
  assertSessionProviderReviewWorkStart,
  canContinueSessionProviderReview,
  claimProviderReviewAttempt,
  createSessionProviderReview,
  issueProviderReviewAcknowledgment,
  readProviderReviewAcknowledgment,
  recordSessionProviderReview,
  retireProviderReviewAcknowledgment,
  type ProviderReviewAcknowledgment,
} from "./provider-review.js";

const store = vi.hoisted(() => ({ read: vi.fn(), compare: vi.fn() }));
vi.mock("../config/sessions/provider-review-store.js", () => ({
  readSessionProviderReview: store.read,
  compareSessionProviderReview: store.compare,
}));

const target = {
  agentId: "main",
  storePath: "/synthetic/sessions",
  sessionKey: "agent:main:review",
  sessionId: "session-a",
  lifecycleRevision: "revision-a",
};
const refusal: SessionProviderReview = {
  id: "review-a",
  sessionId: target.sessionId,
  runId: "failed-run",
  provider: "openai",
  model: "gpt-5.6-sol",
  runtimeId: "codex",
  api: "openai-chatgpt-responses",
  nativeThreadId: "native-thread",
  nativeTurnId: "native-failed-turn",
  review: {
    explanation: "The requested action needs review.",
    continuation: { message: "/literal steer" },
  },
};
const runtime = {
  provider: refusal.provider,
  model: refusal.model,
  runtimeId: refusal.runtimeId,
  api: refusal.api,
  assertCurrent: () => {},
};
const accepted = {
  runId: "next-run",
  nativeThreadId: "native-thread",
  nativeTurnId: "new-native-turn",
  assertCurrent: () => {},
};
let entry: InternalSessionEntry;
let sourceCurrent: boolean;
const assertCurrent = () => {
  if (!sourceCurrent) {
    throw new Error("source revoked");
  }
};
const issue = () =>
  issueProviderReviewAcknowledgment({
    target,
    reviewId: refusal.id,
    nextRunId: accepted.runId,
    assertCurrent,
  });

beforeEach(() => {
  sourceCurrent = true;
  entry = {
    sessionId: target.sessionId,
    lifecycleRevision: target.lifecycleRevision,
    updatedAt: 1,
    providerReview: structuredClone(refusal),
  };
  store.read.mockReset().mockImplementation(async () => structuredClone(entry));
  store.compare.mockReset().mockImplementation(async (_target, params) => {
    params.assertCurrent();
    if (JSON.stringify(entry.providerReview) !== JSON.stringify(params.expectedReview)) {
      throw new Error("review changed");
    }
    entry = { ...entry, providerReview: params.nextReview };
    return structuredClone(entry);
  });
});
afterEach(() => resetAgentRunRegistryForTest());

describe("provider review admission", () => {
  it("enforces pause, settlement and recovery admission without accepting forged capabilities", async () => {
    const paused = entry;
    entry = {
      ...entry,
      mainRestartRecovery: {
        cycleId: "recovery-cycle",
        revision: 1,
        chargedAttempts: 1,
        tombstone: { reason: "automatic recovery exhausted" },
      },
    };
    const ack = await issue();
    const settlement = {
      purpose: "accepted-result-settlement" as const,
      expectedSessionId: target.sessionId,
    };
    const recovery = { allowRestartTombstoneReplacement: true };
    const cases: Array<
      [InternalSessionEntry, Parameters<typeof resolveSessionWorkStartError>[2], string | undefined]
    > = [
      [paused, undefined, "paused as a precaution"],
      [
        paused,
        { providerReviewAcknowledgment: {} as ProviderReviewAcknowledgment },
        "review changed",
      ],
      [{ ...paused, providerReview: undefined }, undefined, undefined],
      [paused, settlement, undefined],
      [{ ...paused, sessionId: "replacement" }, settlement, "changed"],
      [{ ...paused, archivedAt: 2 }, settlement, "archived"],
      [entry, recovery, "paused as a precaution"],
      [
        entry,
        { ...recovery, providerReviewAcknowledgment: ack, runId: accepted.runId },
        "ended during restart recovery",
      ],
      [{ ...entry, providerReview: undefined }, recovery, undefined],
    ];
    for (const [candidate, options, error] of cases) {
      const result = resolveSessionWorkStartError(target.sessionKey, candidate, options);
      if (error) {
        expect(result).toContain(error);
      } else {
        expect(result).toBeUndefined();
      }
    }
  });

  it("binds one literal continuation to native acceptance and retires all retained capabilities", async () => {
    const ack = await issue();
    const { read, assertRuntime, acceptNativeTurn } = ack;
    expect(
      resolveSessionWorkStartError(target.sessionKey, entry, {
        providerReviewAcknowledgment: ack,
        runId: accepted.runId,
      }),
    ).toBeUndefined();
    expect(readProviderReviewAcknowledgment(ack).review.review?.continuation?.message).toBe(
      "/literal steer",
    );
    expect(Object.isFrozen(ack)).toBe(true);
    expect(Object.isFrozen(read())).toBe(true);
    expect(read()).not.toHaveProperty("target");
    expect(read()).not.toHaveProperty("nextRunId");
    claimProviderReviewAttempt(ack, accepted.runId);
    store.read.mockClear();
    await assertRuntime(runtime);
    expect(store.read.mock.calls[0]?.[0]).toEqual(target);
    await expect(
      acceptProviderReviewAcknowledgment(ack, {
        ...accepted,
        nativeTurnId: refusal.nativeTurnId,
      }),
    ).rejects.toThrow("acceptance does not match");
    expect(entry.providerReview).toEqual(refusal);
    await acceptNativeTurn(accepted);
    expect(store.compare.mock.calls[0]?.[0]).toEqual(target);
    expect(entry.providerReview).toBeUndefined();
    expect(read().phase).toBe("accepted");
    expect(readProviderReviewAcknowledgment(ack).phase).toBe("accepted");
    expect(() => claimProviderReviewAttempt(ack, accepted.runId)).toThrow(
      "single admitted attempt",
    );
    await assertSessionProviderReviewWorkStart({
      target,
      acknowledgment: ack,
      runId: accepted.runId,
      ...runtime,
      assertCurrent,
    });
    retireProviderReviewAcknowledgment(ack);
    expect(() => read()).toThrow("no longer current");
    expect(() => readProviderReviewAcknowledgment(ack)).toThrow("no longer current");
    await expect(assertRuntime(runtime)).rejects.toThrow("no longer current");
    await expect(acceptNativeTurn({ ...accepted, nativeTurnId: "another-turn" })).rejects.toThrow(
      "no longer current",
    );
  });

  it.each(["review", "generation", "source", "run", "accepted-review"])(
    "rejects an acknowledgement after %s replacement",
    async (replacement) => {
      const ack = await issue();
      if (replacement === "accepted-review") {
        await acceptProviderReviewAcknowledgment(ack, accepted);
        entry.providerReview = { ...refusal, id: "new-review", runId: accepted.runId };
      } else if (replacement === "review") {
        entry.providerReview = { ...refusal, id: "new-review" };
      } else if (replacement === "generation") {
        entry = { ...entry, lifecycleRevision: "new-revision" };
      } else if (replacement === "source") {
        sourceCurrent = false;
      }
      expect(
        resolveSessionWorkStartError(target.sessionKey, entry, {
          providerReviewAcknowledgment: ack,
          ...(replacement === "run"
            ? { runId: "unrelated-run" }
            : replacement === "accepted-review"
              ? { runId: accepted.runId }
              : {}),
        }),
      ).toContain("review changed");
      if (replacement === "accepted-review") {
        expect(entry.providerReview?.id).toBe("new-review");
      }
    },
  );

  it.each(["issuance", "runtime"])(
    "revalidates source authority after %s loads a review",
    async (phase) => {
      const ack = phase === "runtime" ? await issue() : undefined;
      store.read.mockImplementation(async () => {
        sourceCurrent = false;
        return entry;
      });
      await expect(ack ? ack.assertRuntime(runtime) : issue()).rejects.toThrow("source revoked");
      expect(store.compare).not.toHaveBeenCalled();
    },
  );

  it.each(["replacement", "cancellation"])(
    "retains the block after acceptance loses %s authority",
    async (failure) => {
      const ack = await issue();
      let accepting = true;
      if (failure === "replacement") {
        entry.providerReview = { ...refusal, id: "replacement" };
      } else {
        store.compare.mockImplementation(async (_target, params) => {
          accepting = false;
          params.assertCurrent();
          throw new Error("unreachable commit");
        });
      }
      await expect(
        acceptProviderReviewAcknowledgment(ack, {
          ...accepted,
          assertCurrent: () => {
            if (!accepting) {
              throw new Error("request cancelled");
            }
          },
        }),
      ).rejects.toThrow(failure === "replacement" ? "review changed" : "request cancelled");
      if (failure === "replacement") {
        expect(entry.providerReview?.id).toBe("replacement");
      } else {
        expect(entry.providerReview).toEqual(refusal);
        expect(readProviderReviewAcknowledgment(ack).phase).toBe("pending");
      }
    },
  );

  it("rejects runtime changes before dispatch and never offers ordinary API-key continuation", async () => {
    const ack = await issue();
    await expect(
      assertSessionProviderReviewWorkStart({
        target,
        acknowledgment: ack,
        runId: accepted.runId,
        ...runtime,
        model: "another-model",
        assertCurrent,
      }),
    ).rejects.toThrow("keep the reviewed runtime and model");
    for (const [review, sessionKey, allowed] of [
      [{ ...refusal, runtimeId: "openclaw", api: "openai-responses" }, target.sessionKey, false],
      [{ ...refusal, runtimeId: "openclaw" }, target.sessionKey, true],
      [{ ...refusal, api: undefined, nativeTurnId: undefined }, target.sessionKey, false],
      [refusal, "agent:main:dashboard:incognito-review", false],
    ] as const) {
      expect(canContinueSessionProviderReview(review, sessionKey)).toBe(allowed);
    }
    store.read.mockClear();
    await expect(
      issueProviderReviewAcknowledgment({
        target: { ...target, sessionKey: "agent:main:dashboard:incognito-review" },
        reviewId: refusal.id,
        nextRunId: accepted.runId,
        assertCurrent,
      }),
    ).rejects.toThrow("cannot be continued in an incognito session");
    expect(store.read).not.toHaveBeenCalled();
  });

  it("persists new refusal identity and keeps duplicate terminal notification identity", async () => {
    entry.providerReview = undefined;
    const { id: _id, sessionId: _sessionId, ...runtimeRefusal } = refusal;
    const record = (value = runtimeRefusal) =>
      recordSessionProviderReview({ target, refusal: value, assertCurrent });
    const first = await record();
    const second = await record();
    const duplicateWithoutDetails = await record({ ...runtimeRefusal, review: undefined });
    expect(first.id).toBe(second.id);
    expect(duplicateWithoutDetails).toEqual(first);
    expect(store.compare).toHaveBeenCalledOnce();
    expect(resolveSessionWorkStartError(target.sessionKey, entry)).toContain(
      "paused as a precaution",
    );
  });
});

it.each(["run", "source"])("keeps incognito findings private until %s revocation", (revoked) => {
  const incognito = {
    agentId: "main",
    sessionKey: "agent:main:dashboard:incognito-test",
    sessionId: "incognito-session",
    storePath: ":memory:",
    lifecycleRevision: "revision",
  };
  registerAgentRunContext("incognito-run", {
    sessionKey: incognito.sessionKey,
    sessionId: incognito.sessionId,
    lifecycleGeneration: getAgentRunLifecycleGeneration(),
    lifecycleStartedAt: 1,
    assertSourceCurrent: assertCurrent,
  });
  const review = createSessionProviderReview({
    sessionId: incognito.sessionId,
    refusal: {
      runId: "incognito-run",
      provider: "openai",
      model: "gpt-5.6-sol",
      runtimeId: "codex",
      review: {
        explanation: "Review the pending operation.",
        continuation: { message: "/literal continuation" },
      },
    },
  });
  captureAgentRunProviderReview({
    runId: "incognito-run",
    target: incognito,
    review,
    expectedWriterRunId: "incognito-run",
    assertCurrent,
  });
  const fact = readAgentRunProviderReview("incognito-run");
  expect(fact?.review).toEqual(review);
  expect(JSON.stringify(getAgentRunContext("incognito-run"))).not.toContain("pending operation");
  expect(Object.keys(getAgentRunContext("incognito-run")!)).not.toContain("providerReviewTerminal");
  if (revoked === "source") {
    sourceCurrent = false;
    expect(() => readAgentRunProviderReview("incognito-run")).toThrow("source revoked");
  } else {
    clearAgentRunContext("incognito-run");
    registerAgentRunContext("incognito-run", {
      sessionKey: incognito.sessionKey,
      sessionId: incognito.sessionId,
    });
    expect(readAgentRunProviderReview("incognito-run")).toBeUndefined();
    expect(() => fact?.assertCurrent()).toThrow("ownership changed");
  }
});
