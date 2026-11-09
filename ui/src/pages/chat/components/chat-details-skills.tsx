import { For, Show, createMemo } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatDetailsEnglish } from "../../../i18n/locales/en-chat-details.ts";
import { conversationSkillsUsed } from "../../../lib/chat/skills-used.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { ChatDetailsDesktopSection } from "./chat-details-desktop-section.tsx";
import type { ChatDetailsProps } from "./chat-details-types.ts";

registerEnglishCatalog(registerChatDetailsEnglish);
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
    <div role="list" class="chat-details-skills__list">
      <For each={skills()} keyed={(skill) => skill.name}>
        {(skill) => (
          <div role="listitem" class="chat-details__row chat-details-skills__item">
            <Icon name="book" />
            <span class="chat-details-skills__name">{skill().name}</span>
            <Show when={skill().loads > 1}>
              <small
                class="muted chat-details-skills__loads"
                aria-label={t("chat.sessionDetails.skillLoads", { count: String(skill().loads) })}
              >
                ×{skill().loads}
              </small>
            </Show>
          </div>
        )}
      </For>
    </div>
  );
  return (
    <Show when={skills().length > 0}>
      <Show
        when={props.desktop}
        fallback={
          <details
            class="chat-details-skills chat-details-mobile-root__group"
            data-details-group="skills"
          >
            <summary class="chat-details-mobile-root__entry">
              <span class="chat-details-mobile-root__copy">
                {t("chat.sessionDetails.skillsUsed")}
              </span>
              <span class="chat-details-mobile-root__metadata">{skills().length}</span>
              <Icon name="chevronDown" class="chat-details-mobile-root__chevron" />
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
