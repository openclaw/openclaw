import { For, Show } from "solid-js";
import { handleCopyButton } from "../../components/copy-button-state.ts";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import type { SourceProjection } from "../../lib/reactive/projection.ts";
import type { TemplateCreator } from "./creator-publication.ts";
import { TemplateReviewCard } from "./template-review-card.tsx";
import "../../components/tooltip.ts";

type CreatorView = SourceProjection<TemplateCreator, TemplateCreator>;
function TemplateCreatorCard(props: { flow: TemplateCreator; view: CreatorView }) {
  const state = () => props.view.read();
  const busy = () => state().busy === "publishing";
  const publicationStatus = () =>
    state().publicationIssue
      ? undefined
      : (state().publication?.publicationStatus ?? "unpublished");
  // The plain owner admits synchronously and settles writes independently of card lifetime.
  const publish = () => props.flow.publish();
  return (
    <TemplateReviewCard
      review={state().review!}
      byline={t("templatesDraft.byCreator", { creator: "@" + state().review!.publisher })}
      readPackagePreview={(item) => props.flow.readPackagePreview(item)}
      status={
        <Show when={publicationStatus()}>
          <span class="template-creator__status-anchor">
            <openclaw-tooltip
              prop:content={
                publicationStatus() === "pending" ? t("templatesDraft.awaitingReview") : ""
              }
              prop:disabled={publicationStatus() !== "pending"}
            >
              <span
                class="template-creator__status"
                data-state={publicationStatus()}
                role="status"
                tabindex={publicationStatus() === "pending" ? 0 : undefined}
              >
                {t("templatesDraft." + publicationStatus())}
              </span>
            </openclaw-tooltip>
          </span>
        </Show>
      }
      footer={
        <>
          <Show when={state().error}>
            <InlineAlert tone="danger" role="alert">
              {state().error}
            </InlineAlert>
          </Show>
          <div class="template-creator__actions">
            <Show
              when={state().publicationIssue}
              fallback={
                <Show
                  when={state().publication}
                  fallback={
                    <>
                      <Show when={!state().reviewCurrent && !busy()}>
                        <span role="status">
                          {t(
                            state().busy === "reviewing"
                              ? "templatesDraft.updating"
                              : "templatesDraft.reviewNeeded",
                          )}
                        </span>
                        <button
                          type="button"
                          class="btn"
                          disabled={state().busy !== null}
                          onClick={() => props.flow.retryReview()}
                        >
                          {t("templatesDraft.refreshReview")}
                        </button>
                      </Show>
                      <button
                        type="button"
                        class="btn primary"
                        disabled={busy() || !state().reviewCurrent || state().busy !== null}
                        aria-busy={busy() ? "true" : undefined}
                        onClick={() => void publish()}
                      >
                        <Show when={busy()}>
                          <span class="btn__spinner" aria-hidden="true" />
                        </Show>
                        {t(busy() ? "templatesDraft.publishing" : "templatesDraft.publish")}
                      </button>
                    </>
                  }
                >
                  {(publication) => (
                    <>
                      <Show
                        when={publication().publicationStatus === "published"}
                        fallback={
                          <a
                            class="btn primary"
                            href={publication().url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {t("templatesDraft.viewSubmission")}
                          </a>
                        }
                      >
                        <For each={[publication().url]}>
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
                        </For>
                      </Show>
                    </>
                  )}
                </Show>
              }
            >
              {(issue) => (
                <>
                  <span role="status">
                    {t(
                      issue() === "failed"
                        ? "templatesDraft.notPublished"
                        : "templatesDraft.unconfirmed",
                    )}
                  </span>
                  <button
                    type="button"
                    class="btn"
                    disabled={state().busy !== null}
                    aria-busy={state().busy === "reviewing" ? "true" : undefined}
                    onClick={() =>
                      issue() === "failed"
                        ? props.flow.retryReview()
                        : void props.flow.checkPublication()
                    }
                  >
                    <Show when={state().busy === "reviewing"}>
                      <span class="btn__spinner" aria-hidden="true" />
                    </Show>
                    {t(issue() === "failed" ? "common.retry" : "templatesDraft.checkStatus")}
                  </button>
                </>
              )}
            </Show>
          </div>
        </>
      }
    />
  );
}

export function TemplateCreatorReviewView(props: { flow: TemplateCreator; view: CreatorView }) {
  return (
    <Show
      when={props.view.read().review}
      fallback={
        <Show when={props.view.read().error}>
          <InlineAlert tone="danger" role="alert">
            {props.view.read().error}
            <button type="button" class="btn" onClick={() => props.flow.retryReview()}>
              {t("templatesDraft.retryReview")}
            </button>
          </InlineAlert>
        </Show>
      }
    >
      <TemplateCreatorCard flow={props.flow} view={props.view} />
    </Show>
  );
}
