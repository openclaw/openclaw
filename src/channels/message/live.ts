import { runBestEffortCleanup } from "../../infra/non-fatal-cleanup.js";
import type { ChannelDeliveryResult } from "../turn/delivery-outcome.js";
import { createAcceptedChannelDeliveryResult } from "../turn/delivery-result.js";
import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "../turn/partial-delivery-error.js";
import type { LiveMessageState, MessageReceipt, RenderedMessageBatch } from "./types.js";

/** A transport-owned preview. discardPending must stop new work before awaiting in-flight work. */
export type LivePreviewFinalizerDraft<TId> = {
  flush: () => Promise<void>;
  id: () => TId | undefined;
  seal?: () => Promise<void>;
  discardPending?: () => Promise<void>;
  clear: () => Promise<void>;
};

export type LivePreviewDraft<TId> = Omit<LivePreviewFinalizerDraft<TId>, "clear"> & {
  clear: () => Promise<boolean | void>;
};

export type LivePreviewDeliveryResult = ChannelDeliveryResult & { visibleReplySent: boolean };
type PreviewSendResult = LivePreviewDeliveryResult | boolean | void;

/** Whether a final answer may replace its preview or must be delivered separately. */
type LivePreviewFinalDeliveryMode = "in-place" | "separate";

export type LivePreviewFinalizerResultKind =
  | "normal-delivered"
  | "normal-skipped"
  | "preview-finalized"
  | "preview-retained";

type LivePreviewFinalizerResult<TPayload> = {
  kind: LivePreviewFinalizerResultKind;
  liveState?: LiveMessageState<TPayload>;
  deliveryResult?: LivePreviewDeliveryResult;
};

// Preserve the published literal shape: mapped types change contextual payload inference.
type PublishedPreviewAdapter<TPayload, TId, TEdit> = {
  draft?: LivePreviewFinalizerDraft<TId>;
  buildFinalEdit: (payload: TPayload) => TEdit | undefined;
  editFinal: (id: TId, edit: TEdit) => Promise<void>;
  resolveFinalizedId?: (id: TId, edit: TEdit) => TId | undefined;
  createPreviewReceipt?: (id: TId, edit: TEdit) => MessageReceipt;
  onPreviewFinalized?: (
    id: TId,
    receipt: MessageReceipt,
    liveState: LiveMessageState<TPayload>,
  ) => Promise<void> | void;
  buildSupplementalPayload?: (payload: TPayload) => TPayload | undefined;
  deliverSupplemental?: (payload: TPayload) => Promise<boolean | void>;
  handlePreviewEditError?: (params: {
    error: unknown;
    id: TId;
    edit: TEdit;
    payload: TPayload;
    liveState: LiveMessageState<TPayload>;
  }) => "fallback" | "retain" | Promise<"fallback" | "retain">;
  logPreviewEditFailure?: (error: unknown) => void;
};

type PreviewDeliveryParams<TPayload, TId, TEdit> = FinalizableLivePreviewAdapter<
  TPayload,
  TId,
  TEdit
> & {
  kind: "tool" | "block" | "final";
  payload: TPayload;
  liveState?: LiveMessageState<TPayload>;
  deliverNormally: (payload: TPayload) => Promise<PreviewSendResult>;
  onNormalDelivered?: () => Promise<void> | void;
  finalDelivery?: LivePreviewFinalDeliveryMode;
  onDiscardPendingPartialFailure?: (error: unknown) => void;
};

// Both interfaces execute the same delivery algorithm.
type FinalizableLivePreviewAdapter<TPayload, TId, TEdit> = Omit<
  PublishedPreviewAdapter<TPayload, TId, TEdit>,
  "draft" | "buildFinalEdit" | "editFinal" | "deliverSupplemental"
> & {
  draft?: LivePreviewDraft<TId>;
  buildFinalEdit?: (payload: TPayload) => TEdit | undefined;
  editFinal?: (id: TId, edit: TEdit) => Promise<void | LivePreviewDeliveryResult>;
  deliverSupplemental?: (payload: TPayload) => Promise<PreviewSendResult>;
};

type PublishedPreviewDeliveryParams<TPayload, TId, TEdit> = PublishedPreviewAdapter<
  TPayload,
  TId,
  TEdit
