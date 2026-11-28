import { createMemo, For } from "solid-js";
import {
  readMcpConnectAction,
  type McpConnectAction,
} from "../../../../../src/agents/mcp-connect-action.js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatToolLabelsEnglish } from "../../../i18n/locales/en-chat-tool-labels.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { extractToolCardsCached } from "../../../lib/chat/tool-cards.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { ChatActionCard } from "./chat-action-card.tsx";

registerEnglishCatalog(registerChatToolLabelsEnglish);

export function McpConnectCards(props: { groups: readonly MessageGroup[] }) {
  const actions = createMemo(() => {
    const byUrl = new Map<string, McpConnectAction>();
    for (const group of props.groups) {
      for (const item of group.messages) {
        for (const card of extractToolCardsCached(item.message)) {
          const action = readMcpConnectAction(card);
          if (action) {
            byUrl.set(action.authorizationUrl, action);
          }
        }
      }
    }
    return [...byUrl.values()];
  });
  return (
    <For each={actions()} keyed={(action) => action.authorizationUrl}>
      {(action) => (
        <ChatActionCard
          icon="lock"
          title={t("chat.toolCards.signInTo", { server: action().serverName })}
          subtitle={new URL(action().authorizationUrl).host}
          inline
        >
          <a
            class="btn primary btn--sm"
            href={action().authorizationUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("chat.toolCards.signIn")}
            <Icon name="externalLink" />
          </a>
        </ChatActionCard>
      )}
    </For>
  );
}
