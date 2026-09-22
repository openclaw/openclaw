import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorWriteAccess } from "../../app/operator-access.ts";
import type { HumanMentionDirectory } from "../chat/components/chat-composer-mention-menu.ts";
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
    !hasOperatorWriteAccess(gateway.snapshot.hello?.auth ?? null) ||
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
