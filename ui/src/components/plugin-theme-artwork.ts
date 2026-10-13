import { html, nothing, type TemplateResult } from "lit";
import { until } from "lit/directives/until.js";

export function renderPluginThemeArtwork(
  url: string,
  className: string,
  fallback: TemplateResult | typeof nothing = nothing,
) {
  return until(
    import("../pages/plugins/icon-loader.ts")
      .then(({ fetchPluginThemeArtworkBlobUrl }) => fetchPluginThemeArtworkBlobUrl({ url }))
      .then((src) => (src ? html`<img class=${className} alt="" src=${src} />` : fallback))
      .catch(() => fallback),
    fallback,
  );
}
