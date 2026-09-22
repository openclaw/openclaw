import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSessionWorkStartError } from "../config/sessions/lifecycle.js";
import type { SessionProviderReview } from "../config/sessions/provider-review.types.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import {
  acceptProviderReviewAcknowledgment,
  assertSessionProviderReviewWorkStart,
  canContinueSessionProviderReview,
  claimProviderReviewAttempt,
  issueProviderReviewAcknowledgment,
  readProviderReviewAcknowledgment,
  recordSessionProviderReview,
  retireProviderReviewAcknowledgment,
  type ProviderReviewAcknowledgment,
} from "./provider-review.js";

const store = vi.hoisted(() => ({
  read: vi.fn(),
  compare: vi.fn(),
}));
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
    nextRunId: "next-run",
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

describe("provider review admission", () => {
  it("blocks ordinary work across turns and rejects client-forged acknowledgments", () => {
    expect(resolveSessionWorkStartError(target.sessionKey, entry)).toContain(
      "paused as a precaution",
    );
    expect(
      resolveSessionWorkStartError(target.sessionKey, entry, {
        providerReviewAcknowledgment: {} as ProviderReviewAcknowledgment,
      }),
    ).toContain("review changed");
    expect(
      resolveSessionWorkStartError(target.sessionKey, { ...entry, providerReview: undefined }),
    ).toBeUndefined();
  });

  it("allows accepted output to settle while keeping generation and archive guards", () => {
    const options = {
      purpose: "accepted-result-settlement" as const,
      expectedSessionId: target.sessionId,
    };
    expect(resolveSessionWorkStartError(target.sessionKey, entry, options)).toBeUndefined();
    expect(
      resolveSessionWorkStartError(
        target.sessionKey,
        { ...entry, sessionId: "replacement" },
        options,
      ),
    ).toContain("changed");
    expect(
      resolveSessionWorkStartError(target.sessionKey, { ...entry, archivedAt: 2 }, options),
    ).toContain("archived");
  });

  it("does not let restart recovery replace a paused conversation, even with acknowledgment", async () => {
    entry.mainRestartRecovery = {
      cycleId: "recovery-cycle",
      revision: 1,
      chargedAttempts: 1,
      tombstone: { reason: "automatic recovery exhausted" },
    };
    const options = { allowRestartTombstoneReplacement: true };
    expect(resolveSessionWorkStartError(target.sessionKey, entry, options)).toContain(
      "paused as a precaution",
    );
    const acknowledgment = await issue();
    expect(
      resolveSessionWorkStartError(target.sessionKey, entry, {
        ...options,
        providerReviewAcknowledgment: acknowledgment,
        runId: "next-run",
      }),
    ).toContain("ended during restart recovery");
    expect(
      resolveSessionWorkStartError(
        target.sessionKey,
        { ...entry, providerReview: undefined },
        options,
      ),
    ).toBeUndefined();
  });

  it("admits only the current host capability and retains the literal continuation", async () => {
    const ack = await issue();
    expect(
      resolveSessionWorkStartError(target.sessionKey, entry, {
        providerReviewAcknowledgment: ack,
        runId: "next-run",
      }),
    ).toBeUndefined();
    expect(readProviderReviewAcknowledgment(ack).review.review?.continuation?.message).toBe(
      "/literal steer",
    );
    expect(
      resolveSessionWorkStartError(target.sessionKey, entry, {
        providerReviewAcknowledgment: ack,
        runId: "unrelated-run",
      }),
    ).toContain("review changed");
  });

  it("binds plugin operations to the issued identity and retires retained methods", async () => {
    const acknowledgment = await issue();
    const { read, assertRuntime, acceptNativeTurn } = acknowledgment;
    expect(Object.isFrozen(acknowledgment)).toBe(true);
    expect(Object.isFrozen(read())).toBe(true);
    expect(read()).not.toHaveProperty("target");
    expect(read()).not.toHaveProperty("nextRunId");
    store.read.mockClear();
    const runtime = {
      provider: refusal.provider,
      model: refusal.model,
      runtimeId: refusal.runtimeId,
      api: refusal.api,
      assertCurrent: () => {},
    };
    await assertRuntime(runtime);
    expect(store.read.mock.calls[0]?.[0]).toEqual(target);
    await acceptNativeTurn({
      nativeThreadId: "native-thread",
      nativeTurnId: "new-native-turn",
      assertCurrent: () => {},
    });
    expect(store.compare.mock.calls[0]?.[0]).toEqual(target);
    expect(read().phase).toBe("accepted");
    retireProviderReviewAcknowledgment(acknowledgment);
    expect(() => read()).toThrow("no longer current");
    await expect(assertRuntime(runtime)).rejects.toThrow("no longer current");
    await expect(
      acceptNativeTurn({
        nativeThreadId: "native-thread",
        nativeTurnId: "another-turn",
        assertCurrent: () => {},
      }),
    ).rejects.toThrow("no longer current");
  });

  it("keeps source revocation effective when a plugin runtime assertion remains live", async () => {
    const acknowledgment = await issue();
    store.read.mockImplementation(async () => {
      sourceCurrent = false;
      return entry;
    });
    await expect(
      acknowledgment.assertRuntime({
        provider: refusal.provider,
        model: refusal.model,
        runtimeId: refusal.runtimeId,
        api: refusal.api,
        assertCurrent: () => {},
      }),
    ).rejects.toThrow("source revoked");
    expect(store.compare).not.toHaveBeenCalled();
  });

  it("does not let a new attempt inherit the accepted continuation", async () => {
    const acknowledgment = await issue();
    claimProviderReviewAttempt(acknowledgment, "next-run");
    await acceptProviderReviewAcknowledgment(acknowledgment, {
      runId: "next-run",
      nativeThreadId: refusal.nativeThreadId,
      nativeTurnId: "new-native-turn",
    });
    expect(readProviderReviewAcknowledgment(acknowledgment).phase).toBe("accepted");
    expect(() => claimProviderReviewAttempt(acknowledgment, "next-run")).toThrow(
      "single admitted attempt",
    );
  });

  it.each(["review", "generation", "source"])(
    "rejects an acknowledgement after %s replacement",
    async (replacement) => {
      const ack = await issue();
      if (replacement === "review") {
        entry.providerReview = { ...refusal, id: "new-review" };
      } else if (replacement === "generation") {
        entry = { ...entry, lifecycleRevision: "new-revision" };
      } else {
        sourceCurrent = false;
      }
      expect(
        resolveSessionWorkStartError(target.sessionKey, entry, {
          providerReviewAcknowledgment: ack,
        }),
      ).toContain("review changed");
    },
  );

  it("revalidates source authority after loading a review", async () => {
    store.read.mockImplementation(async () => {
      sourceCurrent = false;
      return entry;
    });
    await expect(issue()).rejects.toThrow("source revoked");
    expect(store.compare).not.toHaveBeenCalled();
  });

  it("clears only after native acceptance and retains only the accepted run authority", async () => {
    const ack = await issue();
    await expect(
      acceptProviderReviewAcknowledgment(ack, {
        runId: "next-run",
        nativeThreadId: refusal.nativeThreadId,
        nativeTurnId: refusal.nativeTurnId,
      }),
    ).rejects.toThrow("acceptance does not match");
    expect(entry.providerReview).toEqual(refusal);
    await acceptProviderReviewAcknowledgment(ack, {
      runId: "next-run",
      nativeThreadId: refusal.nativeThreadId,
      nativeTurnId: "new-native-turn",
    });
    expect(entry.providerReview).toBeUndefined();
    expect(readProviderReviewAcknowledgment(ack).phase).toBe("accepted");
    await assertSessionProviderReviewWorkStart({
      target,
      acknowledgment: ack,
      runId: "next-run",
      provider: refusal.provider,
      model: refusal.model,
      runtimeId: refusal.runtimeId,
      api: refusal.api,
      assertCurrent,
    });
    retireProviderReviewAcknowledgment(ack);
    expect(() => readProviderReviewAcknowledgment(ack)).toThrow("no longer current");
  });

  it("retains a replacement block when acceptance loses its compare-and-set", async () => {
    const ack = await issue();
    entry.providerReview = { ...refusal, id: "replacement" };
    await expect(
      acceptProviderReviewAcknowledgment(ack, {
        runId: "next-run",
        nativeThreadId: refusal.nativeThreadId,
        nativeTurnId: "new-native-turn",
      }),
    ).rejects.toThrow("review changed");
    expect(entry.providerReview.id).toBe("replacement");
  });

  it("retains the block when the accepting request is cancelled before commit", async () => {
    const ack = await issue();
    let accepting = true;
    store.compare.mockImplementation(async (_target, params) => {
      accepting = false;
      params.assertCurrent();
      throw new Error("unreachable commit");
    });
    await expect(
      acceptProviderReviewAcknowledgment(ack, {
        runId: "next-run",
        nativeThreadId: refusal.nativeThreadId,
        nativeTurnId: "new-native-turn",
        assertCurrent: () => {
          if (!accepting) {
            throw new Error("request cancelled");
          }
        },
      }),
    ).rejects.toThrow("request cancelled");
    expect(entry.providerReview).toEqual(refusal);
    expect(readProviderReviewAcknowledgment(ack).phase).toBe("pending");
  });

  it("does not let an accepted continuation authorize a newer refusal", async () => {
    const ack = await issue();
    await acceptProviderReviewAcknowledgment(ack, {
      runId: "next-run",
      nativeThreadId: refusal.nativeThreadId,
      nativeTurnId: "new-native-turn",
    });
    entry.providerReview = { ...refusal, id: "new-review", runId: "next-run" };
    expect(
      resolveSessionWorkStartError(target.sessionKey, entry, {
        providerReviewAcknowledgment: ack,
        runId: "next-run",
      }),
    ).toContain("review changed");
    expect(entry.providerReview.id).toBe("new-review");
  });

  it("rejects runtime changes before dispatch and never offers ordinary API-key continuation", async () => {
    const ack = await issue();
    await expect(
      assertSessionProviderReviewWorkStart({
        target,
        acknowledgment: ack,
        runId: "next-run",
        provider: refusal.provider,
        model: "another-model",
        runtimeId: refusal.runtimeId,
        api: refusal.api,
        assertCurrent,
      }),
    ).rejects.toThrow("keep the reviewed runtime and model");
    expect(
      canContinueSessionProviderReview(
        {
          ...refusal,
          runtimeId: "openclaw",
          api: "openai-responses",
        },
        target.sessionKey,
      ),
    ).toBe(false);
    expect(
      canContinueSessionProviderReview({ ...refusal, runtimeId: "openclaw" }, target.sessionKey),
    ).toBe(true);
    expect(
      canContinueSessionProviderReview(
        { ...refusal, api: undefined, nativeTurnId: undefined },
        target.sessionKey,
      ),
    ).toBe(false);
    expect(canContinueSessionProviderReview(refusal, "agent:main:dashboard:incognito-review")).toBe(
      false,
    );
    store.read.mockClear();
    await expect(
      issueProviderReviewAcknowledgment({
        target: { ...target, sessionKey: "agent:main:dashboard:incognito-review" },
        reviewId: refusal.id,
        nextRunId: "next-run",
        assertCurrent,
      }),
    ).rejects.toThrow("cannot be continued in an incognito session");
    expect(store.read).not.toHaveBeenCalled();
  });

  it("persists new refusal identity and keeps duplicate terminal notification identity", async () => {
    entry.providerReview = undefined;
    const { id: _id, sessionId: _sessionId, ...runtimeRefusal } = refusal;
    const first = await recordSessionProviderReview({
      target,
      refusal: runtimeRefusal,
      assertCurrent,
    });
    const second = await recordSessionProviderReview({
      target,
      refusal: runtimeRefusal,
      assertCurrent,
    });
    const duplicateWithoutDetails = await recordSessionProviderReview({
      target,
      refusal: { ...runtimeRefusal, review: undefined },
      assertCurrent,
    });
    expect(first.id).toBe(second.id);
    expect(duplicateWithoutDetails).toEqual(first);
    expect(store.compare).toHaveBeenCalledOnce();
    expect(resolveSessionWorkStartError(target.sessionKey, entry)).toContain(
      "paused as a precaution",
    );
  });
});
