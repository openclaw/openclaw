import { createMemo, lazy, Show } from "solid-js";
import type { HumanMention } from "../../../lib/chat/chat-types.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";

const ComposerPluginPrompt = lazy(() => import("./chat-composer-plugin-prompt.tsx"), {
  export: "ComposerPluginPrompt",
});

/** Keep plugin metadata and branding off the composer boot path until an eligible @id exists. */
export function ComposerPluginPromptSlot(props: {
  text: string;
  mentions?: readonly HumanMention[];
  disabled: boolean;
}) {
  const prefix = createMemo(() =>
    props.disabled || props.mentions?.some((mention) => mention.start === 0)
      ? undefined
      : /^@([A-Za-z0-9][A-Za-z0-9._/-]*)(?=\s)/u.exec(props.text)?.[1],
  );
  return (
    <Show when={prefix()} keyed>
      {(pluginId) => (
        <ChatLazyBoundary>
          <ComposerPluginPrompt pluginId={pluginId} text={props.text} />
        </ChatLazyBoundary>
      )}
    </Show>
  );
}
