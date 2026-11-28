import { Show } from "solid-js";
import { useOptionalApplication } from "../../../lib/reactive/context.ts";
import type {
  BindComposerActionMenu,
  ControlUiComposerDraft,
} from "../../../plugins/control-ui-actions.ts";
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
  /** Composer kind only: false when no toolbar exists, so icon actions render as text buttons. */
  toolbar?: boolean;
  bindActionMenu?: BindComposerActionMenu;
}) {
  const application = useOptionalApplication();
  const handle: ControlUiComposerDraft = {
    get draft() {
      return props.composer.draft;
    },
    getDraft: () => props.composer.getDraft?.() ?? props.composer.draft,
    onDraftChange: (next) => props.composer.onDraftChange(next),
    tasks: () => getChatComposerState(props.composer.paneId).tasks(),
    loadTasks: () => getChatComposerState(props.composer.paneId).loadTasks(),
  };
  return (
    <Show when={application}>
      <openclaw-plugin-contributions
        prop:kind={props.kind}
        prop:sessionKey={props.composer.sessionKey}
        prop:agentId={props.composer.currentAgentId}
        prop:presented={props.presented}
        prop:composer={handle}
        prop:bindActionMenu={props.bindActionMenu}
        prop:composerToolbar={props.toolbar ?? true}
      />
    </Show>
  );
}
