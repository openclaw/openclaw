import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { decodeRequesterOrigin } from "../agents/requester-origin.js";
import { readTranscriptSenderIdentity } from "../chat/sender-identity.js";
import { readCanonicalUserChannelIdentityProfileId } from "../state/user-channel-identity-operations.js";
import type { UserChannelIdentity } from "../state/user-profiles.types.js";
import {
  resolveCurrentUserProfileDisplay,
  type CurrentUserProfileDisplay,
  type CurrentUserProfileDisplayResolver,
} from "./current-user-profile-display.js";

type Display = Extract<CurrentUserProfileDisplay, { kind: "resolved" }>;
export type LinkedChannelSenderDisplayResolver = (message: unknown) => Display | undefined;
export type LinkedChannelSenderDisplayPreparation = (
  messages: readonly unknown[],
) => Promise<LinkedChannelSenderDisplayResolver>;

function readLinkedChannelSenderCandidate(value: unknown) {
  const message = asOptionalRecord(value);
  const metadata = asOptionalRecord(message?.["__openclaw"]);
  const identity = readTranscriptSenderIdentity(metadata?.senderIdentity);
  const origin = decodeRequesterOrigin(metadata?.requesterOrigin);
  const provenance = asOptionalRecord(message?.provenance);
  if (
    message?.role !== "user" ||
    message.display === false ||
    (provenance && provenance.kind !== "external_user") ||
    identity?.type !== "observation" ||
    identity.senderKind !== "human" ||
    !identity.pluginId ||
    !identity.accountId ||
    !origin?.operatorProfileId ||
    origin.operatorProfileId === GATEWAY_OWNER_PROFILE_ID
  ) {
    return undefined;
  }
  return {
    profileId: origin.operatorProfileId,
    identity: {
      channelId: identity.pluginId,
      accountId: identity.accountId,
      senderId: identity.id,
    },
  };
}

/** Shared fanout defers this viewer-facing association to an authorized history read. */
export function requiresLinkedChannelSenderDisplayRead(message: unknown): boolean {
  return readLinkedChannelSenderCandidate(message) !== undefined;
}

/** A page-local presentation snapshot, never requester, ownership, or tool authority. */
export async function prepareLinkedChannelSenderDisplay(
  messages: readonly unknown[],
  options: {
    resolveDisplay?: CurrentUserProfileDisplayResolver;
    readLink?: (identity: UserChannelIdentity) => string | undefined | Promise<string | undefined>;
  } = {},
): Promise<LinkedChannelSenderDisplayResolver> {
  const resolveDisplay = options.resolveDisplay ?? resolveCurrentUserProfileDisplay;
  const readLink = options.readLink ?? readCanonicalUserChannelIdentityProfileId;
  const profiles = new Map<string, CurrentUserProfileDisplay>();
  const links = new Map<string, Promise<string | undefined>>();
  const displays = new Map<string, Display>();
  await Promise.all(
    messages.map(async (message) => {
      const candidate = readLinkedChannelSenderCandidate(message);
      if (!candidate) {
        return;
      }
      let display = profiles.get(candidate.profileId);
      if (!display) {
        display = resolveDisplay(candidate.profileId);
        profiles.set(candidate.profileId, display);
      }
      if (display.kind !== "resolved" || display.profileId === GATEWAY_OWNER_PROFILE_ID) {
        return;
      }
      const key = JSON.stringify(candidate.identity);
      let linked = links.get(key);
      if (!linked) {
        linked = Promise.resolve(readLink(candidate.identity));
        links.set(key, linked);
      }
      if ((await linked) === display.profileId) {
        displays.set(JSON.stringify(candidate), display);
      }
    }),
  );
  return (message) => {
    const candidate = readLinkedChannelSenderCandidate(message);
    return candidate ? displays.get(JSON.stringify(candidate)) : undefined;
  };
}

/** Derive before sanitation removes private requester evidence; never alter source identity. */
export function projectLinkedChannelSenderDisplay(
  message: unknown,
  resolveDisplay?: LinkedChannelSenderDisplayResolver,
): unknown {
  const record = asOptionalRecord(message);
  const metadata = asOptionalRecord(record?.["__openclaw"]);
  if (!record || !metadata) {
    return message;
  }
  const display = resolveDisplay?.(message);
  if (!display && !("senderDisplayProfileId" in metadata) && !("senderDisplayName" in metadata)) {
    return message;
  }
  const projected = { ...metadata };
  delete projected.senderDisplayProfileId;
  delete projected.senderDisplayName;
  if (readTranscriptSenderIdentity(metadata.senderIdentity)?.type === "observation") {
    delete projected.senderProfileAvatarUrl;
  }
  if (display) {
    projected.senderDisplayProfileId = display.profileId;
    projected.senderDisplayName = display.label;
    projected.senderProfileAvatarUrl = display.avatarUrl;
  }
  return { ...record, __openclaw: projected };
}
