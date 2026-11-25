import type { ApplicationContext } from "../../app/context.ts";
import type {
  ChatAttachment,
  ChatComposerMemoryFallback,
  ChatGoalDraftMode,
  ChatReplyTarget,
  HumanMention,
} from "../../lib/chat/chat-types.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";

export type PaneSessionHandoff = {
  goalMode?: ChatGoalDraftMode;
  replyTarget?: ChatReplyTarget;
  attachments: ChatAttachment[];
  composerFallbacks?: Record<string, ChatComposerMemoryFallback>;
  draft: string;
  mentions?: readonly HumanMention[];
  send?: boolean;
};

export type PendingPaneSessionHandoff = {
  value: PaneSessionHandoff;
  expiresAt: number;
  sessionKey: string;
  isCurrent: () => boolean;
};

export const PANE_SESSION_HANDOFF_TTL_MS = 30_000;
// The app scopes one-shot transfers; deletion needs synchronous access before chat loads.
export const paneSessionHandoffs = new WeakMap<
  ApplicationContext,
  Map<string, PendingPaneSessionHandoff[]>
>();

export function removePaneSessionHandoffs(
  pending: PendingPaneSessionHandoff[] | undefined,
  matches: (handoff: PendingPaneSessionHandoff) => boolean,
): void {
  for (let index = (pending?.length ?? 0) - 1; index >= 0; index -= 1) {
    if (matches(pending![index]!)) {
      pending!.splice(index, 1);
    }
  }
}

export function retireSessionPaneHandoffs(
  context: ApplicationContext,
  targets: readonly { key: string; retireBeforeRevision: number }[],
): void {
  for (const pending of paneSessionHandoffs.get(context)?.values() ?? []) {
    removePaneSessionHandoffs(
      pending,
      (handoff) =>
        handoff.isCurrent() &&
        targets.some(
          ({ key, retireBeforeRevision }) =>
            areUiSessionKeysEquivalent(handoff.sessionKey, key) &&
            handoff.expiresAt - PANE_SESSION_HANDOFF_TTL_MS < retireBeforeRevision,
        ),
    );
  }
}
