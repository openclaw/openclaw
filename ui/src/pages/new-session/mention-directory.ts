import type { ApplicationContext } from "../../app/context.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import type { HumanMentionDirectory } from "../chat/components/chat-composer-mention-menu.tsx";
import type { NewSessionVisibility } from "./create-params.ts";

/** Both creation surfaces query people for the selected destination, not the foreground chat. */
export function resolveNewSessionMentionDirectory(options: {
  context: ApplicationContext | undefined;
  agentId: string;
  draftOwnerKey: string;
  visibility?: NewSessionVisibility;
  isCatalogTarget?: boolean;
  nativeTerminal?: boolean;
}): HumanMentionDirectory | undefined {
  const gateway = options.context?.gateway;
  const client = gateway?.snapshot.client;
  const profile = gateway?.snapshot.selfUser?.identity;
  if (
    !client ||
    gateway?.snapshot.phase !== "connected" ||
    profile?.type !== "profile" ||
    !readSessionMethodAccess(gateway.snapshot, {
      method: "sessions.create",
      sessionScope: true,
    }).allowed ||
    options.isCatalogTarget ||
    options.nativeTerminal ||
    options.visibility === "incognito"
  ) {
    return undefined;
  }
  return {
    client,
    ownerKey: JSON.stringify([
      gateway.connectionRevision,
      client.recoveryScope,
      profile.id,
      options.draftOwnerKey,
    ]),
    params: {
      agentId: options.agentId,
      ...(options.visibility === "draft" ? { visibility: "draft" as const } : {}),
    },
  };
}
