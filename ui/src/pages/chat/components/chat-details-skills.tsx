import { For, Show, createMemo } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { conversationSkillsUsed } from "../../../lib/chat/skills-used.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { ChatDetailsDesktopSection } from "./chat-details-desktop-section.tsx";
import type { ChatDetailsProps } from "./chat-details-types.ts";
import "../../../styles/chat/details-skills.css";

registerEnglishCatalog(registerChatSessionEnglish);
const noTools: readonly unknown[] = [];

export function ChatDetailsSkills(props: {
  details: ChatDetailsProps;
  presented: boolean;
  desktop?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const skills = createMemo(() =>
    conversationSkillsUsed(
      props.details.messages,
      props.details.toolMessages ?? noTools,
      props.details.skillLoads,
    ),
  );
  const content = () => (
    <ul class="chat-details-skills__list">
      <For each={skills()} keyed={(skill) => skill.name}>
        {(skill) => (
          <li class="chat-details-skills__item">
            <Icon name="book" />
            <span class="chat-details-skills__name">{skill().name}</span>
            <Show when={skill().loads > 1}>
              <span
                class="chat-details-skills__loads"
                aria-label={t("chat.sessionDetails.skillLoads", { count: String(skill().loads) })}
              >
                ×{skill().loads}
              </span>
            </Show>
          </li>
        )}
      </For>
    </ul>
  );
  return (
    <Show when={skills().length > 0}>
      <Show
        when={props.desktop}
        fallback={
          <details class="chat-details-skills" data-details-group="skills">
            <summary class="chat-details__caption">
              {t("chat.sessionDetails.skillsUsed")}
              <span>{skills().length}</span>
              <Icon name="chevronDown" />
            </summary>
            {content()}
          </details>
        }
      >
        <ChatDetailsDesktopSection
          section="skills"
          title={t("chat.sessionDetails.skillsUsed")}
          expanded={props.expanded ?? false}
          presented={props.presented}
          onExpandedChange={(expanded) => props.onExpandedChange?.(expanded)}
          metadata={
            <span class="chat-details-desktop-section__count">
              <span class="chat-details-desktop-section__count-separator" aria-hidden="true">
                ·
              </span>
              {skills().length}
            </span>
          }
        >
          {content()}
        </ChatDetailsDesktopSection>
      </Show>
    </Show>
  );
}
