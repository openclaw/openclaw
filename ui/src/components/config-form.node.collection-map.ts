import "./config-form.bridge.tsx";
import { html, nothing } from "lit";
import type { LegacyConfigMap } from "./config-form.compat.tsx";
import type { LegacyNodeRenderer } from "./config-form.node.shared.ts";
import { resolveConfigMapSearch } from "./config-form.search.ts";
export function renderMapField(
  params: Parameters<typeof LegacyConfigMap>[0]["params"],
  renderNode?: LegacyNodeRenderer,
) {
  if (!resolveConfigMapSearch(params).visible) {
    return nothing;
  }
  return html`<openclaw-config-map
    style="display:contents"
    .params=${params}
    .renderNode=${renderNode}
  ></openclaw-config-map>`;
}
