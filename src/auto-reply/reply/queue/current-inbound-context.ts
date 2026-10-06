import type { FollowupRun } from "./types.js";

/** Combines queued runtime context while keeping one current reply anchor. */
export function collectCurrentInboundContext(
  items: readonly FollowupRun[],
): FollowupRun["currentInboundContext"] {
  const contexts = items.flatMap((item, index) =>
    item.currentInboundContext ? [{ context: item.currentInboundContext, index }] : [],
  );
  if (contexts.length === 0) {
    return undefined;
  }
  if (items.length === 1) {
    return items[0]?.currentInboundContext;
  }
  // The newest queued item owns the aggregate turn's singular reply anchor.
  const selectedContext = items.at(-1)?.currentInboundContext;
  const renderField = (field: "text" | "resumableText") => {
    const blocks = contexts.flatMap(({ context, index }) => {
      const value = context[field];
      return value ? [`Queued #${index + 1} context:\n${value}`] : [];
    });
    return blocks.length > 0 ? blocks.join("\n\n") : undefined;
  };
  const text = renderField("text");
  if (!text && !selectedContext?.reply && !selectedContext?.replyIdentifiers) {
    return undefined;
  }
  const resumableText = renderField("resumableText");
  const injectedGoalContexts = [
    ...new Set(contexts.flatMap(({ context }) => context.injectedGoalContexts ?? [])),
  ];
  return {
    text: text ?? "",
    ...(resumableText ? { resumableText } : {}),
    fragments: contexts.flatMap(
      ({ context }) =>
        context.fragments ?? [{ kind: "conversation-data" as const, text: context.text }],
    ),
    promptJoiner: "\n\n",
    ...(injectedGoalContexts.length > 0 ? { injectedGoalContexts } : {}),
    ...(selectedContext?.reply ? { reply: selectedContext.reply } : {}),
    ...(selectedContext?.replyIdentifiers
      ? { replyIdentifiers: selectedContext.replyIdentifiers }
      : {}),
  };
}
