import type { SessionProviderReview } from "../config/sessions/provider-review.types.js";
import { getAgentRunContext, getAgentRunLifecycleGeneration } from "../infra/agent-run-registry.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { isIncognitoSessionKey } from "../shared/incognito-session-key.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import type { ProviderReviewTarget } from "./provider-review.js";

/** Carried only by the existing run owner; never serialized into event metadata. */
export type ProviderReviewTerminalFact = Readonly<{
  target: Readonly<ProviderReviewTarget>;
  review: Readonly<SessionProviderReview>;
  expectedWriterRunId: string;
  lifecycleGeneration: string;
  lifecycleStartedAt?: number;
  capturedAtMs: number;
  assertCurrent: () => void;
}>;

const issuedFacts = resolveGlobalSingleton(
  Symbol.for("openclaw.providerReviewTerminalFacts"),
  () => new WeakSet<ProviderReviewTerminalFact>(),
);

/** Incognito metadata joins its existing terminal write instead of opening another store. */
export function captureAgentRunProviderReview(params: {
  runId: string;
  target: ProviderReviewTarget;
  review: SessionProviderReview;
  expectedWriterRunId: string;
  assertCurrent: () => void;
}): void {
  params.assertCurrent();
  const context = getAgentRunContext(params.runId);
  const lifecycleGeneration = getAgentRunLifecycleGeneration();
  if (
    !isIncognitoSessionKey(params.target.sessionKey) ||
    !context ||
    context.lifecycleGeneration !== lifecycleGeneration ||
    context.sessionKey !== params.target.sessionKey ||
    context.sessionId !== params.target.sessionId ||
    params.review.runId !== params.runId ||
    params.review.sessionId !== params.target.sessionId ||
    !params.expectedWriterRunId
  ) {
    throw new Error("Provider review no longer owns its incognito run");
  }
  const target = Object.freeze({
    ...params.target,
    storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: params.target.agentId }),
  });
  const review = structuredClone(params.review);
  if (review.review?.continuation) {
    Object.freeze(review.review.continuation);
  }
  if (review.review) {
    Object.freeze(review.review);
  }
  Object.freeze(review);
  // Normal runtime closure releases tools before the retained terminal write settles.
  const assertSourceCurrent = context.assertSourceCurrent;
  const fact: ProviderReviewTerminalFact = Object.freeze({
    target,
    review,
    expectedWriterRunId: params.expectedWriterRunId,
    lifecycleGeneration,
    lifecycleStartedAt: context.lifecycleStartedAt,
    capturedAtMs: Date.now(),
    assertCurrent: () => {
      assertSourceCurrent?.();
      if (
        getAgentRunLifecycleGeneration() !== lifecycleGeneration ||
        getAgentRunContext(params.runId) !== context ||
        context.providerReviewTerminal !== fact ||
        resolveIncognitoOpenClawAgentSqlitePath({ agentId: target.agentId }) !== target.storePath ||
        context.sessionKey !== target.sessionKey ||
        context.sessionId !== target.sessionId
      ) {
        throw new Error("Provider review terminal ownership changed");
      }
    },
  });
  params.assertCurrent();
  issuedFacts.add(fact);
  Object.defineProperty(context, "providerReviewTerminal", {
    value: fact,
    enumerable: false,
    configurable: true,
  });
}

export function readAgentRunProviderReview(runId: string): ProviderReviewTerminalFact | undefined {
  const fact = getAgentRunContext(runId)?.providerReviewTerminal;
  if (!fact || !issuedFacts.has(fact)) {
    return undefined;
  }
  fact.assertCurrent();
  return fact;
}
