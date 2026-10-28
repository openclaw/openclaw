import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import type { SessionsDiffResult } from "../../../../../packages/gateway-protocol/src/index.js";
import { Icon } from "../../../components/solid/icon.tsx";

export function EnvironmentAction(props: {
  presented: boolean;
  onOpen?: () => void;
  children: () => JSX.Element;
}) {
  return (
    <Show when={props.onOpen} fallback={props.children()}>
      <button
        class="chat-environment__action"
        type="button"
        onClick={() => {
          if (props.presented) {
            props.onOpen?.();
          }
        }}
      >
        {props.children()}
        <Icon name="chevronRight" />
      </button>
    </Show>
  );
}

export function hasEnvironmentTextChanges(result?: { additions?: number; deletions?: number }) {
  return (result?.additions ?? 0) > 0 || (result?.deletions ?? 0) > 0;
}

export function EnvironmentChangeCounts(props: { result: SessionsDiffResult }) {
  return (
    <span class="chat-environment__counts">
      <Show when={props.result.additions > 0}>
        <span class="chat-environment__added">+{props.result.additions}</span>
      </Show>
      <Show when={props.result.deletions > 0}>
        <span class="chat-environment__removed">−{props.result.deletions}</span>
      </Show>
    </span>
  );
}
