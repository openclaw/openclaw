import { lazy, Show } from "solid-js";
import type { ChatComposerState } from "./chat-composer-types.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";

// Loaded with the first plugin composer task; idle chats never fetch it.
const ComposerTaskCardView = lazy(() => import("./chat-composer-task-card.tsx"), {
  export: "ComposerTaskCardView",
});

/** The pane's plugin task card, once a plugin composer action has loaded the task owner. */
export function ComposerTaskSlot(props: {
  state: ChatComposerState;
  draft: string;
  canCompose: boolean;
  keyHints: boolean;
}) {
  return (
    <Show when={props.state.tasks()}>
      {(tasks) => (
        <Show when={tasks().card || tasks().accepted}>
          <ChatLazyBoundary>
            <ComposerTaskCardView
              tasks={tasks()}
              draft={props.draft}
              canCompose={props.canCompose}
              keyHints={props.keyHints}
              textarea={() => props.state.composerTextarea}
            />
          </ChatLazyBoundary>
        </Show>
      )}
    </Show>
  );
}
