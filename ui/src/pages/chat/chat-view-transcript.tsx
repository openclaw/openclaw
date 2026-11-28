import { Show } from "solid-js";
import { t } from "../../lib/reactive/i18n.ts";
import { loadChatPendingInputs } from "./chat-pending-inputs.ts";
import type { ChatProps, ChatViewFrame } from "./chat-view-frame.ts";
import { MessageImages } from "./components/chat-message-deferred.tsx";
import { ChatThread } from "./components/chat-thread-view.tsx";

export type ChatTranscriptInput = {
  props: ChatProps;
  frame: ChatViewFrame;
  bindTranscriptViewport: (element: HTMLDivElement) => () => void;
};

// Must match the fixed height of .chat-pending-inputs--history.
const SAVED_INPUT_HISTORY_HEIGHT_PX = 44;

export function ChatTranscript(input: ChatTranscriptInput) {
  const savedInputNavigation = <ChatSavedInputNavigation {...input} />;
  const hasSavedInputNavigation = () =>
    input.frame.pendingInputs &&
    (input.frame.pendingInputs.page.nextBefore !== undefined ||
      input.frame.pendingInputs.before !== undefined);
  return (
    <ChatThread
      props={input.frame.threadProps}
      transcript={input.props.transcript}
      bindViewport={input.bindTranscriptViewport}
      historySupplement={
        hasSavedInputNavigation()
          ? {
              content: savedInputNavigation,
              height: SAVED_INPUT_HISTORY_HEIGHT_PX,
            }
          : undefined
      }
    >
      <Show when={input.props.catalogPreviewImage} keyed>
        {(image) => (
          <figure class="chat-thread-inner" aria-label={image.name}>
            <MessageImages
              images={[
                {
                  url: `data:image/png;base64,${image.data}`,
                  fileName: image.name,
                  mimeType: image.mimeType,
                },
              ]}
              options={{
                onRequestOpenImage: input.frame.threadProps.onRequestOpenImage,
                onOpenImage: input.frame.threadProps.onOpenImage,
              }}
            />
          </figure>
        )}
      </Show>
    </ChatThread>
  );
}

function ChatSavedInputNavigation(input: ChatTranscriptInput) {
  const pendingInputs = () => input.frame.pendingInputs;
  const pendingButton = (page: "earlier" | "latest") => (
    <button
      class="btn btn--sm"
      type="button"
      disabled={pendingInputs()?.loading}
      onClick={() => {
        if (input.props.historyState) {
          void loadChatPendingInputs(
            input.props.historyState,
            page === "earlier" ? pendingInputs()?.page.nextBefore : undefined,
          );
        }
      }}
    >
      {t(`chat.pendingInputs.${page}`)}
    </button>
  );
  return (
    <div class="chat-pending-inputs chat-pending-inputs--history">
      <Show when={pendingInputs()?.page.nextBefore !== undefined}>{pendingButton("earlier")}</Show>
      <Show when={pendingInputs()?.before !== undefined}>{pendingButton("latest")}</Show>
    </div>
  );
}
