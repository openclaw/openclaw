import { html } from "lit";
import type { ConfigNodeRenderParams } from "./config-form.node.shared.ts";
export function renderJsonTextarea(params: ConfigNodeRenderParams) {
  return html`<openclaw-config-json
    style="display:contents"
    .params=${params}
  ></openclaw-config-json>`;
}
