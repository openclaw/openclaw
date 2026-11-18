import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { fnv1aUtf16 } from "../../../../../src/shared/fnv1a.js";
import { Icon } from "../../../components/solid/icon.tsx";
import "./chat-subagent-badge.css";

export function SubagentAvatarBadge(props: {
  sessionKey: string;
  class?: string;
  children?: JSX.Element;
}) {
  return (
    <span
      class={["chat-subagent-avatar", props.class]}
      style={{ "--subagent-avatar-hue": fnv1aUtf16(props.sessionKey) % 360 }}
      aria-hidden="true"
    >
      <Icon name="bot" />
      {props.children}
    </span>
  );
}

export function SubagentName(props: { name: string; sessionKey?: string }) {
  return (
    <span class="chat-subagent-name">
      <Show when={props.sessionKey}>{(key) => <SubagentAvatarBadge sessionKey={key()} />}</Show>
      <span class="chat-subagent-name__text">{props.name}</span>
    </span>
  );
}
