import { createMemo, lazy, Loading, onSettled, Show } from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { templateCreatorOwner } from "./creator-publication.ts";

const ActiveTemplateCreatorReview = lazy(() => import("./creator-sidebar-review.tsx"), {
  export: "ActiveTemplateCreatorReview",
});

export function TemplateCreatorReview(props: { context: ApplicationContext; sessionKey?: string }) {
  const current = createMemo(() =>
    projectOwner(templateCreatorOwner(props.context), (owner) => owner.flow),
  );
  return (
    <Show when={current().read()} keyed>
      {(flow) => {
        onSettled(() => {
          const context = props.context;
          const pathname = context.router.getState().location.pathname;
          return context.router.subscribe(() => {
            if (context.router.getState().location.pathname !== pathname) {
              flow.retirePresentation();
            }
          });
        });
        return (
          <Loading>
            <ActiveTemplateCreatorReview flow={flow} sessionKey={props.sessionKey} />
          </Loading>
        );
      }}
    </Show>
  );
}
