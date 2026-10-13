import "./config-form.bridge.tsx";
import { html } from "lit";
import type { ConfigNodeRenderParams } from "./config-form.node.shared.ts";

export function renderNode(params: ConfigNodeRenderParams) {
  return html`<openclaw-config-node
    style="display:contents"
    .params=${params}
  ></openclaw-config-node>`;
}
