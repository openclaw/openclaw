import { Show } from "solid-js";
import { isQuestionThumbnail } from "../../../packages/gateway-protocol/src/question-media.js";
import type { McpAppIcon as AppIcon } from "../../../src/shared/mcp-app-extensions.js";
import { Icon } from "./solid/icon.tsx";

export function McpAppIcon(props: { icons: readonly AppIcon[] }) {
  const icon = () =>
    props.icons.find(
      (candidate) =>
        (!candidate.theme || candidate.theme === document.documentElement.dataset.themeMode) &&
        isQuestionThumbnail(candidate.src),
    );
  return (
    <Show when={icon()} fallback={<Icon name="puzzle" />}>
      {(image) => (
        <img class="mcp-app-icon" src={image().src} alt="" referrerpolicy="no-referrer" />
      )}
    </Show>
  );
}
