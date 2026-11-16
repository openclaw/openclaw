import { createMemo, lazy, Show, type Element } from "solid-js";
import { useOptionalApplication } from "../../lib/reactive/context.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import type { ChatProps } from "./chat-view-frame.ts";
import { ChatLazyBoundary } from "./components/chat-lazy-boundary.tsx";

const SetupCreationComposer = lazy(() => import("../new-session/creation-composer-render.tsx"), {
  export: "CreationComposer",
});

/** Retain setup input custody even when the live session is docked off-route. */
export function TemplateSetupComposer(props: {
  chat: Pick<ChatProps, "sessionKey" | "ownsComposer" | "mobileComposer" | "onOpenImage">;
  children: Element;
}) {
  const application = useOptionalApplication();
  const creations =
    application &&
    projectSource(application.chatSubmissions, {
      read: (owner) => owner,
      subscribe: (owner, notify) => owner.subscribeCreate(notify),
      equality: "revision",
    });
  const composer = createMemo(() =>
    creations?.read().readSessionSetupComposer(props.chat.sessionKey),
  );
  return (
    <Show when={composer()} keyed fallback={props.children}>
      {(owner) => (
        <Show when={props.chat.ownsComposer !== false}>
          <ChatLazyBoundary>
            <SetupCreationComposer
              composer={owner}
              mobileComposer={props.chat.mobileComposer}
              onOpenImage={(item) => props.chat.onOpenImage?.(item)}
            />
          </ChatLazyBoundary>
        </Show>
      )}
    </Show>
  );
}
