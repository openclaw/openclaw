import { Show } from "solid-js";
import { fnv1aUtf16 } from "../../../../../src/shared/fnv1a.js";
import { Icon } from "../../../components/solid/icon.tsx";
import "../../../styles/session-panel-rail.css";
import "./chat-subagents-working.css";
import "./chat-subagents-panel-desktop.css";

export function SubagentDesktopAvatar(props: { sessionKey: string; working?: boolean }) {
  return (
    <span
      class="subagents-desktop__avatar"
      style={{ "--subagent-hue": fnv1aUtf16(props.sessionKey) % 360 }}
      aria-hidden="true"
    >
      <Icon name="bot" />
      <Show when={props.working}>
        <span class="subagents-desktop__spinner" />
      </Show>
    </span>
  );
}
