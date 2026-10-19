import { createMemo, createSignal, onCleanup, Show } from "solid-js";
import { pluginFallbackGradient, pluginMonogram } from "../../pages/plugins/presentation.ts";
import "../../styles/channels.css";

export function ChannelIcon(props: {
  channelId: string;
  label: string;
  variant: "tile" | "cover" | "picker";
  pluginIconUrl?: string;
}) {
  const source = createMemo(() => props.pluginIconUrl);
  // A failed image retries only when its source changes.
  const [art, setArt] = createSignal(source);
  let active = true;
  onCleanup(() => {
    active = false;
  });
  const appearance = createMemo(() => {
    const variant = props.variant === "picker" ? "tile" : props.variant;
    const [from, to] = art() ? ["", ""] : pluginFallbackGradient(props.channelId);
    const coverClass = props.variant === "cover" && props.pluginIconUrl && "channels-cover--icon";
    return {
      class: [`channels-${variant}`, coverClass, !art() && `channels-${variant}--fallback`],
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
