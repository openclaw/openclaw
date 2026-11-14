import { For, Show, createSignal, onSettled } from "solid-js";
import type { PanelHostedTab } from "../../../components/panel-hosted-tabs.ts";
import { Icon, type IconName } from "../../../components/solid/icon.tsx";
import { createLinkFaviconReader, type LinkFaviconFetcher } from "../link-favicon-cache.ts";

type PanelIconProps = { icon: IconName; iconSvg?: string; class?: string; size?: number };

function SvgPanelIcon(props: PanelIconProps & { source: string }) {
  const [failed, setFailed] = createSignal(false);
  return (
    <Show when={!failed()} fallback={<Icon name={props.icon} class={props.class} />}>
      <i
        class={["session-css-icon", props.class]}
        aria-hidden="true"
        style={{
          width: `${props.size ?? 15}px`,
          height: `${props.size ?? 15}px`,
          "mask-image": `url("${props.source}")`,
        }}
      >
        {/* Image context never inserts plugin markup into the document. Its error
            event also supplies a fallback for malformed XML or unrenderable SVG. */}
        <img src={props.source} alt="" hidden onError={() => setFailed(true)} />
      </i>
    </Show>
  );
}

/** Both panel launchers and tabs share currentColor artwork and the same fallback. */
export function PanelIcon(props: PanelIconProps) {
  return (
    <For
      each={props.iconSvg ? [props.iconSvg] : []}
      fallback={<Icon name={props.icon} class={props.class} />}
    >
      {(source) => <SvgPanelIcon {...props} source={source} />}
    </For>
  );
}

export function HostedPanelIcon(props: {
  tab: PanelHostedTab;
  hostedRevision: () => number;
  refreshHostedTabs: () => void;
  fetchFavicon?: LinkFaviconFetcher;
}) {
  const favicons = createLinkFaviconReader(() => props.refreshHostedTabs());
  onSettled(() => () => favicons.dispose());
  const favicon = () => {
    props.hostedRevision();
    if (props.tab.favicon) {
      return props.tab.favicon;
    }
    const hostname = props.tab.url ? URL.parse(props.tab.url)?.hostname : "";
    return hostname && props.fetchFavicon ? favicons.read(hostname, props.fetchFavicon) : null;
  };
  return (
    <Show when={favicon()} fallback={props.tab.icon}>
      {(src) => (
        <img
          class="tabstrip-tab__favicon"
          src={src()}
          width="16"
          height="16"
          decoding="async"
          alt=""
        />
      )}
    </Show>
  );
}
