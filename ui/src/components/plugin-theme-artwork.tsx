import type { JSX } from "@solidjs/web";
import { createMemo, Loading, Show } from "solid-js";

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
    <Loading fallback={props.fallback}>
      <Show when={source()} fallback={props.fallback}>
        {(src) => <img class={props.class} alt="" src={src()} />}
      </Show>
    </Loading>
  );
}
