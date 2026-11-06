import { createMemo, Errored, lazy, Loading, onSettled, Show } from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { templateCreatorOwner, type TemplateCreator } from "./creator-publication.ts";
import "../../styles/template-creator.css";

const CreatorReviewView = lazy(() => import("./creator-review-view.tsx"), {
  export: "TemplateCreatorReviewView",
});

export function TemplateCreatorReview(props: { context: ApplicationContext }) {
  const current = createMemo(() =>
    projectOwner(templateCreatorOwner(props.context), (owner) => owner.flow),
  );
  return (
    <Show when={current().read()} keyed>
      {(flow) => <ActiveTemplateCreatorReview context={props.context} flow={flow} />}
    </Show>
  );
}

function ActiveTemplateCreatorReview(props: {
  context: ApplicationContext;
  flow: TemplateCreator;
}) {
  const current = createMemo(() => {
    const flow = props.flow;
    return { flow, view: projectOwner(flow, (owner) => owner) };
  });
  const flow = () => current().flow;
  const view = () => current().view;
  onSettled(() => {
    const context = props.context;
    const owner = props.flow;
    const pathname = context.router.getState().location.pathname;
    return context.router.subscribe(() => {
      if (context.router.getState().location.pathname !== pathname) {
        owner.retirePresentation();
      }
    });
  });
  const visible = () => {
    const state = view().read();
    return (
      (state.modalOpen && state.review) ||
      (!state.modalOpen &&
        !state.publication &&
        (state.review || (state.hasActiveDraft && state.error)))
    );
  };
  return (
    <Show when={visible()}>
      <Errored
        fallback={(error, retry) => (
          <div role="alert" class="callout danger">
            {formatUiError(error())}
            <button class="btn btn--sm" onClick={retry}>
              {t("common.retry")}
            </button>
          </div>
        )}
      >
        <Loading fallback={<p role="status">{t("common.loading")}</p>}>
          <CreatorReviewView flow={flow()} view={view()} />
        </Loading>
      </Errored>
    </Show>
  );
}