> & {
  kind: "tool" | "block" | "final";
  payload: TPayload;
  liveState?: LiveMessageState<TPayload>;
  deliverNormally: (payload: TPayload) => Promise<boolean | void>;
  onNormalDelivered?: () => Promise<void> | void;
};

type PreviewDeliveryOwner<TPayload> = {
  isCurrent: () => boolean;
  update: (state: LiveMessageState<TPayload>) => void;
  accept: (result: LivePreviewDeliveryResult, partial: boolean) => void;
  skip: (result: LivePreviewDeliveryResult) => void;
  complete: () => void;
  cleanup: boolean;
  onCleanupFailure?: (error: unknown) => void;
};

export function defineFinalizableLivePreviewAdapter<TPayload, TId, TEdit>(
  adapter: PublishedPreviewAdapter<TPayload, TId, TEdit>,
): PublishedPreviewAdapter<TPayload, TId, TEdit> {
  return adapter;
}

export function createLiveMessageState<TPayload = unknown>(params?: {
  receipt?: MessageReceipt;
  lastRendered?: RenderedMessageBatch<TPayload>;
  canFinalizeInPlace?: boolean;
}): LiveMessageState<TPayload> {
  return {
    phase: params?.receipt ? "previewing" : "idle",
    canFinalizeInPlace: params?.canFinalizeInPlace ?? Boolean(params?.receipt),
    ...(params?.receipt ? { receipt: params.receipt } : {}),
    ...(params?.lastRendered ? { lastRendered: params.lastRendered } : {}),
  };
}

export function createPreviewMessageReceipt(params: {
  id: unknown;
  threadId?: string;
  replyToId?: string;
  sentAt?: number;
  raw?: unknown;
}): MessageReceipt {
  const platformMessageId = String(params.id);
  return {
    primaryPlatformMessageId: platformMessageId,
    platformMessageIds: [platformMessageId],
    parts: [
      {
        platformMessageId,
        kind: "preview",
        index: 0,
        ...(params.threadId ? { threadId: params.threadId } : {}),
        ...(params.replyToId ? { replyToId: params.replyToId } : {}),
      },
    ],
    ...(params.threadId ? { threadId: params.threadId } : {}),
    ...(params.replyToId ? { replyToId: params.replyToId } : {}),
    sentAt: params.sentAt ?? Date.now(),
    ...(params.raw === undefined ? {} : { raw: [{ meta: { raw: params.raw } }] }),
  };
}

function visibleDelivery(result: PreviewSendResult): LivePreviewDeliveryResult | undefined {
  if (typeof result === "object") {
    return result.visibleReplySent ? result : undefined;
  }
  // Published stateless SDK callers historically acknowledge a send by resolving void.
  return result === false ? undefined : { visibleReplySent: true };
}

function combineDelivery(
  first: LivePreviewDeliveryResult | undefined,
  next: LivePreviewDeliveryResult,
): LivePreviewDeliveryResult {
  if (!first || first === next) {
    return next;
  }
  return createAcceptedChannelDeliveryResult({
    deliveryResults: [first, next],
    content: [first.content, next.content].filter(Boolean).join("\n"),
  });
}

function warnCleanupFailure(): void {
  console.warn("Live preview cleanup failed after delivery; a stale preview may remain");
}

