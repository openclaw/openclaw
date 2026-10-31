import type { GatewayHelloOk } from "../../api/gateway.ts";
import { resolveSelfPresenceUser, type AuthenticatedUser } from "../../app/user-profile.ts";
import { normalizeSenderIdentity, type SenderIdentity } from "./sender-label.ts";

/** Uses shared identity when supplied; presence supports callers without Gateway identity state. */
export function resolveCurrentUserIdentity(
  hello: Pick<GatewayHelloOk, "snapshot"> | null | undefined,
  instanceId: string | null | undefined,
  snapshotUser?: AuthenticatedUser | null,
): SenderIdentity | null {
  const user =
    snapshotUser === undefined
      ? resolveSelfPresenceUser(hello?.snapshot?.presence ?? [], instanceId?.trim())
      : snapshotUser;
  return user
    ? normalizeSenderIdentity({
        id: user.id,
        name: user.name,
        identity: user.identity,
        profileAvatarUrl: user.avatarUrl,
      })
    : null;
}
