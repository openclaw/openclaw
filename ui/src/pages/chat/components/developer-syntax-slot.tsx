import { createMemo, createSignal, lazy, Show } from "solid-js";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import type { ComposerDeveloperSyntax } from "../composer-developer-syntax.ts";
import type { ChatComposerState } from "./chat-composer-types.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";

registerChatComposerEnglish();

const DeveloperSyntaxSettings = lazy(() => import("./developer-syntax-panel.tsx"), {
  export: "DeveloperSyntaxSettings",
});
const DeveloperSyntaxReview = lazy(() => import("./developer-syntax-panel.tsx"), {
  export: "DeveloperSyntaxReview",
});

/** Keep the disclosure usable without loading optional grammar, editor, or panel code. */
export function DeveloperSyntaxSlot(props: {
  state: ChatComposerState;
  requested: boolean;
  readOwner: () => ComposerDeveloperSyntax | null;
}) {
  const [settingsRequested, setSettingsRequested] = createSignal(false);
  const ready = createMemo(() => (props.requested ? props.state.loadDeveloperSyntax() : undefined));
  const owner = () => {
    ready();
    return props.readOwner();
  };
  return (
    <section class="developer-syntax" dir="auto" aria-label={t("chat.composer.dictationSyntax")}>
      <details
        onToggle={(event) => {
          if (event.currentTarget.open) {
            // Native details hides the retained form without discarding unfinished imports.
            setSettingsRequested(true);
            props.state.developerSyntaxHost?.request();
          }
        }}
      >
        <summary>{t("chat.composer.dictationSyntax")}</summary>
        <Show when={settingsRequested()}>
          <ChatLazyBoundary>
            <DeveloperSyntaxSettings readOwner={owner} />
          </ChatLazyBoundary>
        </Show>
      </details>
      <Show when={props.requested}>
        <ChatLazyBoundary fallback={<p role="status">{t("common.loading")}</p>}>
          <Show when={ready()}>
            <DeveloperSyntaxReview readOwner={owner} />
          </Show>
        </ChatLazyBoundary>
      </Show>
    </section>
  );
}
