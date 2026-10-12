import type { GetReplyOptions } from "../get-reply-options.types.js";

type CommentaryProgressOwnerOptions = Pick<
  GetReplyOptions,
  | "onVerboseProgressVisibility"
  | "onVerboseProgressVisibilityAsync"
  | "shouldDeliverCommentaryPayloads"
>;

/** Freezes and registers one commentary owner for the current agent turn. */
export async function resolveTurnCommentaryProgressOwner(params: {
  commentaryPayloadsEnabled: boolean;
  options?: CommentaryProgressOwnerOptions;
  resolveVerboseProgressVisibility: () => boolean;
  resolveVerboseProgressVisibilityAsync: () => Promise<boolean>;
}): Promise<{
  commentaryPayloadsEnabled: boolean;
  draftOwnsCommentaryProgress: boolean;
}> {
  const shouldDeliverCommentaryPayloads = params.commentaryPayloadsEnabled
    ? params.options?.shouldDeliverCommentaryPayloads
    : undefined;
  if (params.options?.onVerboseProgressVisibilityAsync) {
    const frozen = shouldDeliverCommentaryPayloads
      ? await params.resolveVerboseProgressVisibilityAsync()
      : undefined;
    await params.options.onVerboseProgressVisibilityAsync(
      frozen === undefined ? params.resolveVerboseProgressVisibilityAsync : async () => frozen,
    );
  } else if (params.options?.onVerboseProgressVisibility) {
    const frozen = shouldDeliverCommentaryPayloads
      ? params.resolveVerboseProgressVisibility()
      : undefined;
    params.options.onVerboseProgressVisibility(
      frozen === undefined ? params.resolveVerboseProgressVisibility : () => frozen,
    );
  }
  const commentaryPayloadsEnabled =
    params.commentaryPayloadsEnabled && (shouldDeliverCommentaryPayloads?.() ?? true);
  return {
    commentaryPayloadsEnabled,
    draftOwnsCommentaryProgress:
      params.commentaryPayloadsEnabled &&
      shouldDeliverCommentaryPayloads !== undefined &&
      !commentaryPayloadsEnabled,
  };
}
