import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { createMemo, For, onSettled, Show } from "solid-js";
import { isTemplatesDraftsReadParams } from "../../../../packages/gateway-protocol/src/compiled/protocol.generated/validators-workspaces.js";
import type { ApplicationContext } from "../../app/context.ts";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { registerTemplateCreatorEnglish } from "../../i18n/locales/en-template-creator.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { templateCreatorFlow } from "./creator-flow.ts";
import type { TemplateReviewTarget } from "./creator-publication.ts";
import { TemplateCreatorReviewView } from "./creator-review-view.tsx";
import { templateDraftUnavailableReason } from "./draft-navigation.ts";

registerEnglishCatalog(registerTemplateCreatorEnglish);

/** The durable descriptor selects a private resource, never supplies bytes or permission. */
export function TemplateCreatorInlineReview(props: {
  context: ApplicationContext;
  payload: unknown;
  sessionKey: string;
  agentId?: string;
}) {
  const target = createMemo(() => {
    const payload = asOptionalRecord(props.payload);
    if (
      !payload ||
      payload.sessionKey !== props.sessionKey ||
      (props.agentId && payload.agentId !== props.agentId) ||
      !isTemplatesDraftsReadParams({
        agentId: payload.agentId,
        draftId: payload.draftId,
      })
    ) {
      return null;
    }
    // SAFETY: the target fields passed the canonical wire validator above.
    return payload as TemplateReviewTarget;
  });
  const gateway = createMemo(() => projectOwner(props.context.gateway, (owner) => owner.snapshot));
  const config = createMemo(() =>
    projectOwner(props.context.runtimeConfig, (owner) => owner.state),
  );
  const unavailable = () => {
    gateway().read();
    config().read();
    return templateDraftUnavailableReason(props.context);
  };
  return (
    <Show
      when={target()}
      keyed
      fallback={<InlineAlert tone="danger">{t("templatesDraft.invalidTarget")}</InlineAlert>}
    >
      {(resource) => (
        <Show
          when={!unavailable()}
          fallback={
            <InlineAlert tone="warning">
              {t(
                unavailable() === "disabled"
                  ? "templatesDraft.reviewDisabled"
                  : "templatesDraft.reviewUnavailable",
              )}
            </InlineAlert>
          }
        >
          <For each={[gateway().read().client]}>
            {() => <HydratedTemplateReview context={props.context} target={resource} />}
          </For>
        </Show>
      )}
    </Show>
  );
}

function HydratedTemplateReview(props: {
  context: ApplicationContext;
  target: TemplateReviewTarget;
}) {
  const flow = createMemo(() => templateCreatorFlow(props.context, props.target));
  const view = createMemo(() => projectOwner(flow(), (owner) => owner));
  onSettled(() => {
    const initialFlow = flow();
    initialFlow.hydrate(props.target.agentId, props.target.draftId, props.target.sessionKey);
    return () => initialFlow.retirePresentation();
  });
  return <TemplateCreatorReviewView flow={flow()} view={view()} />;
}
