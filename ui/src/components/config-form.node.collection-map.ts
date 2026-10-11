import "./config-form.bridge.tsx";
import { html } from "lit";
import type { LegacyConfigMap } from "./config-form.compat.tsx";
import type { LegacyNodeRenderer } from "./config-form.node.ts";
export function renderMapField(
  params: Parameters<typeof LegacyConfigMap>[0]["params"],
  renderNode?: LegacyNodeRenderer,
) {
  return html`<openclaw-config-map
    style="display:contents"
    .params=${params}
    .renderNode=${renderNode}
  ></openclaw-config-map>`;
}
