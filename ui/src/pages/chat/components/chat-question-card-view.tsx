import { lazy, Show } from "solid-js";
import { LoadingState } from "../../../components/solid/loading-state.tsx";
import { registerChatQuestionsEnglish } from "../../../i18n/locales/en-chat-questions.ts";
import { t, registerEnglishCatalog } from "../../../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lib/solid-bridge.ts";
import { ChatImportBoundary } from "./chat-import-boundary.tsx";
import type { QuestionPanelProps } from "./chat-question-types.ts";

registerEnglishCatalog(registerChatQuestionsEnglish);

type CardProps = { props?: QuestionPanelProps };
export type ChatQuestionCard = SolidBridgeElement<CardProps>;

// Summaries and panel props are needed during chat boot; interactive controls are not.
const QuestionPanel = lazy(() => import("./chat-question-panel.tsx"), {
  export: "ChatQuestionPanel",
});

export const ChatQuestionCard = defineSolidBridge<CardProps>(
  "openclaw-chat-question-card",
  (props, host) => {
    host.style.display = "contents";
    return (
      <Show when={props.props}>
        {(panel) => <QuestionCardContents panel={panel()} host={host} />}
      </Show>
    );
  },
  { properties: { props: { default: undefined, attribute: false } } },
);

function QuestionCardContents(props: { panel: QuestionPanelProps; host: HTMLElement }) {
  return (
    <ChatImportBoundary
      identity={[props.panel.model.requestKey]}
      connected={() => props.host.isConnected}
      fallback={() => <LoadingState />}
      subtitle={t("chat.questions.eyebrow")}
    >
      <QuestionPanel props={props.panel} />
    </ChatImportBoundary>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-chat-question-card": HTMLAttributes<ChatQuestionCard> & {
        "prop:props"?: ChatQuestionCard["props"];
      };
    }
  }
}
