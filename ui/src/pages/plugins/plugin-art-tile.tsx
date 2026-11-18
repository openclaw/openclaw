import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, onSettled, Show } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { pluginFallbackGradient, pluginMonogram } from "./presentation.ts";

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
          class={[className(), `${className()}--fallback`]}
          data-plugin-icon-id={slug()}
          style={
            className() === "plugins-tile"
              ? { background: `linear-gradient(135deg, ${gradient()[0]}, ${gradient()[1]})` }
              : undefined
          }
          aria-hidden="true"
        >
          {monogram() ? <span>{monogram()}</span> : <Icon name="plug" />}
        </span>
      )}
    </>
  );
}
