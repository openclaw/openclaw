import type { JSX } from "@solidjs/web";
import { createMemo, Show } from "solid-js";
import { sessionIconMask } from "../../../components/solid/icon.tsx";
import type { SlashCommandDef } from "../../../lib/chat/commands.ts";
import type { SlashMenuHost } from "./chat-composer-slash-menu-state.ts";

export function SlashCommandTrail(props: {
  command: SlashCommandDef;
  host: SlashMenuHost;
  current?: { value: string; label: string };
}) {
  const hasChoices = createMemo(
    () =>
      (props.command.key !== "goal" || !props.host.activateComposerMode) &&
      props.host.resolveArgOptions(props.command).length > 0,
  );
  return (
    <Show when={props.current || hasChoices()}>
      <span class="slash-menu-trail">
        <Show when={props.current}>
          <span class="slash-menu-value">{props.current?.label}</span>
        </Show>
        <Show when={hasChoices()}>
          <i
            class="session-css-icon slash-menu-chevron"
            aria-hidden="true"
            style={{ "mask-image": sessionIconMask("chevronRight", 1.75) }}
          />
        </Show>
      </span>
    </Show>
  );
}

export function renderSlashMatchedName(name: string, query: string): JSX.Element {
  const matchLength = name.toLowerCase().startsWith(query.toLowerCase()) ? query.length : 0;
  return matchLength === 0 ? (
    <>{name}</>
  ) : (
    <>
      <mark>{name.slice(0, matchLength)}</mark>
      {name.slice(matchLength)}
    </>
  );
}
