import type { JSX } from "@solidjs/web";
import { omit, Show } from "solid-js";
import { iconData } from "../../../components/icon-data.ts";
import { Icon, type IconName } from "../../../components/solid/icon.tsx";
import type { PluginToolIcons } from "../chat-tool-icon-controller.ts";

export function syncToolDisclosureOverflow(event: Event, content: HTMLElement | undefined): void {
  const disclosure = event.currentTarget;
  if (!(disclosure instanceof HTMLElement)) {
    return;
  }
  disclosure.classList.toggle(
    "chat-tool-disclosure--overflowing",
    Boolean(content && content.scrollWidth > content.clientWidth),
  );
}

export function ToolIcon(props: {
  name: string;
  tool?: { toolName: string; pluginToolIcons?: PluginToolIcons };
}) {
  const activityIcon = () => props.tool?.pluginToolIcons?.get(props.tool.toolName);
  const fallbackIcon = () => {
    // SAFETY: Own icon-data keys are the IconName union; unknown names use its puzzle entry.
    return (Object.hasOwn(iconData, props.name) ? props.name : "puzzle") as IconName;
  };
  return (
    <Show when={activityIcon()} fallback={<Icon name={fallbackIcon()} />}>
      {(icon) => (
        <span
          class="chat-tool-activity-icon"
          aria-hidden="true"
          style={{ "mask-image": `url("${icon().url}")` }}
        >
          <img hidden src={icon().url} alt="" onError={() => icon().onError()} />
        </span>
      )}
    </Show>
  );
}

export function ChatToolIcon(
  props: {
    name: string;
    tool?: { toolName: string; pluginToolIcons?: PluginToolIcons };
  } & JSX.HTMLAttributes<HTMLElement>,
) {
  const attributes = omit(props, "name", "tool", "children");
  return (
    <openclaw-chat-tool-icon {...attributes}>
      <ToolIcon name={props.name} tool={props.tool} />
    </openclaw-chat-tool-icon>
  );
}
