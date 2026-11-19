import { Show } from "solid-js";
import { useOptionalApplication } from "../../../lib/reactive/context.ts";
import type { ControlUiComposerDraft } from "../../../plugins/control-ui-actions.ts";
import { getChatComposerState } from "./chat-composer-state.ts";
import type { ChatComposerProps } from "./chat-composer-types.ts";

type ComposerPluginProps = Pick<
  ChatComposerProps,
  "paneId" | "draft" | "getDraft" | "onDraftChange" | "sessionKey" | "currentAgentId"
>;

/**
 * Plugin composer contributions for one pane: text actions and composer accessories above the
 * input, or icon actions in its toolbar.
 */
export function ChatComposerPluginContributions(props: {
  kind: "composer" | "composer-toolbar";
  composer: ComposerPluginProps;
  presented: boolean;
}) {
  const application = useOptionalApplication();
  const handle: ControlUiComposerDraft = {
    get draft() {
      return props.composer.draft;
    },
    getDraft: () => props.composer.getDraft?.() ?? props.composer.draft,
    onDraftChange: (next) => props.composer.onDraftChange(next),
    propose: (text, title, signal) =>
      getChatComposerState(props.composer.paneId).proposal.offer(text, title, signal),
  };
  return (
    <Show when={application}>
      <openclaw-plugin-contributions
        prop:kind={props.kind}
        prop:sessionKey={props.composer.sessionKey}
        prop:agentId={props.composer.currentAgentId}
        prop:presented={props.presented}
        prop:composer={handle}
      />
    </Show>
  );
}
