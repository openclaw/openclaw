import type { SessionsCatalogContinueResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { ApplicationContext } from "../../app/context.ts";
import {
  announceCatalogSessionContinued,
  type CatalogSessionKey,
} from "../../lib/sessions/catalog-key.ts";
import { catalogMethod } from "../../lib/sessions/catalog-read-method.ts";
import type { cloneChatAttachmentsForIndependentOwner } from "./attachment-payload-store.ts";
import { clearPaneSessionHandoff, preparePaneSessionHandoff } from "./chat-pane-shared.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

export async function continueCapturedCatalogSession({
  state,
  client,
  context,
  paneId,
  key,
  agentId,
  attachments,
  draft,
  isCurrent,
  onSessionChange,
}: {
  state: ChatPageHost;
  context: ApplicationContext;
  paneId: string;
  isCurrent: () => boolean;
  onSessionChange: (nextSessionKey: string) => boolean | void;
  client: NonNullable<ChatPageHost["client"]>;
  key: CatalogSessionKey;
  agentId: string;
  attachments: ReturnType<typeof cloneChatAttachmentsForIndependentOwner>;
  draft: string;
}): Promise<void> {
  // The action module may finish loading after the pane changes; neither that
  // stale capture nor a later RPC result may create a handoff for its successor.
  if (!isCurrent()) {
    return;
  }
  const result = await client.request<SessionsCatalogContinueResult>(
    catalogMethod(state, key.catalogId, "continue"),
    { ...key, agentId },
  );
  if (!isCurrent()) {
    return;
  }
  preparePaneSessionHandoff(context, paneId, result.sessionKey, {
    attachments,
    draft,
    send: true,
  });
  if (onSessionChange(result.sessionKey) === false) {
    clearPaneSessionHandoff(context, paneId, result.sessionKey);
    return;
  }
  announceCatalogSessionContinued({ ...key, agentId, sessionKey: result.sessionKey });
}
