import "./config-form.bridge.tsx";
import { html, type nothing, type TemplateResult } from "lit";
import type { ConfigNodeRenderParams } from "./config-form.node.shared.ts";

export type LegacyNodeRenderer = (
  params: ConfigNodeRenderParams,
) => TemplateResult | typeof nothing;

export function renderNode(params: ConfigNodeRenderParams) {
  return html`<openclaw-config-node
    style="display:contents"
    .params=${params}
  ></openclaw-config-node>`;
}
