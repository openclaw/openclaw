import { lazy, Show } from "solid-js";
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
  // Undefined until the form has been requested; retain it when closed.
  settingsOpen: boolean | undefined;
  readOwner: () => ComposerDeveloperSyntax | null;
}) {
  return (
    <div
      class="developer-syntax"
      dir="auto"
      style={{ display: "contents", "font-size": "12px", "line-height": "1.5" }}
    >
      <Show when={props.settingsOpen !== undefined}>
        <section
          aria-label={t("chat.composer.dictationSyntax")}
          hidden={!props.settingsOpen}
          style={{ "min-width": "0", padding: "8px 12px" }}
        >
          <ChatLazyBoundary fallback={<p role="status">{t("common.loading")}</p>}>
            <DeveloperSyntaxContent state={props.state} readOwner={props.readOwner} settings />
          </ChatLazyBoundary>
        </section>
      </Show>
      <Show when={props.requested}>
        <ChatLazyBoundary>
          <DeveloperSyntaxContent state={props.state} readOwner={props.readOwner} />
        </ChatLazyBoundary>
      </Show>
    </div>
  );
}
