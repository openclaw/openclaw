import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readProviderRefusalReview } from "@openclaw/llm-core/diagnostics";
import type { SessionProviderReview } from "../config/sessions/provider-review.types.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { isIncognitoSessionKey } from "../shared/incognito-session-key.js";

export type ProviderReviewTarget = {
  agentId: string;
  storePath: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision?: string;
};

declare const acknowledgmentBrand: unique symbol;
/** Host-issued capability; serialized request metadata cannot create one. */
export interface ProviderReviewAcknowledgment {
  readonly [acknowledgmentBrand]: true;
  readonly read: () => Readonly<{
    review: Readonly<SessionProviderReview>;
    phase: "pending" | "accepted";
  }>;
  readonly assertRuntime: (runtime: {
    provider: string;
    model: string;
    runtimeId: string;
    api?: string;
    assertCurrent: () => void;
  }) => Promise<void>;
  readonly acceptNativeTurn: (accepted: {
    nativeThreadId: string;
    nativeTurnId: string;
    assertCurrent: () => void;
  }) => Promise<void>;
}

type AcknowledgmentState = {
  target: Readonly<ProviderReviewTarget>;
  review: Readonly<SessionProviderReview>;
  nextRunId: string;
  assertCurrent: () => void;
  phase: "pending" | "accepted" | "retired";
  acceptedNativeTurnId?: string;
  attemptClaimed?: true;
};

const acknowledgments = resolveGlobalSingleton(
  Symbol.for("openclaw.providerReviewAcknowledgments"),
  () => new WeakMap<object, AcknowledgmentState>(),
);

export function createSessionProviderReview(params: {
  sessionId: string;
  refusal: Omit<SessionProviderReview, "id" | "sessionId">;
}): SessionProviderReview {
  const details = readProviderRefusalReview(params.refusal.review);
  return {
    id: randomUUID(),
    sessionId: params.sessionId,
    runId: params.refusal.runId,
    provider: params.refusal.provider,
    model: params.refusal.model,
    runtimeId: params.refusal.runtimeId,
    ...(params.refusal.api ? { api: params.refusal.api } : {}),
    ...(details ? { review: details } : {}),
    ...(params.refusal.nativeThreadId ? { nativeThreadId: params.refusal.nativeThreadId } : {}),
    ...(params.refusal.nativeTurnId ? { nativeTurnId: params.refusal.nativeTurnId } : {}),
  };
}

/** The admitted runtime records its refusal before releasing the logical turn. */
export async function recordSessionProviderReview(params: {
  target: ProviderReviewTarget;
  refusal: Omit<SessionProviderReview, "id" | "sessionId">;
  assertCurrent: () => void;
}): Promise<SessionProviderReview> {
  params.assertCurrent();
  const { readSessionProviderReview, compareSessionProviderReview } =
    await import("../config/sessions/provider-review-store.js");
  params.assertCurrent();
  const entry = await readSessionProviderReview(params.target, params.assertCurrent);
  params.assertCurrent();
  const previous = entry?.providerReview;
  const review = createSessionProviderReview({
    sessionId: params.target.sessionId,
    refusal: params.refusal,
  });
  if (
    previous &&
    !review.review &&
    isDeepStrictEqual(
      { ...previous, id: undefined, review: undefined },
      { ...review, id: undefined, review: undefined },
    )
  ) {
    return previous;
  }
  // Repeated terminal notifications retain the same displayed review identity.
  if (previous && isDeepStrictEqual({ ...previous, id: undefined }, { ...review, id: undefined })) {
    return previous;
  }
  const updated = await compareSessionProviderReview(params.target, {
    expectedReview: previous,
    nextReview: review,
    assertCurrent: params.assertCurrent,
  });
  params.assertCurrent();
  if (!updated.providerReview) {
    throw new Error("Provider precaution was not recorded");
  }
  return updated.providerReview;
}

export function canContinueSessionProviderReview(
  review: SessionProviderReview,
  sessionKey: string,
): boolean {
  if (
    isIncognitoSessionKey(sessionKey) ||
    !readProviderRefusalReview(review.review)?.continuation
  ) {
    return false;
  }
  return (
    review.provider === "openai" &&
    (review.runtimeId === "codex"
      ? Boolean(review.nativeThreadId && review.nativeTurnId)
      : review.runtimeId === "openclaw" && review.api === "openai-chatgpt-responses")
  );
}

