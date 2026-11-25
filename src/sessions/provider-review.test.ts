import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveSessionWorkStartError as workStartError } from "../config/sessions/lifecycle.js";
import type { SessionProviderReview } from "../config/sessions/provider-review.types.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import * as runs from "../infra/agent-run-registry.js";
import {
  captureAgentRunProviderReview,
  readAgentRunProviderReview,
} from "./provider-review-terminal.js";
import {
  acceptProviderReviewAcknowledgment as acceptAcknowledgment,
  assertSessionProviderReviewWorkStart as assertWorkStart,
  canContinueSessionProviderReview,
  claimProviderReviewAttempt,
  createSessionProviderReview,
  issueProviderReviewAcknowledgment,
  readProviderReviewAcknowledgment as readAcknowledgment,
  recordSessionProviderReview,
  retireProviderReviewAcknowledgment,
  type ProviderReviewAcknowledgment as Ack,
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
const issue = (reviewTarget = target) =>
  issueProviderReviewAcknowledgment({
    target: reviewTarget,
    reviewId: refusal.id,
    nextRunId: accepted.runId,
    assertCurrent,
  });
const accept = (ack: Ack, overrides: Partial<typeof accepted> = {}) =>
  acceptAcknowledgment(ack, { ...accepted, ...overrides });
const start = (acknowledgment: Ack, overrides: Partial<typeof runtime> = {}) =>
  assertWorkStart({
    target,
    acknowledgment,
    runId: accepted.runId,
    ...runtime,
    assertCurrent,
    ...overrides,
  });
const admission = (ack: Ack, runId?: string) =>
  workStartError(target.sessionKey, entry, { providerReviewAcknowledgment: ack, runId });

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
afterEach(() => runs.resetAgentRunRegistryForTest());

it("enforces pause, settlement and unforgeable admission", async () => {
  const paused = entry;
  const ack = await issue();
  const settlement = {
    purpose: "accepted-result-settlement" as const,
    expectedSessionId: target.sessionId,
  };
  const forged = { providerReviewAcknowledgment: {} as Ack };
  const cases: Array<
    [InternalSessionEntry, Parameters<typeof workStartError>[2], string | undefined]
  > = [
    [paused, undefined, "paused as a precaution"],
    [paused, forged, "review changed"],
    [{ ...paused, providerReview: undefined }, undefined, undefined],
    [paused, settlement, undefined],
    [{ ...paused, sessionId: "replacement" }, settlement, "changed"],
    [{ ...paused, archivedAt: 2 }, settlement, "archived"],
    [paused, { providerReviewAcknowledgment: ack, runId: accepted.runId }, undefined],
  ];
  for (const [candidate, options, error] of cases) {
    const result = workStartError(target.sessionKey, candidate, options);
    expect(result).toEqual(error ? expect.stringContaining(error) : undefined);
  }
});

it("binds literal continuation to native acceptance and retires capabilities", async () => {
  const ack = await issue();
  const { read, assertRuntime, acceptNativeTurn } = ack;
  expect(admission(ack, accepted.runId)).toBeUndefined();
  expect(readAcknowledgment(ack).review.review?.continuation?.message).toBe("/literal steer");
  expect([Object.isFrozen(ack), Object.isFrozen(read())]).toEqual([true, true]);
  expect(read()).not.toHaveProperty("target");
  expect(read()).not.toHaveProperty("nextRunId");
  claimProviderReviewAttempt(ack, accepted.runId);
  store.read.mockClear();
  await assertRuntime(runtime);
  expect(store.read.mock.calls[0]?.[0]).toEqual(target);
  await expect(accept(ack, { nativeTurnId: refusal.nativeTurnId })).rejects.toThrow(
    "acceptance does not match",
  );
  expect(entry.providerReview).toEqual(refusal);
  await acceptNativeTurn(accepted);
  expect(store.compare.mock.calls[0]?.[0]).toEqual(target);
  expect(entry.providerReview).toBeUndefined();
  expect([read().phase, readAcknowledgment(ack).phase]).toEqual(["accepted", "accepted"]);
  expect(() => claimProviderReviewAttempt(ack, accepted.runId)).toThrow("single admitted attempt");
  await start(ack);
  retireProviderReviewAcknowledgment(ack);
  expect(() => read()).toThrow("no longer current");
  expect(() => readAcknowledgment(ack)).toThrow("no longer current");
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
      await accept(ack);
    }
    if (replacement === "review" || replacement === "accepted-review") {
      entry.providerReview = { ...refusal, id: "new-review" };
      if (replacement === "accepted-review") {
        entry.providerReview.runId = accepted.runId;
      }
    } else if (replacement === "generation") {
      entry = { ...entry, lifecycleRevision: "new-revision" };
    } else if (replacement === "source") {
      sourceCurrent = false;
    }
    const runIds: Partial<Record<string, string>> = {
      run: "unrelated-run",
      "accepted-review": accepted.runId,
    };
    expect(admission(ack, runIds[replacement])).toContain("review changed");
    if (replacement === "accepted-review") {
      expect(entry.providerReview?.id).toBe("new-review");
    }
  },
);

