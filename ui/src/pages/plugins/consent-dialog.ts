import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../../components/icons.ts";
import { imageWithFallback, type ImageLoadingState } from "../../components/image-with-fallback.ts";
import { pluginFallbackGradient, pluginMonogram } from "./presentation.ts";

// The unported command palette consumes this Lit fragment; page callers use PluginArtTile.
export function renderArtTile(
  slug: string,
  name: string,
  options: {
    iconUrl?: string;
    onIconError?: () => void;
    authorIconUrl?: string;
    loading?: boolean;
    className?: string;
    whiteBackground?: boolean;
  } = {},
): TemplateResult {
  const {
    iconUrl,
    onIconError,
    authorIconUrl,
    loading = false,
    className = "plugins-tile",
    whiteBackground = false,
  } = options;
  // Fetch admission already limits requests to rendered tiles. Eager loading
  // lets the hidden image finish before replacing its skeleton.
  const renderTile = (url: string | null, onError: () => void, image: ImageLoadingState) => {
    const pending = url ? image.loading : loading;
    if (url || pending) {
      return html`<span
        class=${`${className}${whiteBackground ? " plugins-tile--white" : ""}${pending ? " skeleton" : ""}`}
        data-plugin-icon-id=${slug}
        aria-hidden="true"
      >
        ${
          url
            ? html`<img
                class="plugins-icon"
                src=${url}
                alt=""
                loading="eager"
                decoding="async"
                ?hidden=${pending}
                @load=${image.onLoad}
                @error=${() => {
                  onError();
                  onIconError?.();
                }}
              />`
            : nothing
        }
      </span>`;
    }
    const [from, to] = pluginFallbackGradient(slug);
    const monogram = pluginMonogram(name);
    return html`<span
      class=${`${className} ${className}--fallback`}
      data-plugin-icon-id=${slug}
      style=${`--plugins-art-a:${from};--plugins-art-b:${to}`}
      aria-hidden="true"
    >
      ${monogram ? html`<span>${monogram}</span>` : icons.plug}
    </span>`;
  };
  return html`${imageWithFallback(iconUrl, (url, onError, image) =>
    url ? renderTile(url, onError, image) : html`${imageWithFallback(authorIconUrl, renderTile)}`,
  )}`;
}
