import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { sessionIconMask } from "../../../components/solid/icon.tsx";
import type { SlashCommandDef } from "../../../lib/chat/commands.ts";
import type { SlashMenuHost } from "./chat-composer-slash-menu-state.ts";

export function SlashCommandTrail(props: { command: SlashCommandDef; host: SlashMenuHost }) {
  return (
    <Show
      when={
        (props.command.key !== "goal" || !props.host.activateComposerMode) &&
        props.host.resolveArgOptions(props.command).length > 0
      }
    >
      <span class="slash-menu-trail" aria-hidden="true">
        <i
          class="session-css-icon slash-menu-chevron"
          style={{ "mask-image": sessionIconMask("chevronRight", 1.75) }}
        />
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
