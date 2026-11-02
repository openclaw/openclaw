import type { JSX } from "@solidjs/web";
import { omit, Show } from "solid-js";
import { iconData } from "../../../components/icon-data.ts";
import { Icon, type IconName } from "../../../components/solid/icon.tsx";
import type { PluginToolIcons } from "../chat-tool-icon-controller.ts";

const TOOL_ICON_CLASSES: Partial<Record<IconName, string>> = {
  pencil: "chat-tool-icon--diagonal",
  penLine: "chat-tool-icon--diagonal",
  key: "chat-tool-icon--diagonal",
  wrench: "chat-tool-icon--diagonal",
  paperclip: "chat-tool-icon--diagonal",
};

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
    <Show
      when={activityIcon()}
      fallback={<Icon name={fallbackIcon()} class={TOOL_ICON_CLASSES[fallbackIcon()]} />}
    >
      {(icon) => (
        <Show
          when={icon().branding}
          fallback={
            <span
              class="chat-tool-activity-icon"
              aria-hidden="true"
              style={{ "mask-image": `url("${icon().url}")` }}
            >
              <img hidden src={icon().url} alt="" onError={() => icon().onError()} />
            </span>
          }
        >
          <img
            class="chat-tool-brand-icon"
            src={icon().url}
            alt=""
            aria-hidden="true"
            onError={() => icon().onError()}
          />
        </Show>
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
