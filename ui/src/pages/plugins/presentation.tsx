import { expectDefined } from "@openclaw/normalization-core";
import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, onSettled, Show } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { takeGraphemes } from "../../lib/graphemes.ts";

export function resolvePluginCatalogIconUrl(
  plugin: { pluginId?: string; imageUrl?: string },
  urls: {
    pluginIconUrls: Readonly<Record<string, string>>;
    iconUrls: Readonly<Record<string, string>>;
  },
  failedUrls?: ReadonlySet<string>,
): string | null {
  const packageIcon = plugin.pluginId ? urls.pluginIconUrls[plugin.pluginId] : undefined;
  const catalogIcon = plugin.imageUrl ? urls.iconUrls[plugin.imageUrl] : undefined;
  return (
    [packageIcon, catalogIcon].find((url): url is string =>
      Boolean(url && !failedUrls?.has(url)),
    ) ?? null
  );
}

/**
 * Deterministic two-stop gradients for plugins without package icons so every
 * tile keeps a distinct identity instead of an empty box.
 */
const FALLBACK_GRADIENTS: ReadonlyArray<readonly [string, string]> = [
  ["#f59e0b", "#ea580c"],
  ["#38bdf8", "#1d4ed8"],
  ["#34d399", "#047857"],
  ["#a855f7", "#6b21a8"],
  ["#f472b6", "#be185d"],
  ["#22d3ee", "#0e7490"],
  ["#fbbf24", "#b45309"],
  ["#818cf8", "#4338ca"],
  ["#4ade80", "#166534"],
  ["#fb7185", "#9f1239"],
];

export function pluginFallbackGradient(id: string): readonly [string, string] {
  let hash = 0;
  for (const char of id) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  }
  return expectDefined(
    FALLBACK_GRADIENTS[hash % FALLBACK_GRADIENTS.length],
    "plugin fallback gradient palette entry",
  );
}

export function pluginMonogram(name: string): string {
  const [first, second] = name.trim().split(/\s+/u).filter(Boolean);
  if (!first) {
    return "";
  }
  const initials = second
    ? `${takeGraphemes(first, 1)}${takeGraphemes(second, 1)}`
    : takeGraphemes(first, 2);
  return initials.toLocaleUpperCase();
}

type ArtTileProps = {
  registerIcon?: (readId: () => string) => () => void;
  slug: string;
  name: string;
  iconUrl?: string;
  onIconError?: () => void;
  authorIconUrl?: string;
  loading?: boolean;
  class?: string;
  whiteBackground?: boolean;
  /** Plugin catalog rows and the plugin page show a quiet plug glyph instead of a monogram. */
  neutralFallback?: boolean;
};

export function PluginArtTile(props: ArtTileProps): JSX.Element {
  const slug = () => props.slug;
  let disposed = false;
  onSettled(() => {
    const unregister = props.registerIcon?.(slug);
    return () => {
      disposed = true;
      unregister?.();
    };
  });
  type ImageState = { source: string | undefined; status: "loading" | "ready" | "failed" };
  const [packageImage, setPackageImage] = createSignal<ImageState>((previous) => {
    const source = props.iconUrl;
    return previous && previous.source === source ? previous : { source, status: "loading" };
  });
  const [authorImage, setAuthorImage] = createSignal<ImageState>((previous) => {
    const source = props.authorIconUrl;
    return previous && previous.source === source ? previous : { source, status: "loading" };
  });
  const currentImage = () =>
    packageImage().source && packageImage().status !== "failed"
      ? { state: packageImage(), update: setPackageImage, package: true }
      : { state: authorImage(), update: setAuthorImage, package: false };
  const gradient = () => pluginFallbackGradient(slug());
  const monogram = createMemo(() => pluginMonogram(props.name));
  const source = () =>
    currentImage().state.status === "failed" ? undefined : currentImage().state.source;
  const pending = () =>
    source() ? currentImage().state.status === "loading" : Boolean(props.loading);
  // Compact prompt icons keep their CSS surface; full art tiles own their gradient.
  const className = () => props.class ?? "plugins-tile";
  const settle = (url: string, status: "ready" | "failed") => {
    const image = currentImage();
    if (disposed || image.state.source !== url) {
      return;
    }
    image.update({ ...image.state, status });
    if (status === "failed" && image.package) {
      props.onIconError?.();
    }
  };
  // Only the displayed image is admitted; failed sources stay failed until their URL changes.
  return (
    <>
      {source() || pending() ? (
        <span
          class={[
            className(),
            { "plugins-tile--white": props.whiteBackground, skeleton: pending() },
          ]}
          data-plugin-icon-id={slug()}
          aria-hidden="true"
        >
          <Show when={source()} keyed>
            {(url) => (
              <img
                class="plugins-icon"
                src={url}
                alt=""
                loading="eager"
                decoding="async"
                hidden={pending()}
                onLoad={() => settle(url, "ready")}
                onError={() => settle(url, "failed")}
              />
            )}
          </Show>
        </span>
      ) : (
        <span
          class={[
            className(),
            `${className()}--fallback`,
            { "plugins-tile--neutral": props.neutralFallback },
          ]}
          data-plugin-icon-id={slug()}
          style={
            className() === "plugins-tile" && !props.neutralFallback
              ? { background: `linear-gradient(135deg, ${gradient()[0]}, ${gradient()[1]})` }
              : undefined
          }
          aria-hidden="true"
        >
          {monogram() && !props.neutralFallback ? <span>{monogram()}</span> : <Icon name="plug" />}
        </span>
      )}
    </>
  );
}
