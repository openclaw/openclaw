import { onCleanup } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import type { PresentationValue } from "../../lib/presentation.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { ElementProperties } from "../../types/solid-elements.d.ts";
import { usePanePresentation } from "./chat-pane-presentation.ts";
import type { ChatDetails } from "./components/chat-details.tsx";

export type PaneDetailsProps = {
  chat: ChatDetails["props"];
  elements: ChatDetails["elements"];
  mobile: boolean;
  conversationVisible?: boolean;
  externalTrigger?: boolean;
  presentation: PresentationValue;
  setRef: (details: ChatDetails | undefined) => void;
};

export function PaneDetails(props: PaneDetailsProps) {
  const presented = usePanePresentation(() => props.presentation);
  onCleanup(() => props.setRef(undefined));
  return (
    <openclaw-chat-details
      ref={(element) => props.setRef(element)}
      prop:props={props.chat}
      prop:elements={props.elements}
      prop:mobile={props.mobile}
      prop:conversationVisible={props.conversationVisible ?? true}
      prop:externalTrigger={props.externalTrigger ?? false}
      prop:presented={presented()}
    />
  );
}

type PresenceProps = Pick<
  HTMLElementTagNameMap["openclaw-viewer-facepile"],
  "staticUsers" | "personActivity"
>;

export function PaneSubagentStop(props: { onAbort: () => void }) {
  return (
    <button
      class="chat-subagent-detail__stop"
      type="button"
      aria-label={t("chat.runControls.stopGenerating")}
      onClick={() => props.onAbort()}
    >
      <Icon name="stop" />
      <span>{t("chat.runControls.stop")}</span>
    </button>
  );
}
export function PaneHeaderPresence(props: PresenceProps) {
  return (
    <openclaw-viewer-facepile
      class="chat-pane__presence"
      prop:staticUsers={props.staticUsers}
      prop:maxVisible={4}
      prop:personActivity={props.personActivity}
      variant="session"
    />
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-chat-details": HTMLAttributes<ChatDetails> &
        ElementProperties<
          Pick<
            ChatDetails,
            | "props"
            | "elements"
            | "presented"
            | "mobile"
            | "conversationVisible"
            | "externalTrigger"
          >
        >;
    }
  }
}