function readState(acknowledgment: ProviderReviewAcknowledgment): AcknowledgmentState {
  const state = acknowledgments.get(acknowledgment);
  if (!state || state.phase === "retired") {
    throw new Error("Provider review acknowledgment is no longer current");
  }
  try {
    state.assertCurrent();
  } catch (error) {
    state.phase = "retired";
    throw error;
  }
  return state;
}

export async function issueProviderReviewAcknowledgment(params: {
  target: ProviderReviewTarget;
  reviewId: string;
  nextRunId: string;
  assertCurrent: () => void;
}): Promise<ProviderReviewAcknowledgment> {
  params.assertCurrent();
  if (isIncognitoSessionKey(params.target.sessionKey)) {
    throw new Error("Provider review cannot be continued in an incognito session");
  }
  const { readSessionProviderReview } = await import("../config/sessions/provider-review-store.js");
  params.assertCurrent();
  const target = Object.freeze({ ...params.target });
  const entry = await readSessionProviderReview(target, params.assertCurrent);
  params.assertCurrent();
  const review = entry?.providerReview;
  if (
    entry?.sessionId !== target.sessionId ||
    entry.lifecycleRevision !== target.lifecycleRevision ||
    !review ||
    review.id !== params.reviewId ||
    review.sessionId !== target.sessionId ||
    review.runId === params.nextRunId ||
    !canContinueSessionProviderReview(review, target.sessionKey)
  ) {
    throw new Error("Provider review changed or cannot be continued; refresh the findings");
  }
  const snapshot = structuredClone(review);
  if (snapshot.review?.continuation) {
    Object.freeze(snapshot.review.continuation);
  }
  if (snapshot.review) {
    Object.freeze(snapshot.review);
  }
  Object.freeze(snapshot);
  const acknowledgment: ProviderReviewAcknowledgment = Object.freeze({
    read: () => {
      const { review: currentReview, phase } = readProviderReviewAcknowledgment(acknowledgment);
      return Object.freeze({ review: currentReview, phase });
    },
    assertRuntime: async (
      runtime: Parameters<ProviderReviewAcknowledgment["assertRuntime"]>[0],
    ) => {
      const current = readProviderReviewAcknowledgment(acknowledgment);
      const assertRuntimeCurrent = runtime.assertCurrent;
      await assertSessionProviderReviewWorkStart({
        target: current.target,
        acknowledgment,
        runId: current.nextRunId,
        provider: runtime.provider,
        model: runtime.model,
        runtimeId: runtime.runtimeId,
        api: runtime.api,
        assertCurrent: () => {
          assertRuntimeCurrent();
          readState(acknowledgment);
        },
      });
    },
    acceptNativeTurn: async (
      accepted: Parameters<ProviderReviewAcknowledgment["acceptNativeTurn"]>[0],
    ) => {
      const current = readProviderReviewAcknowledgment(acknowledgment);
      if (current.review.runtimeId !== "codex") {
        throw new Error("Provider review does not belong to a native Codex turn");
      }
      await acceptProviderReviewAcknowledgment(acknowledgment, {
        runId: current.nextRunId,
        nativeThreadId: accepted.nativeThreadId,
        nativeTurnId: accepted.nativeTurnId,
        assertCurrent: accepted.assertCurrent,
      });
    },
  }) as ProviderReviewAcknowledgment; // SAFETY: WeakMap consumers enforce issued identity.
  acknowledgments.set(acknowledgment, {
    target,
    review: snapshot,
    nextRunId: params.nextRunId,
    assertCurrent: params.assertCurrent,
    phase: "pending",
  });
  return acknowledgment;
}

export function readProviderReviewAcknowledgment(acknowledgment: ProviderReviewAcknowledgment) {
  const state = readState(acknowledgment);
  return {
    target: state.target,
    review: state.review,
    nextRunId: state.nextRunId,
    phase: state.phase === "pending" ? ("pending" as const) : ("accepted" as const),
  };
}

export function retireProviderReviewAcknowledgment(
  acknowledgment: ProviderReviewAcknowledgment,
): void {
  const state = acknowledgments.get(acknowledgment);
  if (state) {
    state.phase = "retired";
  }
}

