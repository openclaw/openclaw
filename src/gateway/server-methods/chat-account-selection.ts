import { toUSVString } from "node:util";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { ChatAccountSelection } from "../../../packages/gateway-protocol/src/schema/users.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { PreparedModelRuntimePublicationSupersededError } from "../../agents/prepared-model-runtime.errors.js";
import { resolveSessionAuthProfileOverrideSource } from "../../config/sessions/auth-profile-override-provenance.js";
import { assertExistingDatabaseIdentity } from "../../infra/sqlite-worker-identity.js";
import { captureOpenClawStateReadContext } from "../../state/openclaw-state-worker-context.js";
import {
  isUserModelAuthProfileId,
  parseUserModelAuthProfileId,
} from "../../state/user-model-account-id.js";
import { readUserModelAccountSelectionAsync } from "../../state/user-model-account-operations.js";
import type { UserModelAccount } from "../../state/user-model-accounts.js";
import {
  captureUserProfileAuthorityRead,
  captureUserProfileModelAccountLinksAuthority,
  readUserProfileVersion,
} from "../../state/user-profile-events.js";
import type { ChatMetadataSessionEntry } from "./chat-metadata-contract.js";

export async function prepareChatAccountSelection(params: {
  authStore: AuthProfileStore;
  sessionEntry?: ChatMetadataSessionEntry;
  requesterProfileId?: string;
  readRequesterProfileId?: () => string | undefined;
}): Promise<() => ChatAccountSelection> {
  const requesterProfileId = params.readRequesterProfileId
    ? params.readRequesterProfileId()
    : params.requesterProfileId;
  const authProfileId = params.sessionEntry?.authProfileOverride?.trim();
  let personal: UserModelAccount | undefined;
  let ownerDisplayName: string | null | undefined;
  let isCurrent: (() => boolean) | undefined;
  if (authProfileId && isUserModelAuthProfileId(authProfileId)) {
    const { admission } = captureOpenClawStateReadContext();
    const linksCurrent = requesterProfileId
      ? captureUserProfileModelAccountLinksAuthority(admission, requesterProfileId)
      : undefined;
    const authority = await captureUserProfileAuthorityRead(admission);
    const displayVersion = readUserProfileVersion();
    const selection = await readUserModelAccountSelectionAsync(
      { profileId: requesterProfileId, authProfileId },
      { path: admission.databasePath },
    );
    personal = selection?.personal;
    ownerDisplayName = selection?.owner?.displayName;
    const locator = parseUserModelAuthProfileId(authProfileId);
    const identityCurrent = authority.bind(
      [requesterProfileId, locator?.ownerProfileId, selection?.owner?.profileId].filter(
        (id): id is string => id !== undefined,
      ),
    );
    isCurrent = () => {
      if (admission.identity.key.startsWith("file:")) {
        assertExistingDatabaseIdentity(
          admission.databasePath,
          admission.identity.key,
          admission.identity.birthtime,
        );
      }
      return (
        Boolean(identityCurrent?.()) &&
        linksCurrent?.() !== false &&
        readUserProfileVersion() === displayVersion
      );
    };
  }
  return () => {
    if (
      isCurrent?.() === false ||
      params.sessionEntry?.authProfileOverride?.trim() !== authProfileId ||
      (params.readRequesterProfileId && params.readRequesterProfileId() !== requesterProfileId)
    ) {
      throw new PreparedModelRuntimePublicationSupersededError(
        "Personal account changed while preparing its metadata. Retry the request.",
      );
    }
    return resolveChatAccountSelection({ ...params, personal, ownerDisplayName });
  };
}

/** The session owns this preference; it is not a receipt for the account that served a turn. */
export function resolveChatAccountSelection(params: {
  authStore: AuthProfileStore;
  sessionEntry?: ChatMetadataSessionEntry;
  personal?: UserModelAccount;
  ownerDisplayName?: string | null;
}): ChatAccountSelection {
  const authProfileId = params.sessionEntry?.authProfileOverride?.trim();
  if (!authProfileId) {
    return { kind: "automatic", label: "Automatic account selection" };
  }
  const source = resolveSessionAuthProfileOverrideSource(params.sessionEntry);
  if (!isUserModelAuthProfileId(authProfileId)) {
    const credential = params.authStore.profiles[authProfileId];
    return {
      kind: "shared",
      authProfileId,
      label: truncateUtf16Safe(toUSVString(credential?.displayName?.trim() || authProfileId), 256),
      source,
    };
  }
  const personal = params.personal;
  if (personal) {
    return { kind: "personal", authProfileId, label: personal.label, source };
  }
  // Session access permits using its established selection, not inspecting
  // another person's provider identity or discovering a credential locator.
  const rawDisplayName = params.ownerDisplayName?.trim();
  const displayName = rawDisplayName ? toUSVString(rawDisplayName) : undefined;
  return {
    kind: "personal",
    label: displayName ? truncateUtf16Safe(`${displayName}'s account`, 256) : "Personal account",
    source,
  };
}
