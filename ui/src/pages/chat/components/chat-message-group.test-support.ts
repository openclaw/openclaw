import { createComponent, merge } from "solid-js";
import type { MessageGroup as MessageGroupData } from "../../../lib/chat/chat-types.ts";
import { LitContent, solidContent } from "../../../lit/solid-content.tsx";
import type { RenderMessageGroupOptions } from "./chat-message-group-options.ts";
import { ActivityGroup, MessageGroup } from "./chat-message-group-view.tsx";
export * from "./chat-message-group-view.tsx";

function nativeProps<P extends { options: RenderMessageGroupOptions }>(props: P) {
  const frameContent = [
    createComponent(LitContent, {
      get value() {
        return props.options.frameContent;
      },
    }),
  ];
  return merge(() => props, {
    get options() {
      const options = props.options;
      return {
        ...options,
        frameContent: options.frameContent === undefined ? undefined : frameContent,
      };
    },
  });
}
function ActivityGroupContent(props: {
  groups: readonly MessageGroupData[];
  options: RenderMessageGroupOptions;
  presentation: "standalone" | "continuation";
}) {
  return createComponent(ActivityGroup, nativeProps(props));
}
export function renderActivityGroup(
  groups: readonly MessageGroupData[],
  options: RenderMessageGroupOptions,
  presentation: "standalone" | "continuation" = "standalone",
) {
  return solidContent(ActivityGroupContent, { groups, options, presentation });
}
function GroupContent(props: { group: MessageGroupData; options: RenderMessageGroupOptions }) {
  return createComponent(MessageGroup, nativeProps(props));
}
export function renderMessageGroup(group: MessageGroupData, options: RenderMessageGroupOptions) {
  return solidContent(GroupContent, { group, options });
}
