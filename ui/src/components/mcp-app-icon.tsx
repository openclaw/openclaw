import { lazy, Loading, Show } from "solid-js";
import { isQuestionThumbnail } from "../../../packages/gateway-protocol/src/question-media.js";
import type { McpAppIcon as AppIcon } from "../../../src/shared/mcp-app-extensions.js";
import { Icon } from "./solid/icon.tsx";

const PluginIcon = lazy(() => import("./mcp-app-plugin-icon.tsx"));

type IconProps = { icons: readonly AppIcon[]; class?: string; pluginId?: string };

function AdvertisedIcon(props: IconProps) {
  const icon = () =>
    props.icons.find(
      (candidate) =>
        (!candidate.theme || candidate.theme === document.documentElement.dataset.themeMode) &&
        isQuestionThumbnail(candidate.src),
    );
  return (
    <Show when={icon()} fallback={<Icon name="puzzle" class={props.class} />}>
      {(image) => (
        <img
          class={props.class ?? "mcp-app-icon"}
          src={image().src}
          alt=""
          referrerpolicy="no-referrer"
        />
      )}
    </Show>
  );
}

export function McpAppIcon(props: IconProps) {
  return (
    <Show when={props.pluginId} fallback={<AdvertisedIcon {...props} />}>
      {(id) => (
        <Loading fallback={<AdvertisedIcon {...props} />}>
          <PluginIcon pluginId={id()} icons={props.icons} class={props.class} />
        </Loading>
      )}
    </Show>
  );
}
