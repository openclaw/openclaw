import type { ReactionBundleContext } from "./types.js";

export function buildReactionPrompt(bundle: ReactionBundleContext): string {
  const blocks: string[] = [];

  const reactionEntries = bundle.reactions.map((r) => ({
    emoji: r.emoji,
    actor: r.actorLabel,
    action: r.action,
  }));

  blocks.push(
    [
      "Reaction notification (respond only if appropriate):",
      "```json",
      JSON.stringify(
        {
          channel: bundle.channel,
          message_id: bundle.messageId,
          conversation: bundle.conversationLabel,
          reactions: reactionEntries,
        },
        null,
        2,
      ),
      "```",
    ].join("\n"),
  );

  if (bundle.reactedMessageContent) {
    blocks.push(
      [
        "Reacted-to message (untrusted, for context):",
        "```json",
        JSON.stringify(
          {
            sender_label: bundle.reactedMessageAuthor ?? "Unknown",
            body: bundle.reactedMessageContent,
          },
          null,
          2,
        ),
        "```",
      ].join("\n"),
    );
  }

  return blocks.join("\n\n");
}
