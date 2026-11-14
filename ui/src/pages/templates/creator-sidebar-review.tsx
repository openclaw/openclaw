import { createMemo, Errored, lazy, Loading, Show } from "solid-js";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import type { TemplateCreator } from "./creator-publication.ts";

const CreatorReviewView = lazy(() => import("./creator-review-view.tsx"), {
  export: "TemplateCreatorReviewView",
});

export function ActiveTemplateCreatorReview(props: { flow: TemplateCreator; sessionKey?: string }) {
  const view = createMemo(() => projectOwner(props.flow, (owner) => owner));
  const visible = () => {
    const state = view().read();
    return (
      !state.inlineReview &&
      (!props.sessionKey || state.sessionKey === props.sessionKey) &&
      Boolean(state.review || (state.hasActiveDraft && state.error))
    );
  };
  return (
    <Show when={visible()}>
      <div class="chat-template-review">
        <Errored
          fallback={(error, retry) => (
            <InlineAlert tone="danger" role="alert">
              {formatUiError(error())}
              <button class="btn btn--sm" onClick={retry}>
                {t("common.retry")}
              </button>
            </InlineAlert>
          )}
        >
          <Loading fallback={<p role="status">{t("common.loading")}</p>}>
            <CreatorReviewView flow={props.flow} view={view()} />
          </Loading>
        </Errored>
      </div>
    </Show>
  );
}
