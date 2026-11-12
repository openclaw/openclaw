import type { JSX } from "@solidjs/web";
import { createMemo, Show } from "solid-js";
import { sessionIconMask } from "../../../components/solid/icon.tsx";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { registerChatGoalsEnglish } from "../../../i18n/locales/en-chat-goals.ts";
import { registerModelControlsEnglish } from "../../../i18n/locales/en-model-controls.ts";
import { registerSessionMenuEnglish } from "../../../i18n/locales/en-session-menu.ts";
import { registerSessionOrganizationEnglish } from "../../../i18n/locales/en-session-organization.ts";
import type { SlashCommandDef } from "../../../lib/chat/commands.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import type { SlashMenuHost } from "./chat-composer-slash-menu-state.ts";

registerEnglishCatalog(registerChatComposerEnglish);
registerEnglishCatalog(registerChatGoalsEnglish);
registerEnglishCatalog(registerSessionMenuEnglish);
registerEnglishCatalog(registerSessionOrganizationEnglish);
registerEnglishCatalog(registerModelControlsEnglish);

const COMMAND_TITLE_KEYS: Readonly<Record<string, string>> = {
  new: "chat.runControls.newSession",
  fork: "sessionsView.forkSession",
  name: "sessionsView.renameSession",
  goal: "chat.goals.composerMode",
  agents: "chat.commands.categories.agents",
  tools: "chat.commands.categories.tools",
  context: "chat.sidePanel.context",
  subagents: "chat.sidePanel.subagents",
  queue: "chat.runControls.queue",
  verbose: "sessionsView.verbose",
  reasoning: "sessionsView.reasoning",
  stop: "chat.runControls.stop",
  reset: "common.reset",
  compact: "chat.composer.contextUsage.compact",
  model: "chat.commands.categories.model",
  think: "chat.modelControls.effort",
  fast: "chat.modelControls.speed",
  steer: "chat.queue.steer",
};

export function slashCommandTitle(command: SlashCommandDef): string | undefined {
  if (command.source === "skill") {
    return command.skillDisplayName;
  }
  const key = command.source !== "plugin" ? COMMAND_TITLE_KEYS[command.key] : undefined;
  return key ? t(key) : undefined;
}

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
