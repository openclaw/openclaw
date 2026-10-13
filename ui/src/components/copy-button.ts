// Control UI chat module implements copy as markdown behavior.
import { html, type TemplateResult } from "lit";
import { solidContent } from "../lit/solid-content.tsx";
import { copyMarkdownLabel } from "./copy-button-state.ts";
import { CopyButton } from "./solid/copy-button.tsx";

export { copyMarkdownLabel, handleCopyButton } from "./copy-button-state.ts";

export function renderCopyButton(
  text: string,
  idleLabel = copyMarkdownLabel(),
  bare = false,
): TemplateResult {
  return html`${solidContent(CopyButton, { text, idleLabel, bare })}`;
}

export function renderCopyAsMarkdownButton(markdown: string): TemplateResult {
  return renderCopyButton(markdown, copyMarkdownLabel(), true);
}
