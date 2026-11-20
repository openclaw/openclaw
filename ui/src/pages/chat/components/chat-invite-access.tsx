import type { SessionMemberPermissionLevel } from "@openclaw/gateway-protocol";
import { createMemo, createUniqueId, For } from "solid-js";
import { Menu } from "../../../components/solid/menu.tsx";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import type { HumanMention } from "../../../lib/chat/chat-types.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerChatComposerEnglish);

const labels = {
  read: "chat.composer.inviteRead",
  suggest: "chat.composer.inviteSuggest",
  send: "chat.composer.inviteSend",
} as const;

export function ChatInviteAccess(props: {
  text: string;
  mentions: readonly HumanMention[];
  options: ReadonlyMap<string, readonly SessionMemberPermissionLevel[]>;
  onChange: (mentions: readonly HumanMention[]) => void;
}) {
  const id = createUniqueId();
  const people = createMemo(() => [
    ...new Map(
      props.mentions
        .filter((mention) => mention.access && props.options.has(mention.profileId))
        .map((mention) => [mention.profileId, mention]),
    ).values(),
  ]);
  return (
    <For each={people()} keyed={(mention) => mention.profileId}>
      {(mention) => {
        const name = () => props.text.slice(mention().start + 1, mention().end);
        return (
          <div class="chat-invite-access composer-context-strip">
            <span>{t("chat.composer.inviteAs", { name: name() })}</span>
            <Menu
              id={`${id}-${mention().profileId}`}
              label={t("chat.composer.inviteLevel", { name: name() })}
              trigger={t(labels[mention().access ?? "read"])}
              placement="top-start"
              items={(props.options.get(mention().profileId) ?? []).map((level) => ({
                id: level,
                label: t(labels[level]),
                type: "radio",
                checked: level === mention().access,
              }))}
              onSelect={(item) => {
                const level = props.options
                  .get(mention().profileId)
                  ?.find((option) => option === item.id);
                if (level) {
                  props.onChange(
                    props.mentions.map((entry) =>
                      entry.profileId === mention().profileId ? { ...entry, access: level } : entry,
                    ),
                  );
                }
              }}
            />
          </div>
        );
      }}
    </For>
  );
}