/** The single promotion/replacement algorithm, shared by stateful and published stateless callers. */
async function deliverPreview<TPayload, TId, TEdit>(
  params: PreviewDeliveryParams<TPayload, TId, TEdit>,
  owner?: PreviewDeliveryOwner<TPayload>,
): Promise<LivePreviewFinalizerResult<TPayload>> {
  let liveState =
    params.liveState ??
    createLiveMessageState<TPayload>({ canFinalizeInPlace: Boolean(params.draft) });
  let accepted: LivePreviewDeliveryResult | undefined;
  let normalAccepted = false;
  const update = (next: LiveMessageState<TPayload>) => {
    liveState = next;
    owner?.update(next);
  };
  const accept = (result: LivePreviewDeliveryResult, partial = false) => {
    accepted = combineDelivery(accepted, result);
    owner?.accept(result, partial);
  };
  const send = async (
    payload: TPayload,
    deliver: (payload: TPayload) => Promise<PreviewSendResult>,
  ): Promise<LivePreviewDeliveryResult> => {
    if (owner && !owner.isCurrent()) {
      return { visibleReplySent: false, suppression: { reason: "no_visible_result" } };
    }
    let result: PreviewSendResult;
    try {
      result = await deliver(payload);
    } catch (error) {
      if (isChannelPartialDeliveryError(error)) {
        accept(error.deliveryResult, true);
      }
      throw error;
    }
    const normalized =
      typeof result === "object"
        ? result
        : (visibleDelivery(result) ?? { visibleReplySent: false });
    if (normalized.visibleReplySent) {
      accept(normalized);
    } else {
      owner?.skip(normalized);
    }
    return normalized;
  };
  const normal = async (payload: TPayload, completesFinal = false) => {
    const delivery = await send(payload, params.deliverNormally);
    if (delivery.visibleReplySent) {
      normalAccepted = true;
      if (completesFinal) {
        owner?.complete();
      }
      if (owner?.isCurrent() ?? true) {
        await params.onNormalDelivered?.();
      }
    }
    return delivery;
  };
  const result = (kind: LivePreviewFinalizerResultKind): LivePreviewFinalizerResult<TPayload> => ({
    kind,
    liveState,
    ...(accepted ? { deliveryResult: accepted } : {}),
  });

  try {
    if (owner && !owner.isCurrent()) {
      return result("normal-skipped");
    }
    // Promotion transfers custody to the durable answer. A later warning must not
    // reach either the final edit or fallback cleanup, even if given the old handle.
    if (params.kind !== "final" || !params.draft || liveState.phase === "finalized") {
      return result(
        (await normal(params.payload, true)).visibleReplySent
          ? "normal-delivered"
          : "normal-skipped",
      );
    }

    const draft = params.draft;
    const edit =
      params.finalDelivery !== "separate" && liveState.canFinalizeInPlace
        ? params.buildFinalEdit?.(params.payload)
        : undefined;
    if (edit !== undefined && params.editFinal) {
      await draft.flush();
      if (owner && !owner.isCurrent()) {
        return result("normal-skipped");
      }
      const previewId = draft.id();
      if (previewId !== undefined) {
        await draft.seal?.();
        if (owner && !owner.isCurrent()) {
          return result("normal-skipped");
        }
        let editResult: void | LivePreviewDeliveryResult = undefined;
        let edited = false;
        try {
          editResult = await params.editFinal(previewId, edit);
          edited = editResult?.visibleReplySent !== false;
        } catch (error) {
          if (isChannelPartialDeliveryError(error)) {
            update({
              ...liveState,
              phase: "finalized",
              canFinalizeInPlace: false,
              receipt:
                error.deliveryResult.receipt ?? createPreviewMessageReceipt({ id: previewId }),
            });
            accept(error.deliveryResult, true);
            throw error;
          }
          params.logPreviewEditFailure?.(error);
          const decision = await params.handlePreviewEditError?.({
            error,
            id: previewId,
            edit,
            payload: params.payload,
            liveState,
          });
          if (decision === "retain") {
            update({
              ...liveState,
              phase: "previewing",
              canFinalizeInPlace: true,
              receipt:
                liveState.receipt ??
                params.createPreviewReceipt?.(previewId, edit) ??
                createPreviewMessageReceipt({ id: previewId }),
            });
            return result("preview-retained");
          }
        }
        if (edited) {
          const finalizedId = params.resolveFinalizedId?.(previewId, edit) ?? previewId;
          const receipt =
            editResult?.receipt ??
            params.createPreviewReceipt?.(finalizedId, edit) ??
            createPreviewMessageReceipt({ id: finalizedId });
          update({ ...liveState, phase: "finalized", receipt, canFinalizeInPlace: false });
          accept(editResult ?? { visibleReplySent: true, receipt });
          if (owner?.isCurrent() ?? true) {
            await params.onPreviewFinalized?.(finalizedId, receipt, liveState);
          }
          const supplemental = params.buildSupplementalPayload?.(params.payload);
          if (supplemental !== undefined) {
            const delivered = params.deliverSupplemental
              ? await send(supplemental, params.deliverSupplemental)
              : await normal(supplemental);
            if (!delivered.visibleReplySent && !delivered.suppression) {
              const fallback = params.deliverSupplemental ? await normal(supplemental) : delivered;
              if (!fallback.visibleReplySent && !fallback.suppression) {
                throw new Error("Live preview supplemental payload was not delivered");
              }
            }
          }
          owner?.complete();
          return result("preview-finalized");
        }
      }
    }

    if (owner && !owner.isCurrent()) {
      return result("normal-skipped");
    }
    if (draft.discardPending) {
      try {
        await draft.discardPending();
      } catch (error) {
        if (params.finalDelivery !== "separate" || !isChannelPartialDeliveryError(error)) {
          throw error;
        }
        // A partial receipt belongs to the progress artifact, not the authoritative
        // final. Separate-final delivery must still get its own send attempt.
        params.onDiscardPendingPartialFailure?.(error);
      }
    } else {
      // Retained for the published legacy adapter contract. Modern adapters provide
      // discardPending so no visible artifact is deleted before replacement lands.
      await draft.clear();
    }
    if (owner && !owner.isCurrent()) {
      return result("normal-skipped");
    }
    update({ ...liveState, phase: "cancelled", canFinalizeInPlace: false });
    try {
      const delivered = await normal(params.payload, true);
      return result(delivered.visibleReplySent ? "normal-delivered" : "normal-skipped");
    } finally {
      if (normalAccepted && (owner?.cleanup ?? true) && (owner?.isCurrent() ?? true)) {
        await runBestEffortCleanup({
          cleanup: async () => {
            if ((await draft.clear()) === false) {
              throw new Error("Live preview deletion was not confirmed");
            }
          },
          onError: owner?.onCleanupFailure ?? warnCleanupFailure,
        });
      }
    }
  } catch (error) {
    if (accepted) {
      // Only evidence captured at send/edit boundaries participates. An accepted
      // progress flush error must never masquerade as an accepted final send.
      throw createChannelPartialDeliveryError(error, {
        ...accepted,
        visibleReplySent: true,
      });
    }
    throw error;
  }
}

