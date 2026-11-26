import { createSignal, lazy, Show } from "solid-js";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import type { ComposerDeveloperSyntax } from "../composer-developer-syntax.ts";
import type { ChatComposerState } from "./chat-composer-types.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";

registerChatComposerEnglish();

const DeveloperSyntaxContent = lazy(() => import("./developer-syntax-panel.tsx"), {
  export: "DeveloperSyntaxContent",
});

/** Keep the disclosure usable without loading optional grammar, editor, or panel code. */
export function DeveloperSyntaxSlot(props: {
  state: ChatComposerState;
  requested: boolean;
  readOwner: () => ComposerDeveloperSyntax | null;
}) {
  const [settingsRequested, setSettingsRequested] = createSignal(false);
  return (
    <section
      class="developer-syntax"
      dir="auto"
      aria-label={t("chat.composer.dictationSyntax")}
      style={{ "min-width": "0", padding: "8px 12px", "font-size": "12px", "line-height": "1.5" }}
    >
      <details
        onToggle={(event) => {
          if (event.currentTarget.open) {
            // Native details hides the retained form without discarding unfinished imports.
            setSettingsRequested(true);
            props.state.developerSyntaxHost?.request();
          }
        }}
      >
        <summary class="muted" style={{ cursor: "pointer" }}>
          {t("chat.composer.dictationSyntax")}
        </summary>
        <Show when={settingsRequested()}>
          <ChatLazyBoundary>
            <DeveloperSyntaxContent state={props.state} readOwner={props.readOwner} settings />
          </ChatLazyBoundary>
        </Show>
      </details>
      <Show when={props.requested}>
        <ChatLazyBoundary fallback={<p role="status">{t("common.loading")}</p>}>
          <DeveloperSyntaxContent state={props.state} readOwner={props.readOwner} />
        </ChatLazyBoundary>
      </Show>
    </section>
  );
}
