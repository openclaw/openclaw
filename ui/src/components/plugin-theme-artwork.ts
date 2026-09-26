import { html, nothing } from "lit";
import { until } from "lit/directives/until.js";

export function renderPluginThemeArtwork(url: string, className: string) {
  return until(
    import("../pages/plugins/icon-loader.ts")
      .then(({ fetchPluginThemeArtworkBlobUrl }) => fetchPluginThemeArtworkBlobUrl({ url }))
      .then((src) => (src ? html`<img class=${className} alt="" src=${src} />` : nothing))
      .catch(() => nothing),
    nothing,
  );
}
