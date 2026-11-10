import { createMemo, Errored, lazy, Loading, onSettled, Show } from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { templateCreatorOwner, type TemplateCreator } from "./creator-publication.ts";

const CreatorReviewView = lazy(() => import("./creator-review-view.tsx"), {
  export: "TemplateCreatorReviewView",
});

export function TemplateCreatorReview(props: { context: ApplicationContext; sessionKey?: string }) {
  const current = createMemo(() =>
    projectOwner(templateCreatorOwner(props.context), (owner) => owner.flow),
  );
  return (
    <Show when={current().read()} keyed>
      {(flow) => (
        <ActiveTemplateCreatorReview
          context={props.context}
          flow={flow}
          sessionKey={props.sessionKey}
        />
      )}
    </Show>
  );
}

function ActiveTemplateCreatorReview(props: {
  context: ApplicationContext;
  flow: TemplateCreator;
  sessionKey?: string;
}) {
  const view = createMemo(() => projectOwner(props.flow, (owner) => owner));
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
      !state.inlineReview &&
      (!props.sessionKey || state.sessionKey === props.sessionKey) &&
      Boolean(state.review || (state.hasActiveDraft && state.error))
    );
  };
  return (
    <Show when={visible()}>
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
    </Show>
  );
}
