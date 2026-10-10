import { html } from "lit";
import type { LegacyConfigText, LegacyConfigSelect } from "./config-form.compat.tsx";
import type { ConfigNodeRenderParams } from "./config-form.node.shared.ts";

export function renderTextInput(params: Parameters<typeof LegacyConfigText>[0]["params"]) {
  return html`<openclaw-config-text
    style="display:contents"
    .params=${params}
  ></openclaw-config-text>`;
}
export function renderNumberInput(params: ConfigNodeRenderParams) {
  return html`<openclaw-config-number
    style="display:contents"
    .params=${params}
  ></openclaw-config-number>`;
}
export function renderSelect(params: Parameters<typeof LegacyConfigSelect>[0]["params"]) {
  return html`<openclaw-config-select
    style="display:contents"
    .params=${params}
  ></openclaw-config-select>`;
}