/** Published stateless contract. Bundled channels use createLivePreviewLifecycle. */
export async function deliverFinalizableLivePreview<TPayload, TId, TEdit>(
  params: PublishedPreviewDeliveryParams<TPayload, TId, TEdit>,
): Promise<LivePreviewFinalizerResult<TPayload>> {
  return await deliverPreview(params);
}

/** Published adapter contract; shares the stateful owner's delivery implementation. */
export async function deliverWithFinalizableLivePreviewAdapter<TPayload, TId, TEdit>(params: {
  kind: "tool" | "block" | "final";
  payload: TPayload;
  liveState?: LiveMessageState<TPayload>;
  adapter?: PublishedPreviewAdapter<TPayload, TId, TEdit>;
  deliverNormally: (payload: TPayload) => Promise<boolean | void>;
  onNormalDelivered?: () => Promise<void> | void;
}): Promise<LivePreviewFinalizerResult<TPayload>> {
  return await deliverPreview({ ...params.adapter, ...params });
}

type FinalOutcome =
  | "pending"
  | "sending"
  | "accepted"
  | "delivered"
  | "error"
  | "partial"
  | "failed"
  | "suppressed";
type PreviewGeneration<TPayload> = {
  state: LiveMessageState<TPayload>;
  outcome: FinalOutcome;
  failureSettlement?: Promise<void>;
  failureSettlementError?: unknown;
};

export type LivePreviewLifecycle<TPayload, TId> = {
  readonly previewFinalized: boolean;
  readonly finalDelivered: boolean;
  readonly finalSucceeded: boolean;
  readonly finalFailed: boolean;
  readonly finalStarted: boolean;
  readonly finalSuppressed: boolean;
  beginFinalDelivery: () => void;
  deliver<TEdit = never>(params: {
    kind: "tool" | "block" | "final";
    payload: TPayload;
    isError?: boolean;
    adapter?: Omit<FinalizableLivePreviewAdapter<TPayload, TId, TEdit>, "draft">;
    deliverNormally: (payload: TPayload) => Promise<LivePreviewDeliveryResult>;
    onNormalDelivered?: () => Promise<void> | void;
  }): Promise<LivePreviewFinalizerResult<TPayload>>;
  observeDelivery: (
    result: LivePreviewDeliveryResult,
    options?: { isError?: boolean },
  ) => Promise<void>;
  observeSettlement: (
    result: ChannelDeliveryResult | void,
    options?: { isError?: boolean },
  ) => Promise<void>;
  observeFailure: (result?: ChannelDeliveryResult) => void;
  observeSuppression: () => void;
  cleanup: (options?: { failed?: boolean }) => Promise<void>;
  retainPreview: () => void;
  reset: () => void;
};

