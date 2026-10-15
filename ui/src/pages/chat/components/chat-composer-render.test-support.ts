import { solidContent } from "../../../lit/solid-content.tsx";
import type { ChatComposerProps } from "./chat-composer-types.ts";
import { ChatComposer } from "./chat-composer.tsx";

export function renderChatComposer(props: ChatComposerProps) {
  return solidContent(ChatComposer, { ...props, renderRevision: {} });
}