it.each(["issuance", "runtime"])("revalidates authority after %s loads a review", async (phase) => {
  const ack = phase === "runtime" ? await issue() : undefined;
  store.read.mockImplementation(async () => {
    sourceCurrent = false;
    return entry;
  });
  await expect(ack ? ack.assertRuntime(runtime) : issue()).rejects.toThrow("source revoked");
  expect(store.compare).not.toHaveBeenCalled();
});

it.each(["replacement", "cancellation"])("blocks acceptance after %s", async (failure) => {
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
    accept(ack, {
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
    expect(readAcknowledgment(ack).phase).toBe("pending");
  }
});

it("rejects changed runtimes, API-key and incognito continuation", async () => {
  const ack = await issue();
  await expect(start(ack, { model: "another-model" })).rejects.toThrow(
    "keep the reviewed runtime and model",
  );
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
    issue({ ...target, sessionKey: "agent:main:dashboard:incognito-review" }),
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
  expect(workStartError(target.sessionKey, entry)).toContain("paused as a precaution");
});
it.each(["run", "source", "capture"])("guards incognito facts against %s revocation", (revoked) => {
  const incognito = {
    ...target,
    sessionKey: "agent:main:dashboard:incognito-test",
    sessionId: "incognito-session",
    storePath: ":memory:",
  };
  runs.registerAgentRunContext("incognito-run", {
    sessionKey: incognito.sessionKey,
    sessionId: incognito.sessionId,
    lifecycleGeneration: runs.getAgentRunLifecycleGeneration(),
    lifecycleStartedAt: 1,
    assertSourceCurrent: assertCurrent,
  });
  const review = createSessionProviderReview({
    sessionId: incognito.sessionId,
    refusal: {
      ...refusal,
      runId: "incognito-run",
      api: undefined,
      nativeThreadId: undefined,
      nativeTurnId: undefined,
    },
  });
  const capture = () =>
    captureAgentRunProviderReview({
      runId: "incognito-run",
      target: incognito,
      review,
      expectedWriterRunId: "incognito-run",
      assertCurrent,
    });
  if (revoked === "capture") {
    sourceCurrent = false;
    expect(capture).toThrow("source revoked");
    sourceCurrent = true;
    expect(readAgentRunProviderReview("incognito-run")).toBeUndefined();
    return;
  }
  capture();
  const fact = readAgentRunProviderReview("incognito-run");
  expect(fact?.review).toEqual(review);
  const context = runs.getAgentRunContext("incognito-run")!;
  expect(JSON.stringify(context)).not.toContain(refusal.review!.explanation);
  expect(Object.keys(context)).not.toContain("providerReviewTerminal");
  if (revoked === "source") {
    sourceCurrent = false;
    expect(() => readAgentRunProviderReview("incognito-run")).toThrow("source revoked");
  } else {
    runs.clearAgentRunContext("incognito-run");
    runs.registerAgentRunContext("incognito-run", {
      sessionKey: incognito.sessionKey,
      sessionId: incognito.sessionId,
    });
    expect(readAgentRunProviderReview("incognito-run")).toBeUndefined();
    expect(() => fact?.assertCurrent()).toThrow("ownership changed");
  }
});