/** Owns one admitted turn's final facts and preview custody, not provider wire semantics. */
export function createLivePreviewLifecycle<TPayload, TId>(
  options: {
    draft?: LivePreviewDraft<TId>;
    retainOnError?: boolean;
    cleanupUndelivered?: boolean;
    finalDelivery?: LivePreviewFinalDeliveryMode;
    onFinalFailure?: () => Promise<void> | void;
    onFinalFailureError?: (error: unknown) => void;
    onDiscardPendingPartialFailure?: (error: unknown) => void;
    onFinalStarted?: () => void;
    onFinalDelivered?: () => void;
    onCleanupFailure?: (error: unknown) => void;
  } = {},
): LivePreviewLifecycle<TPayload, TId> {
  const newGeneration = (): PreviewGeneration<TPayload> => ({
    state: createLiveMessageState({ canFinalizeInPlace: Boolean(options.draft) }),
    outcome: "pending",
  });
  let generation = newGeneration();
  const hasAccepted = (current: PreviewGeneration<TPayload>) =>
    current.outcome === "accepted" ||
    current.outcome === "delivered" ||
    current.outcome === "error" ||
    current.outcome === "partial";
  const settleFinalFailure = async (
    current: PreviewGeneration<TPayload>,
    optionsForSettlement?: { propagate?: boolean },
  ) => {
    if (
      current !== generation ||
      !options.onFinalFailure ||
      (hasAccepted(current) && current.outcome !== "error")
    ) {
      return;
    }
    current.failureSettlement ??= Promise.resolve().then(async () => {
      if (current !== generation || (hasAccepted(current) && current.outcome !== "error")) {
        return;
      }
      await options.onFinalFailure?.();
    });
    const attempt = current.failureSettlement;
    try {
      await attempt;
      current.failureSettlementError = undefined;
    } catch (error) {
      if (current.failureSettlement === attempt) {
        current.failureSettlement = undefined;
        current.failureSettlementError = error;
        options.onFinalFailureError?.(error);
      }
      if (optionsForSettlement?.propagate) {
        throw error;
      }
    }
  };
  const beginFinalDelivery = () => {
    if (generation.outcome === "pending") {
      generation.outcome = "sending";
      options.onFinalStarted?.();
    }
  };
  const cleanup = async (current: PreviewGeneration<TPayload>, failed = false) => {
    if (current !== generation) {
      return;
    }
    if (failed && !hasAccepted(current)) {
      current.outcome = "failed";
      await settleFinalFailure(current);
    } else if (
      current.failureSettlement ||
      current.outcome === "failed" ||
      current.outcome === "error"
    ) {
      await settleFinalFailure(current);
    }
    if (current !== generation) {
      return;
    }
    await runBestEffortCleanup({
      cleanup: async () => {
        if (current !== generation) {
          return;
        }
        await options.draft?.discardPending?.();
        if (
          current !== generation ||
          current.state.phase === "finalized" ||
          current.outcome === "failed" ||
          current.outcome === "sending" ||
          current.outcome === "accepted" ||
          current.outcome === "partial" ||
          (current.outcome === "error" && options.retainOnError) ||
          (!hasAccepted(current) && (failed || !options.cleanupUndelivered))
        ) {
          return;
        }
        if ((await options.draft?.clear()) === false) {
          throw new Error("Live preview deletion was not confirmed");
        }
      },
      onError: options.onCleanupFailure ?? warnCleanupFailure,
    });
  };
  const observeDelivery = async (
    result: LivePreviewDeliveryResult,
    observation?: { isError?: boolean },
  ) => {
    if (!result.visibleReplySent) {
      return;
    }
    const current = generation;
    const started = current.outcome !== "pending";
    const notify = current.outcome !== "delivered" && !observation?.isError;
    if (current.outcome !== "delivered") {
      current.outcome = observation?.isError ? "error" : "delivered";
    }
    if (current.state.phase !== "finalized") {
      current.state = { ...current.state, phase: "cancelled", canFinalizeInPlace: false };
    }
    try {
      if (!started) {
        options.onFinalStarted?.();
      }
      if (notify) {
        options.onFinalDelivered?.();
      }
    } catch (error) {
      throw createChannelPartialDeliveryError(error, { ...result, visibleReplySent: true });
    } finally {
      await cleanup(current);
    }
  };
  const observeFailure = (result?: ChannelDeliveryResult) => {
    if (generation.outcome !== "delivered" && generation.outcome !== "error") {
      beginFinalDelivery();
      generation.outcome =
        result?.visibleReplySent || hasAccepted(generation) ? "partial" : "failed";
      void settleFinalFailure(generation);
    }
  };
  const observeSuppression = () => {
    if (!hasAccepted(generation) && generation.outcome !== "failed") {
      beginFinalDelivery();
      generation.outcome = "suppressed";
    }
  };
  const observeSettlement = async (
    result: ChannelDeliveryResult | void,
    observation?: { isError?: boolean },
  ) => {
    const delivered =
      result === undefined
        ? { visibleReplySent: true as const }
        : result.visibleReplySent === true
          ? { ...result, visibleReplySent: true as const }
          : undefined;
    if (delivered) {
      await observeDelivery(delivered, observation);
      return;
    }
    if (typeof result === "object" && result.suppression) {
      observeSuppression();
      return;
    }
    observeFailure();
  };
  return {
    get previewFinalized() {
      return (
        generation.state.phase === "finalized" ||
        (generation.state.phase === "cancelled" && generation.outcome === "delivered")
      );
    },
    get finalDelivered() {
      return hasAccepted(generation);
    },
    get finalSucceeded() {
      return generation.outcome === "delivered";
    },
    get finalFailed() {
      return generation.outcome === "failed" || generation.outcome === "partial";
    },
    get finalStarted() {
      return generation.outcome !== "pending";
    },
    get finalSuppressed() {
      return generation.outcome === "suppressed";
    },
    beginFinalDelivery,
    async deliver(params) {
      const current = generation;
      const terminal = params.kind === "final";
      const previouslyAccepted = current.outcome === "delivered";
      if (terminal) {
        beginFinalDelivery();
      }
      if (terminal && params.isError) {
        await settleFinalFailure(current);
      }
      try {
        const result = await deliverPreview(
          {
            ...params.adapter,
            ...params,
            draft: options.draft,
            liveState: current.state,
            finalDelivery: options.finalDelivery,
            onDiscardPendingPartialFailure: options.onDiscardPendingPartialFailure,
          },
          {
            isCurrent: () => current === generation,
            update: (state) => {
              current.state = state;
            },
            accept: (_result, partial) => {
              if (!terminal || previouslyAccepted || current.outcome === "delivered") {
                return;
              }
              current.outcome = partial ? "partial" : params.isError ? "error" : "accepted";
            },
            skip: (deliveryResult) => {
              if (!terminal || current !== generation || hasAccepted(current)) {
                return;
              }
              current.outcome = deliveryResult.suppression ? "suppressed" : "failed";
            },
            complete: () => {
              if (!terminal || current.outcome === "delivered") {
                return;
              }
              current.outcome = params.isError ? "error" : "delivered";
              if (current === generation && !params.isError) {
                options.onFinalDelivered?.();
              }
            },
            cleanup: !(params.isError && options.retainOnError),
            onCleanupFailure: options.onCleanupFailure,
          },
        );
        if (terminal && current.outcome === "sending") {
          current.outcome = "suppressed";
        }
        if (terminal && current.outcome === "failed") {
          await settleFinalFailure(current, { propagate: true });
        }
        return result;
      } catch (error) {
        if (terminal && !previouslyAccepted && current.outcome !== "delivered") {
          current.outcome = hasAccepted(current) ? "partial" : "failed";
          if (error !== current.failureSettlementError) {
            await settleFinalFailure(current);
          }
        }
        throw error;
      }
    },
    observeDelivery,
    observeSettlement,
    observeFailure,
    observeSuppression,
    async cleanup(params) {
      await cleanup(generation, params?.failed);
    },
    retainPreview() {
      generation.state = { ...generation.state, phase: "finalized", canFinalizeInPlace: false };
    },
    reset() {
      generation = newGeneration();
    },
  };
}

export function markLiveMessagePreviewUpdated<TPayload>(
  state: LiveMessageState<TPayload>,
  rendered: RenderedMessageBatch<TPayload>,
): LiveMessageState<TPayload> {
  return {
    ...state,
    phase: "previewing",
    lastRendered: rendered,
  };
}
