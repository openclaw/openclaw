import { createComponent } from "solid-js";
import type { MessageGroup as MessageGroupData } from "../../../lib/chat/chat-types.ts";
import { LitContent, solidContent } from "../../../lit/solid-content.tsx";
import type { RenderMessageGroupOptions } from "./chat-message-group-options.ts";
import {
  ActivityGroup,
  MessageGroupContent as NativeMessageGroupContent,
  MessageGroup,
  type NativeMessageGroupOptions,
} from "./chat-message-group-view.tsx";
export * from "./chat-message-group-view.tsx";

function nativeOptions(read: () => RenderMessageGroupOptions): () => NativeMessageGroupOptions {
  const frameContent = [
    createComponent(LitContent, {
      get value() {
        return read().frameContent;
      },
    }),
  ];
  return () => {
    const options = read();
    return {
      ...options,
      frameContent: options.frameContent === undefined ? undefined : frameContent,
    };
  };
}
function ActivityGroupContent(props: {
  groups: readonly MessageGroupData[];
  options: RenderMessageGroupOptions;
  presentation: "standalone" | "continuation";
}) {
  const options = nativeOptions(() => props.options);
  return createComponent(ActivityGroup, {
    get groups() {
      return props.groups;
    },
    get options() {
      return options();
    },
    get presentation() {
      return props.presentation;
    },
  });
}
export function renderActivityGroup(
  groups: readonly MessageGroupData[],
  options: RenderMessageGroupOptions,
  presentation: "standalone" | "continuation" = "standalone",
) {
  return solidContent(ActivityGroupContent, { groups, options, presentation });
}
function MessageGroupContent(props: {
  group: MessageGroupData;
  options: RenderMessageGroupOptions;
}) {
  const options = nativeOptions(() => props.options);
  return createComponent(NativeMessageGroupContent, {
    get group() {
      return props.group;
    },
    get options() {
      return options();
    },
  });
}
export function renderMessageGroupContent(
  group: MessageGroupData,
  options: RenderMessageGroupOptions,
) {
  return solidContent(MessageGroupContent, { group, options });
}
function GroupContent(props: { group: MessageGroupData; options: RenderMessageGroupOptions }) {
  const options = nativeOptions(() => props.options);
  return createComponent(MessageGroup, {
    get group() {
      return props.group;
    },
    get options() {
      return options();
    },
  });
}
export function renderMessageGroup(group: MessageGroupData, options: RenderMessageGroupOptions) {
  return solidContent(GroupContent, { group, options });
}
