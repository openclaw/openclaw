import { For } from "solid-js";
import { t } from "../../../lib/reactive/i18n.ts";
import { ChatAuthorAvatar } from "./chat-author-avatar.ts";
import { paneDomId } from "./chat-composer-dom.ts";
import type { HumanMentionMenu, HumanMentionMenuHost } from "./chat-composer-mention-menu-state.ts";
import { renderComposerMenuOption as ComposerMenuOption } from "./chat-composer-menu.tsx";

export function HumanMentionMenuOptions(props: { args: [HumanMentionMenu, HumanMentionMenuHost] }) {
  const menu = () => props.args[0];
  const host = () => props.args[1];
  const result = () => {
    const search = menu().state.search;
    return search?.kind === "ready" ? search.result : undefined;
  };
  return (
    <For each={result()?.users}>
      {(person, index) => (
        <ComposerMenuOption
          id={paneDomId(host().paneId, `mention-option-${index()}`)}
          active={index() === menu().state.index}
          select={() => menu().select(person, host())}
          hover={() => menu().hover(index(), person.profileId)}
          icon={
            <ChatAuthorAvatar
              sender={{
                id: person.profileId,
                name: person.displayName,
                identity: { type: "profile", id: person.profileId },
                profileAvatarUrl: person.avatarUrl,
              }}
            />
          }
          iconHidden={true}
          name={person.displayName}
          description={person.online ? t("chat.mentions.online") : null}
        />
      )}
    </For>
  );
}
