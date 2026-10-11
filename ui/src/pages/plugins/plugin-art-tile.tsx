import type { JSX } from "@solidjs/web";
import { createSignal, onCleanup, Show } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { pluginFallbackGradient, pluginMonogram } from "./presentation.ts";

type ArtTileOptions = {
  iconUrl?: string;
  onIconError?: () => void;
  authorIconUrl?: string;
  loading?: boolean;
  className?: string;
  whiteBackground?: boolean;
};

export function renderArtTile(
  slug: string,
  name: string,
  options: ArtTileOptions = {},
): JSX.Element {
  return <PluginArtTile slug={slug} name={name} options={options} />;
}

export function PluginArtTile(props: {
  slug: string;
  name: string;
  options: ArtTileOptions;
}): JSX.Element {
  type ImageState = { source: string | undefined; status: "loading" | "ready" | "failed" };
  const [packageImage, setPackageImage] = createSignal<ImageState>((previous) => {
    const source = props.options.iconUrl;
    return previous && previous.source === source ? previous : { source, status: "loading" };
  });
  const [authorImage, setAuthorImage] = createSignal<ImageState>((previous) => {
    const source = props.options.authorIconUrl;
    return previous && previous.source === source ? previous : { source, status: "loading" };
  });
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  const currentImage = () =>
    packageImage().source && packageImage().status !== "failed"
      ? { state: packageImage(), update: setPackageImage, package: true }
      : { state: authorImage(), update: setAuthorImage, package: false };
  const source = () =>
    currentImage().state.status === "failed" ? undefined : currentImage().state.source;
  const pending = () =>
    source() ? currentImage().state.status === "loading" : Boolean(props.options.loading);
  const className = () => props.options.className ?? "plugins-tile";
  const settle = (url: string, status: "ready" | "failed") => {
    const image = currentImage();
    if (disposed || image.state.source !== url) {
      return;
    }
    image.update({ ...image.state, status });
    if (status === "failed" && image.package) {
      props.options.onIconError?.();
    }
  };
  // Only the displayed image is admitted; failed sources stay failed until their URL changes.
  return (
    <>
      {source() || pending() ? (
        <span
          class={[
            className(),
            { "plugins-tile--white": props.options.whiteBackground, skeleton: pending() },
          ]}
          data-plugin-icon-id={props.slug}
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
          data-plugin-icon-id={props.slug}
          style={{
            "--plugins-art-a": pluginFallbackGradient(props.slug)[0],
            "--plugins-art-b": pluginFallbackGradient(props.slug)[1],
          }}
          aria-hidden="true"
        >
          {pluginMonogram(props.name) ? (
            <span>{pluginMonogram(props.name)}</span>
          ) : (
            <Icon name="plug" />
          )}
        </span>
      )}
    </>
  );
}
