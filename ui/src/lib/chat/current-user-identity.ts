import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readPresenceEntries, resolveSelfPresenceUser } from "../../app/user-profile.ts";
import { normalizeSenderIdentity, type SenderIdentity } from "./sender-label.ts";

type HelloWithPresence = {
  snapshot?: unknown;
};

/** Uses shared identity when supplied; presence supports callers without Gateway identity state. */
export function resolveCurrentUserIdentity(
  hello: HelloWithPresence | null | undefined,
  instanceId: string | null | undefined,
  snapshotUser?: unknown,
): SenderIdentity | null {
  const user =
    snapshotUser === undefined
      ? resolveSelfPresenceUser(readPresenceEntries(hello?.snapshot) ?? [], instanceId?.trim())
      : asOptionalRecord(snapshotUser);
  return user
    ? normalizeSenderIdentity({
        id: user.id ?? user.email,
        name: user.name,
        identity: user.identity,
        profileAvatarUrl: user.avatarUrl,
      })
    : null;
}
