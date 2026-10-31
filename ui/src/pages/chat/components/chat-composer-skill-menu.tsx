import { lazy, Show } from "solid-js";
import { getSkillDisplayName, getSlashCommandDescription } from "../../../lib/chat/commands.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { paneDomId } from "./chat-composer-dom.ts";
import { ComposerMenu, ComposerMenuLoadingRows } from "./chat-composer-menu.tsx";
import {
  getActiveSkillMenuOptionId,
  isSkillMenuVisible,
  skillOptionId,
  type SkillMenu as SkillMenuState,
  type SkillMenuHost,
} from "./chat-composer-skill-menu-state.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";

const SkillMenuOptions = lazy(() => import("./chat-composer-skill-menu-options.tsx"), {
  export: "SkillMenuOptions",
});

export function SkillMenu(props: { menu: SkillMenuState; host: SkillMenuHost }) {
  const state = () => props.menu.state;
  const loading = () => state().skillCommandRefreshPending || state().skillMenuItems.length === 0;
  return (
    <Show when={isSkillMenuVisible(state())}>
      <ComposerMenu
        getTextarea={() => props.host.getTextarea()}
        id={paneDomId(props.host.paneId, "skill-menu-listbox")}
        class="skill-menu"
        label={t("chat.skills.menu")}
        revision={state().skillMenuItems}
        activeId={getActiveSkillMenuOptionId(state(), props.host.paneId)}
      >
        <div class="slash-menu-group">
          <div class="slash-menu-group__label">
            {t(loading() ? "chat.skills.loading" : "chat.skills.label")}
          </div>
          <Show when={!loading()}>
            <ChatLazyBoundary
              fallback={
                <ComposerMenuLoadingRows
                  activeId={getActiveSkillMenuOptionId(state(), props.host.paneId)}
                  rows={state().skillMenuItems.map((command, index) => ({
                    id: skillOptionId(props.host.paneId, command),
                    name: getSkillDisplayName(command),
                    description: getSlashCommandDescription(command),
                    select: () => props.menu.select(command, props.host),
                    hover: () => props.menu.hover(index),
                  }))}
                />
              }
              onClose={() => props.menu.reset()}
            >
              <SkillMenuOptions menu={props.menu} host={props.host} />
            </ChatLazyBoundary>
          </Show>
        </div>
      </ComposerMenu>
    </Show>
  );
}
