import { createMemo, createSignal, Match, Show, Switch } from "solid-js";
import { handleCopyButton } from "../../components/copy-button-state.ts";
import { ModalDialog } from "../../components/modal-dialog.tsx";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import type { SourceProjection } from "../../lib/reactive/projection.ts";
import { TemplateArtwork } from "../agents-home/template-artwork.tsx";
import type { TemplateCreator } from "./creator-publication.ts";
import { TemplateCreatorSignInCard } from "./creator-sign-in-card.tsx";
import { TemplateReviewCard } from "./template-review-card.tsx";

type CreatorView = SourceProjection<TemplateCreator, TemplateCreator>;

function cardStatus(state: TemplateCreator) {
  if (state.busy === "publishing") {
    return "publishing";
  }
  if (state.publicationIssue) {
    if (state.busy === "reviewing") {
      return "checkingStatus";
    }
    return state.publicationIssue === "unconfirmed" ? "unconfirmed" : "notPublished";
  }
  if (state.publication) {
    return state.publication.publicationStatus;
  }
  if (state.busy || !state.reviewCurrent) {
    return !state.busy && state.error ? "draftUnavailable" : "updating";
  }
  return "unpublished";
}

type ReviewProps = { flow: TemplateCreator; view: CreatorView };

export function TemplateCreatorReviewView(props: ReviewProps) {
  return (
    <Show when={props.view.read().signIn} fallback={<TemplatePublishCard {...props} />}>
      {(signIn) => <TemplateCreatorSignInCard state={signIn()} flow={props.flow} />}
    </Show>
  );
}

function TemplatePublishCard(props: ReviewProps) {
  const state = () => props.view.read();
  const review = () => state().review;
  const byline = (publisher: string) => t("templatesDraft.byCreator", { creator: "@" + publisher });
  const status = createMemo(() => cardStatus(state()));
  // A preview belongs to the exact reviewed archive, never a replacement draft.
  const readyReview = () => status() === "unpublished" && review();
  const hint = () => {
    switch (status()) {
      case "pending":
        return state().error ? t("templatesDraft.statusDelayed") : null;
      case "updating":
        return t("templatesDraft.updatingHint");
      case "draftUnavailable":
        return t("templatesDraft.draftUnavailableHint");
      case "unconfirmed":
        return t("templatesDraft.unconfirmedHint");
      case "checkingStatus":
        return t("templatesDraft.checkingHint");
      case "notPublished":
        return t("templatesDraft.notPublishedHint");
      default:
        return null;
    }
  };
  const busyAction = () => {
    switch (status()) {
      case "publishing":
        return t("templatesDraft.publishing");
      case "updating":
        return t("templatesDraft.preparing");
      case "checkingStatus":
        return t("templatesDraft.checking");
      default:
        return null;
    }
  };
  return (
    <Show
      when={review()}
      fallback={
        <Show when={!state().busy && state().error}>
          {(error) => (
            <InlineAlert
              tone="danger"
              title={t("templatesDraft.draftUnavailable")}
              action={
                <button type="button" class="btn btn--sm" onClick={() => props.flow.retryReview()}>
                  {t("templatesDraft.tryAgain")}
                </button>
              }
            >
              {error()}
            </InlineAlert>
          )}
        </Show>
      }
    >
      <section class="template-publish-card" aria-label={t("templatesDraft.publishTitle")}>
        <header>
          <span class="template-art">
            <TemplateArtwork src={review()?.iconUrl} />
          </span>
          <div>
            <h2>{review()?.displayName ?? t("templatesDraft.draftTitle")}</h2>
            <Show when={review()?.publisher}>
              {(publisher) => <p class="muted">{byline(publisher())}</p>}
            </Show>
          </div>
          <span class="template-creator__status" data-state={status()} role="status">
            {t("templatesDraft." + status())}
          </span>
        </header>
        <Show when={review()?.description}>
          {(description) => <p class="template-summary">{description()}</p>}
        </Show>
        <Show when={hint()}>{(message) => <p role="status">{message()}</p>}</Show>
        <Show when={state().error && status() !== "pending" && !busyAction()}>
          <InlineAlert tone="danger">{state().error}</InlineAlert>
        </Show>
        <footer class="template-actions">
          <Switch>
            <Match when={readyReview()} keyed>
              {(draft) => {
                const [preview, setPreview] = createSignal(false);
                const publish = () => {
                  setPreview(false);
                  if (props.flow.review?.reviewToken === draft.reviewToken) {
                    void props.flow.publish();
                  }
                };
                return (
                  <>
                    <button
                      type="button"
                      class="btn"
                      aria-haspopup="dialog"
                      onClick={() => setPreview(true)}
                    >
                      {t("templatesDraft.preview")}
                    </button>
                    <button type="button" class="btn primary" onClick={publish}>
                      {t("templatesDraft.publish")}
                    </button>
                    <Show when={preview()}>
                      <ModalDialog
                        open
                        label={t("templatesDraft.previewTitle")}
                        style={{ "--openclaw-modal-width": "620px" }}
                        onOpenChange={(open) => {
                          if (!open) {
                            setPreview(false);
                          }
                        }}
                      >
                        <div class="template-import-dialog">
                          <TemplateReviewCard
                            review={draft}
                            byline={byline(draft.publisher)}
                            status={
                              <span class="template-creator__status">
                                {t("templatesDraft.unpublished")}
                              </span>
                            }
                            readPackagePreview={(item) => props.flow.readPackagePreview(item)}
                            footer={
                              <openclaw-modal-actions>
                                <button type="button" class="btn" onClick={() => setPreview(false)}>
                                  {t("common.close")}
                                </button>
                                <button type="button" class="btn primary" onClick={publish}>
                                  {t("templatesDraft.publish")}
                                </button>
                              </openclaw-modal-actions>
                            }
                          />
                        </div>
                      </ModalDialog>
                    </Show>
                  </>
                );
              }}
            </Match>
            <Match when={busyAction()}>
              {(label) => (
                <button type="button" class="btn primary" disabled aria-busy="true">
                  <span class="btn__spinner" aria-hidden="true" />
                  {label()}
                </button>
              )}
            </Match>
            <Match when={status() === "pending" && state().publication?.url}>
              {(url) => (
                <a
                  class="btn primary"
                  href={`${url()}?view=submission`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t("templatesDraft.viewSubmission")}
                </a>
              )}
            </Match>
            <Match when={status() === "published" && state().publication?.url} keyed>
              {(url) => {
                let copyLabel!: HTMLSpanElement;
                return (
                  <button
                    type="button"
                    class="btn primary"
                    onClick={(event) =>
                      void handleCopyButton(event, url, t("templatesDraft.copyLink"), {
                        label: copyLabel,
                      })
                    }
                  >
                    <span ref={(element) => (copyLabel = element)}>
                      {t("templatesDraft.copyLink")}
                    </span>
                  </button>
                );
              }}
            </Match>
            <Match when={status() === "unconfirmed"}>
              <button
                type="button"
                class="btn primary"
                onClick={() => void props.flow.checkPublication()}
              >
                {t("templatesDraft.checkStatus")}
              </button>
            </Match>
            <Match when={status() === "notPublished" || status() === "draftUnavailable"}>
              <button type="button" class="btn primary" onClick={() => props.flow.retryReview()}>
                {t(status() === "draftUnavailable" ? "templatesDraft.tryAgain" : "common.retry")}
              </button>
            </Match>
          </Switch>
        </footer>
      </section>
    </Show>
  );
}
