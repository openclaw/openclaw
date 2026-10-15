import { solidContent } from "../lit/solid-content.tsx";
import { copyMarkdownLabel } from "./copy-button-state.ts";
import { CopyButton } from "./solid/copy-button.tsx";

export { copyMarkdownLabel, handleCopyButton } from "./copy-button-state.ts";

export function renderCopyAsMarkdownButton(markdown: string) {
  return solidContent(CopyButton, { text: markdown, idleLabel: copyMarkdownLabel(), bare: true });
}
