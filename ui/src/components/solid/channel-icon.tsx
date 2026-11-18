import { createMemo, createSignal, onSettled, Show } from "solid-js";
import { pluginFallbackGradient, pluginMonogram } from "../../pages/plugins/presentation.ts";
import "../../styles/channels.css";

export function ChannelIcon(props: {
  channelId: string;
  label: string;
  variant: "tile" | "picker";
  pluginIconUrl?: string;
}) {
  const source = createMemo(() => props.pluginIconUrl);
  // A failed image retries only when its source changes.
  const [art, setArt] = createSignal(source);
  let active = true;
  onSettled(() => () => {
    active = false;
  });
  const appearance = createMemo(() => {
    const [from, to] = art() ? ["", ""] : pluginFallbackGradient(props.channelId);
    return {
      class: ["channels-tile", !art() && "channels-tile--fallback"],
      style: `${props.variant === "picker" ? "--channels-art-size:24px;" : ""}${art() ? "" : `--channels-art-a:${from};--channels-art-b:${to}`}`,
    };
  });
  return (
    <span class={appearance().class} style={appearance().style} aria-hidden="true">
      <Show when={art()} keyed fallback={<span>{pluginMonogram(props.label)}</span>}>
        {(url) => (
          <img
            src={url}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => {
              // An old image event must not replace a newer source or a removed view.
              if (active && props.pluginIconUrl === url) {
                setArt(undefined);
              }
            }}
          />
        )}
      </Show>
    </span>
  );
}
