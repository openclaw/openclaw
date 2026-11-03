import type { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import type { ChatPageHost } from "./chat-state-host.ts";

export type FailedMessageEditSource = {
  state: Readonly<
    Pick<
      ChatPageHost,
      | "chatMessages"
      | "chatMessage"
      | "chatAttachments"
      | "chatMentions"
      | "chatReplyTarget"
      | "chatGoalDraftMode"
    >
  >;
  runId: string;
  isCurrent: () => boolean;
  readIdentity: typeof readSessionMessageIdentity;
  rewind: (entryId: string) => Promise<boolean> | boolean;
};

/** The optional edit action consumes live facts and the existing rewind owner. */
export function createFailedMessageEdit(source?: FailedMessageEditSource) {
  if (!source?.isCurrent()) {
    return undefined;
  }
  const { state, runId, readIdentity } = source;
  const entryId = () => {
    const user = state.chatMessages.findLast((message) => readIdentity(message)?.role === "user");
    const identity = readIdentity(user);
    return identity?.runId === runId && !identity.isImported ? identity.id : null;
  };
  const hasDraft = () =>
    Boolean(
      state.chatMessage ||
      state.chatAttachments.length ||
      state.chatMentions?.length ||
      state.chatReplyTarget ||
      state.chatGoalDraftMode,
    );
  if (!entryId()) {
    return undefined;
  }
  return {
    disabled: hasDraft(),
    run: () => {
      const id = entryId();
      if (!source.isCurrent() || !id || hasDraft()) {
        return false;
      }
      return source.rewind(id);
    },
  };
}
