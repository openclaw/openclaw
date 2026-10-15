import type { JSX } from "@solidjs/web";
import { createMemo, Loading, Show } from "solid-js";
import { LitContent } from "../lit/solid-content.tsx";

export function PluginThemeArtwork(props: { url: string; class?: string; fallback?: JSX.Element }) {
  const source = createMemo(async () => {
    const url = props.url;
    try {
      const { fetchPluginThemeArtworkBlobUrl } = await import("../pages/plugins/icon-loader.ts");
      return await fetchPluginThemeArtworkBlobUrl({ url });
    } catch {
      return null;
    }
  });
  return (
    <Loading on={props.url} fallback={props.fallback}>
      <Show when={source()} fallback={props.fallback}>
        {(src) => <img class={props.class} alt="" src={src()} />}
      </Show>
    </Loading>
  );
}

export function LegacyPluginThemeArtwork(props: {
  url: string;
  class?: string;
  fallback?: unknown;
}) {
  return (
    <PluginThemeArtwork
      url={props.url}
      class={props.class}
      fallback={<LitContent value={props.fallback} />}
    />
  );
}