/** Retries and fallback runtimes cannot turn one acknowledgment into another physical attempt. */
export function claimProviderReviewAttempt(
  acknowledgment: ProviderReviewAcknowledgment,
  runId: string,
): void {
  const state = readState(acknowledgment);
  if (state.nextRunId !== runId || state.attemptClaimed) {
    throw new Error("Provider acknowledgment already belongs to its single admitted attempt");
  }
  state.attemptClaimed = true;
}

export async function assertSessionProviderReviewWorkStart(params: {
  target: ProviderReviewTarget;
  acknowledgment?: ProviderReviewAcknowledgment;
  runId: string;
  provider: string;
  model: string;
  runtimeId: string;
  api?: string;
  assertCurrent: () => void;
}): Promise<void> {
  params.assertCurrent();
  const { readSessionProviderReview } = await import("../config/sessions/provider-review-store.js");
  params.assertCurrent();
  const entry = await readSessionProviderReview(params.target, params.assertCurrent);
  params.assertCurrent();
  if (params.acknowledgment) {
    if (!entry) {
      throw new Error("Provider review session changed before continuation");
    }
    assertProviderReviewAcknowledgment(params.acknowledgment, {
      sessionKey: params.target.sessionKey,
      entry,
      runId: params.runId,
    });
    const { review } = readProviderReviewAcknowledgment(params.acknowledgment);
    if (
      review.provider !== params.provider ||
      review.model !== params.model ||
      review.runtimeId !== params.runtimeId ||
      review.api !== params.api
    ) {
      throw new Error("Provider continuation must keep the reviewed runtime and model");
    }
  } else if (entry?.providerReview) {
    throw new Error(
      "This session is paused as a precaution. Review the provider findings in chat before continuing.",
    );
  }
}

/** Entry is freshly read by the admission owner; retained capabilities never override replacement. */
export function assertProviderReviewAcknowledgment(
  acknowledgment: ProviderReviewAcknowledgment,
  current: {
    sessionKey: string;
    entry: Pick<SessionEntry, "sessionId" | "lifecycleRevision" | "providerReview">;
    runId?: string;
  },
): void {
  const state = readState(acknowledgment);
  if (
    current.sessionKey !== state.target.sessionKey ||
    current.entry.sessionId !== state.target.sessionId ||
    current.entry.lifecycleRevision !== state.target.lifecycleRevision ||
    (current.runId !== undefined && current.runId !== state.nextRunId) ||
    (state.phase === "pending"
      ? !isDeepStrictEqual(current.entry.providerReview, state.review)
      : current.entry.providerReview !== undefined)
  ) {
    state.phase = "retired";
    throw new Error("Provider review changed; refresh the findings before continuing");
  }
}

/** Called by the transport owner only after the provider accepts a distinct new turn. */
export async function acceptProviderReviewAcknowledgment(
  acknowledgment: ProviderReviewAcknowledgment,
  accepted: {
    runId: string;
    nativeThreadId?: string;
    nativeTurnId?: string;
    assertCurrent?: () => void;
  },
): Promise<void> {
  const assertOperationCurrent = accepted.assertCurrent;
  const assertAcceptanceCurrent = () => {
    assertOperationCurrent?.();
    readState(acknowledgment);
  };
  assertAcceptanceCurrent();
  const state = readState(acknowledgment);
  if (
    accepted.runId !== state.nextRunId ||
    (state.review.runtimeId === "codex" &&
      (accepted.nativeThreadId !== state.review.nativeThreadId ||
        !accepted.nativeTurnId ||
        accepted.nativeTurnId === state.review.nativeTurnId))
  ) {
    throw new Error("Provider continuation acceptance does not match its acknowledged review");
  }
  if (state.phase === "accepted") {
    if (state.acceptedNativeTurnId !== accepted.nativeTurnId) {
      throw new Error("Provider continuation was already accepted by another turn");
    }
    return;
  }
  const { compareSessionProviderReview } =
    await import("../config/sessions/provider-review-store.js");
  assertAcceptanceCurrent();
  await compareSessionProviderReview(state.target, {
    expectedReview: state.review,
    nextReview: undefined,
    assertCurrent: assertAcceptanceCurrent,
  });
  assertAcceptanceCurrent();
  state.acceptedNativeTurnId = accepted.nativeTurnId;
  state.phase = "accepted";
}
