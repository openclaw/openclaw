import type { HumanMention } from "../../lib/chat/chat-types.ts";
import type { SessionCreateParams } from "../../lib/sessions/create.ts";

const WORKTREE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * One closed visibility mode instead of independent incognito/draft booleans:
 * an incognito session is never persisted, so "incognito draft" is unrepresentable.
 */
export type NewSessionVisibility = "normal" | "draft" | "incognito";
export type DraftSessionCreateOverrides = Partial<
  Pick<SessionCreateParams, "message" | "attachments" | "displayName">
> & { mentions?: readonly HumanMention[]; visibility?: NewSessionVisibility };
export type DraftSessionCreateSelection = Partial<
  Pick<
    SessionCreateParams,
    "attachments" | "permissionMode" | "catalogId" | "category" | "displayName"
  >
> & {
  message: string;
  mentions?: readonly HumanMention[];
  visibility: NewSessionVisibility;
  toolOverrides?: SessionCreateParams["toolOverrides"] | null;
};

export function isWorktreeNameValid(value: string): boolean {
  const name = value.trim();
  return !name || WORKTREE_NAME_PATTERN.test(name);
}
