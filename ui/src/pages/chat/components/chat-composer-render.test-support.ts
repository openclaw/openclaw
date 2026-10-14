import { solidTemplate } from "./chat-composer-controls.ts";
import type { ChatComposerProps } from "./chat-composer-types.ts";
import { ChatComposer } from "./chat-composer.tsx";

export function renderChatComposer(props: ChatComposerProps) {
  return solidTemplate(ChatComposer, { ...props, renderRevision: {} });
}
