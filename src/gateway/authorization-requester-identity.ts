import type { AuthorizationInvocationContext } from "../plugins/authorization-policy.types.js";

export type AuthorizationRequesterIdentity = {
  kind: AuthorizationInvocationContext["principal"]["kind"];
  messageProvider?: string;
  accountId?: string;
  senderId?: string;
  senderName?: string;
  senderUsername?: string;
  senderE164?: string;
  senderIsOwner: boolean;
  isAuthorizedSender?: boolean;
  roleIds?: readonly string[];
};

/** Projects authenticated principal facts into requester-policy selectors. */
export function resolveAuthorizationRequesterIdentity(
  authorization: AuthorizationInvocationContext | undefined,
): AuthorizationRequesterIdentity | undefined {
  const principal = authorization?.principal;
  if (!principal) {
    return undefined;
  }
  if (principal.kind === "sender") {
    return {
      kind: principal.kind,
      messageProvider: principal.provider,
      accountId: principal.accountId,
      senderId: principal.senderId,
      senderName: principal.aliases?.name,
      senderUsername: principal.aliases?.username,
      senderE164: principal.aliases?.e164,
      senderIsOwner: principal.senderIsOwner === true,
      isAuthorizedSender: principal.isAuthorizedSender,
      roleIds: principal.roleIds,
    };
  }
  if (principal.kind === "operator") {
    return {
      kind: principal.kind,
      senderIsOwner: principal.isOwner === true,
    };
  }
  if (principal.kind === "unknown") {
    return {
      kind: principal.kind,
      messageProvider: principal.provider,
      accountId: principal.accountId,
      senderIsOwner: false,
    };
  }
  return {
    kind: principal.kind,
    senderIsOwner: false,
  };
}
