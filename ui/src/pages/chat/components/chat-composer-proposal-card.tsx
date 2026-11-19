import { createSignal, onSettled, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import type { ComposerProposal } from "./chat-composer-proposal.ts";

/**
 * A plugin-offered draft, presented like a prediction: nothing changes until the user picks
 * Use (Tab) or Dismiss (Escape). The pane's textarea stays the only editing owner.
 */
export function ComposerProposalCard(props: {
  proposal: ComposerProposal;
  draft: string;
  canCompose: boolean;
  keyHints: boolean;
  textarea: () => HTMLTextAreaElement | null;
}) {
  onSettled(() => props.proposal.present());
  // Each offer starts collapsed; expanding is the user's choice, so it never shifts layout unasked.
  const [expanded, setExpanded] = createSignal(() => {
    void props.proposal.pending;
    return false;
  });
  return (
    <Show
      when={props.proposal.pending}
      keyed
      fallback={
        <Show when={props.proposal.isCurrent(props.draft) && props.proposal.accepted}>
          {(accepted) => (
            <div
              class="agent-chat__composer-proposal agent-chat__composer-proposal--accepted"
              role="status"
            >
              <div class="agent-chat__composer-proposal-head">
                <span class="agent-chat__composer-proposal-glyph" aria-hidden="true">
                  <Icon name="check" />
                </span>
                <span class="agent-chat__composer-proposal-title">
                  {t("chat.composer.proposal.accepted")}
                </span>
                <span class="agent-chat__composer-proposal-meta">
                  {accepted().title} · {t("chat.composer.proposal.notSent")}
                </span>
                <button
                  type="button"
                  class="btn btn--sm btn--ghost"
                  onClick={() => props.proposal.undo(props.textarea())}
                >
                  <Icon name="rotateCcw" />
                  {t("chat.composer.proposal.undo")}
                </button>
              </div>
            </div>
          )}
        </Show>
      }
    >
      {(pending) => (
        <div
          class="agent-chat__composer-proposal"
          role="region"
          aria-label={pending.title}
          data-expanded={expanded() ? "" : undefined}
        >
          <div class="agent-chat__composer-proposal-head">
            <span class="agent-chat__composer-proposal-glyph" aria-hidden="true">
              <Icon name="pencilSparkles" />
            </span>
            <span class="agent-chat__composer-proposal-title">{pending.title}</span>
            <span class="agent-chat__composer-proposal-meta">
              {props.draft.trim()
                ? t("chat.composer.proposal.replacesDraft")
                : t("chat.composer.proposal.notSent")}
            </span>
            <button
              type="button"
              class="btn btn--sm btn--ghost"
              onClick={() => props.proposal.dismiss()}
            >
              {t("chat.composer.proposal.dismiss")}
              <Show when={props.keyHints}>
                <kbd>{t("chat.composer.proposal.dismissKey")}</kbd>
              </Show>
            </button>
            <button
              type="button"
              class="btn btn--sm primary"
              disabled={!props.canCompose}
              onClick={() => props.proposal.accept(props.textarea())}
            >
              {t("chat.composer.proposal.use")}
              <Show when={props.keyHints}>
                <kbd>{t("chat.composer.proposal.useKey")}</kbd>
              </Show>
            </button>
          </div>
          <p
            class="agent-chat__composer-proposal-body"
            title={expanded() ? undefined : t("chat.composer.proposal.expand")}
            onClick={() => setExpanded(true)}
          >
            {pending.text}
          </p>
        </div>
      )}
    </Show>
  );
}

/** For the composer's live region, beside the prediction announcement. */
export function composerProposalAnnouncement(proposal: ComposerProposal): string {
  const pending = proposal.pending;
  return pending ? t("chat.composer.proposal.available", { title: pending.title }) : "";
}
