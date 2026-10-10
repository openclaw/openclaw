import "./config-form.bridge.tsx";
import { html } from "lit";
import type { LegacyConfigMap, LegacyNodeRenderer } from "./config-form.compat.tsx";
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
