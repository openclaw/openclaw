import { createMemo, lazy, Loading, Show } from "solid-js";
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
      {(flow) => (
        <Loading>
          <ActiveTemplateCreatorReview flow={flow} sessionKey={props.sessionKey} />
        </Loading>
      )}
    </Show>
  );
}
