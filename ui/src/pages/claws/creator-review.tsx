import { createMemo, Errored, lazy, Loading, onSettled, Show } from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { clawCreatorFlow } from "./creator-flow.ts";
import "../../styles/claw-creator.css";

const CreatorReviewView = lazy(() => import("./creator-review-view.tsx"), {
  export: "ClawCreatorReviewView",
});

export function ClawCreatorReview(props: { context: ApplicationContext }) {
  const current = createMemo(() => {
    const flow = clawCreatorFlow(props.context);
    return { flow, view: projectOwner(flow, (owner) => owner) };
  });
  const flow = () => current().flow;
  const view = () => current().view;
  onSettled(() => {
    const context = props.context;
    const owner = clawCreatorFlow(context);
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
