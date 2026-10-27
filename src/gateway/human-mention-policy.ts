import { isDeepStrictEqual } from "node:util";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  ErrorCodes,
  MAX_HUMAN_MENTIONS,
  MAX_MENTIONABLE_USERS,
  errorShape,
  type ErrorShape,
  type MentionableUser,
  type UsersMentionableParams,
  type UsersMentionableResult,
} from "../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../config/sessions.js";
import { updateSessionProfileInvolvementAsync } from "../config/sessions/session-accessor.js";
import type { SessionMentionInvitation } from "../config/sessions/session-sharing-authority.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { operatorScopeSatisfied } from "../shared/operator-scope-compat.js";
import { readUserProfileVersion } from "../state/user-profile-events.js";
import { readResidentUserProfileAliases } from "../state/user-profile-list.js";
import { readUserProfileDirectory } from "../state/user-profile-reads.js";
import {
  resolveCurrentUserProfileDisplay,
  type CurrentUserProfileDisplay,
} from "./current-user-profile-display.js";
import type { MentionInbox } from "./mention-inbox.contracts.js";
import type { MentionCommittedInput } from "./mention-inbox.types.js";
import {
  authorizeGatewaySessionCreation,
  resolveOperatorRolePolicyForProfile,
} from "./operator-role-policy.js";
import { ADMIN_SCOPE, READ_SCOPE, SESSION_READ_SCOPE } from "./operator-scopes.js";
import { authenticatedProfileUnavailableError } from "./server-methods/gateway-client-identity.js";
import type { GatewayClient } from "./server-methods/types.js";
import { resolveOperatorSessionCreation } from "./session-creation-provenance.js";
import { isSessionCreatorProfile } from "./session-creator.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import type { SessionSharingTarget } from "./session-sharing-policy.js";
import { prepareSessionSharingRead } from "./session-sharing-target-read.js";
import {
  createProfileSessionEntryFilter,
  isSessionVisibilityAllowed,
  prepareSessionSharing,
  resolveSessionVisibility,
} from "./session-sharing.js";

const MAX_DIRECTORY_PROFILES = 10_000;

type MentionProfile = Extract<CurrentUserProfileDisplay, { kind: "resolved" }>;
export type MentionSharingTarget = SessionSharingTarget & { membership?: ReadonlySet<string> };
type MentionTarget = {
  agentId: string;
  sessionKey?: string;
  entry: Pick<SessionEntry, "createdActor" | "visibility" | "incognito">;
  membership?: ReadonlySet<string>;
};
type MentionReader = {
  profile: MentionProfile;
  canRead: (target: MentionTarget) => boolean;
  canInvite: (target: MentionTarget) => boolean;
};

/** UI labels are text, never identity or an email-address fallback. */
export function humanMentionDisplayLabel(label: string | undefined, profileId: string): string {
  const text = label
    ?.replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return truncateUtf16Safe(text || `Person ${profileId.slice(0, 8)}`, 256);
}

export function createHumanMentionPolicy(params: {
  getRuntimeConfig: () => OpenClawConfig;
  getClients: () => Iterable<GatewayClient>;
  readSessionTarget: (sessionKey: string, agentId?: string) => MentionSharingTarget | null;
}) {
  let active = true;
  let profileVersion = -1;
  const displays = new Map<string, CurrentUserProfileDisplay>();
  let directory: { profiles: { id: string; logins: string[] }[]; truncated: boolean } | undefined;
  let eligibleDirectory:
    | { key: string; users: (MentionableUser & { logins: string[] })[]; truncated: boolean }
    | undefined;

  function synchronizeProfileVersion(): void {
    const version = readUserProfileVersion();
    if (profileVersion !== version) {
      profileVersion = version;
      displays.clear();
      directory = undefined;
      eligibleDirectory = undefined;
    }
  }

  function needsDirectoryPreparation(): boolean {
    synchronizeProfileVersion();
    return active && !directory;
  }

  async function prepareDirectory(): Promise<void> {
    if (!needsDirectoryPreparation()) {
      return;
    }
    const version = profileVersion;
    const prepared = await readUserProfileDirectory(MAX_DIRECTORY_PROFILES);
    if (active && version === readUserProfileVersion()) {
      directory = prepared;
    }
  }

  function readProfile(profileId: string): MentionProfile | undefined {
    synchronizeProfileVersion();
    let profile = displays.get(profileId);
    if (!profile) {
      profile = resolveCurrentUserProfileDisplay(profileId);
      // Catalog hydration does not advance the profile revision; retry unresolved reads.
      if (profile.kind === "resolved") {
        pruneMapToMaxSize(displays, MAX_DIRECTORY_PROFILES - 1);
        displays.set(profileId, profile);
      }
    }
    return profile.kind === "resolved" ? profile : undefined;
  }

  function identify(
    client: GatewayClient | null,
    cfg: OpenClawConfig,
  ): Result<MentionReader, ErrorShape> {
    if (
      !client?.connect ||
      client.invalidated === true ||
      client.internal?.syntheticClient ||
      (client.connect.role ?? "operator") !== "operator" ||
      !operatorScopeSatisfied(SESSION_READ_SCOPE, client.connect.scopes ?? [])
    ) {
      return err(errorShape(ErrorCodes.FORBIDDEN, "Human mentions require a signed-in operator."));
    }
    const verifiedProfile = client.authenticatedUserProfile;
    if (!verifiedProfile?.profileId) {
      return err(
        client.authenticatedGitHubIdentitySync
          ? authenticatedProfileUnavailableError()
          : errorShape(
              ErrorCodes.FORBIDDEN,
              "Human mentions require a verified user profile. Sign in to use mentions.",
            ),
      );
    }
    const profile = readProfile(verifiedProfile.profileId);
    if (!profile) {
      return err(authenticatedProfileUnavailableError());
    }
    const policy = resolveOperatorRolePolicyForProfile(profile.profileId, cfg);
    if (policy && !operatorScopeSatisfied(SESSION_READ_SCOPE, policy.scopes)) {
      return err(errorShape(ErrorCodes.FORBIDDEN, "Your operator role cannot read mentions."));
    }
    const admin =
      client.connect.scopes?.includes(ADMIN_SCOPE) &&
      (!policy || policy.scopes.includes(ADMIN_SCOPE));
    // The reader lives for one synchronous projection, never across an await.
    const { entryFilter } = prepareSessionSharing({
      cfg,
      client: {
        connect: { ...client.connect, scopes: admin ? [ADMIN_SCOPE] : [SESSION_READ_SCOPE] },
        internal: { operatorRoleActor: { kind: "operator", profileId: profile.profileId } },
      },
    });
    return ok({
      profile,
      canRead: (target) =>
        entryFilter?.(target.sessionKey, target.entry, target.membership?.has(profile.profileId)) ??
        true,
      canInvite: (target) =>
        admin || isSessionCreatorProfile(target.entry.createdActor, profile.profileId),
    });
  }

  function recipientProfile(
    profileId: string,
    target: MentionTarget,
    cfg: OpenClawConfig,
    canInvite = false,
  ): MentionProfile | undefined {
    const profile = readProfile(profileId);
    // Administrator read access does not make incognito sessions eligible for mentions.
    if (!profile || target.entry.incognito === true || isIncognitoSessionKey(target.sessionKey)) {
      return undefined;
    }
    const policy = resolveOperatorRolePolicyForProfile(profile.profileId, cfg);
    const scopes = policy?.scopes ?? [READ_SCOPE];
    if (!operatorScopeSatisfied(SESSION_READ_SCOPE, scopes)) {
      return undefined;
    }
    if (scopes.includes(ADMIN_SCOPE)) {
      return profile;
    }
    const entryFilter = createProfileSessionEntryFilter({
      profileId: profile.profileId,
      sessionCap: policy?.sessions.others,
      membership: target.membership,
    });
    return entryFilter(target.sessionKey, target.entry) ||
      (canInvite &&
        policy?.sessions.others === "invited" &&
        resolveSessionVisibility(target.entry) !== "draft")
      ? profile
      : undefined;
  }

  function resolveContext(
    client: GatewayClient | null,
    input: UsersMentionableParams,
    cfg: OpenClawConfig,
    prepared?: { readTarget: () => MentionSharingTarget | null },
  ): Result<{ target: MentionTarget; profile: MentionProfile; canInvite: boolean }, ErrorShape> {
    const identified = identify(client, cfg);
    if (!identified.ok) {
      return identified;
    }
    const requester = identified.value;
    if ("sessionKey" in input) {
      const agent = resolveRequestedSessionAgentId(cfg, input.sessionKey, input.agentId);
      if (!agent.ok) {
        return err(agent.error);
      }
      const resolved = prepared
        ? prepared.readTarget()
        : params.readSessionTarget(input.sessionKey, agent.agentId);
      const target = resolved && {
        agentId: resolved.agentId,
        sessionKey: resolved.canonicalKey,
        membership: resolved.membership,
        entry: {
          createdActor: resolved.entry.createdActor,
          visibility: resolved.entry.visibility,
          incognito: resolved.entry.incognito,
        },
      };
      if (!target || !requester.canRead(target)) {
        return err(errorShape(ErrorCodes.INVALID_REQUEST, "Session was not found."));
      }
      return ok({ target, profile: requester.profile, canInvite: requester.canInvite(target) });
    }
    const agent = resolveRequestedSessionAgentId(cfg, undefined, input.agentId);
    if (!agent.ok) {
      return err(agent.error);
    }
    const creationError = authorizeGatewaySessionCreation({
      cfg,
      profileId: requester.profile.profileId,
      agentId: agent.agentId,
    });
    if (creationError) {
      return err(creationError);
    }
    const visibility = resolveSessionVisibility({ visibility: input.visibility });
    if (!isSessionVisibilityAllowed(cfg, visibility)) {
      return err(errorShape(ErrorCodes.INVALID_REQUEST, "This session visibility is disabled."));
    }
    return ok({
      profile: requester.profile,
      canInvite: true,
      target: {
        agentId: agent.agentId,
        entry: {
          visibility,
          createdActor: resolveOperatorSessionCreation({
            authenticatedUserProfile: requester.profile,
          }).actor,
        },
      },
    });
  }

  function involvedProfiles(
    input: MentionCommittedInput,
    target: MentionSharingTarget | null,
    cfg: OpenClawConfig,
  ): string[] {
    if (
      target?.entry.sessionId === input.sessionId &&
      target.entry.incognito !== true &&
      !isIncognitoSessionKey(target.canonicalKey)
    ) {
      const sender = readProfile(input.senderProfileId);
      return input.recipientProfileIds.flatMap((id) => {
        const recipient = recipientProfile(
          id,
          {
            agentId: target.agentId,
            sessionKey: target.canonicalKey,
            entry: target.entry,
            membership: target.membership,
          },
          cfg,
        );
        return sender && recipient && sender.profileId !== recipient.profileId
          ? [recipient.profileId]
          : [];
      });
    }
    return [];
  }

  return {
    prepareInvitation(
      this: void,
      ...[client, target, mentions]: Parameters<MentionInbox["prepareInvitation"]>
    ) {
      const select = (): SessionMentionInvitation | undefined => {
        if (!active) {
          throw new Error("Mention invitation authority is closed");
        }
        const cfg = params.getRuntimeConfig();
        const candidates = mentions.flatMap((mention) => {
          const profile = readProfile(mention.profileId);
          if (!profile) {
            throw new Error("Mention recipient changed; select the recipients again");
          }
          return resolveOperatorRolePolicyForProfile(profile.profileId, cfg)?.sessions.others ===
            "invited"
            ? [{ ...mention, profile }]
            : [];
        });
        if (!candidates.length) {
          return undefined;
        }
        if (!target.entry) {
          throw new Error("Mention invitation requires an admitted session");
        }
        const requester = identify(client, cfg);
        if (!requester.ok) {
          throw new Error(requester.error.message);
        }
        const selectedTarget = { ...target, entry: target.entry };
        if (!requester.value.canInvite(selectedTarget)) {
          return undefined;
        }
        const profiles = new Map<string, SessionMentionInvitation["profiles"][number]>();
        for (const { profile, token } of candidates) {
          if (!recipientProfile(profile.profileId, selectedTarget, cfg, true)) {
            throw new Error("Mention recipient changed; select the recipients again");
          }
          const previous = profiles.get(profile.profileId);
          profiles.set(profile.profileId, {
            profileId: profile.profileId,
            aliases: [...readResidentUserProfileAliases(profile.profileId)].toSorted(),
            tokens: [...new Set([...(previous?.tokens ?? []), token])],
          });
        }
        return {
          addedBy: requester.value.profile.profileId,
          expectedEntry: {
            sessionId: target.entry.sessionId,
            createdActor: target.entry.createdActor,
            visibility: target.entry.visibility,
            incognito: target.entry.incognito,
          },
          profiles: [...profiles.values()],
        };
      };
      const invitation = select();
      return invitation
        ? {
            invitation,
            assertCurrent() {
              if (!isDeepStrictEqual(select(), invitation)) {
                throw new Error(
                  "Mention invitation authority changed before the message was posted",
                );
              }
            },
          }
        : undefined;
    },
    async prepareContext(input: UsersMentionableParams) {
      if (!("sessionKey" in input)) {
        return { readTarget: () => null, release() {} };
      }
      const cfg = params.getRuntimeConfig();
      const agent = resolveRequestedSessionAgentId(cfg, input.sessionKey, input.agentId);
      if (!agent.ok) {
        return { readTarget: () => null, release() {} };
      }
      const prepared = await prepareSessionSharingRead({
        cfg,
        sessionKey: input.sessionKey,
        agentId: agent.agentId,
      });
      return {
        readTarget: () => {
          const { target, membership } = prepared.readCurrent(params.getRuntimeConfig());
          return target && { ...target, membership };
        },
        release: prepared.release,
      };
    },
    async recordCommittedInvolvementAsync(
      input: MentionCommittedInput,
      facts: Awaited<ReturnType<typeof prepareSessionSharingRead>>,
      client?: GatewayClient | null,
    ): Promise<void> {
      const initialCfg = params.getRuntimeConfig();
      const agent = resolveRequestedSessionAgentId(initialCfg, input.sessionKey, input.agentId);
      if (!agent.ok || isIncognitoSessionKey(input.sessionKey)) {
        return;
      }
      const select = () => {
        const cfg = params.getRuntimeConfig();
        const current = facts.readCurrent(cfg);
        const target = current.target && { ...current.target, membership: current.membership };
        const profileIds = involvedProfiles(input, target, cfg);
        const requester = client && identify(client, cfg);
        if (
          client &&
          (!target ||
            target.entry.sessionId !== input.sessionId ||
            !requester?.ok ||
            requester.value.profile.profileId !== readProfile(input.senderProfileId)?.profileId ||
            !requester.value.canRead({
              agentId: target.agentId,
              sessionKey: target.canonicalKey,
              entry: target.entry,
              membership: current.membership,
            }) ||
            input.recipientProfileIds.some((id) => {
              const profile = readProfile(id);
              return !profile || !profileIds.includes(profile.profileId);
            }))
        ) {
          throw new Error("Committed mention recipients or sender authority changed");
        }
        return { target, profileIds };
      };
      const { target, profileIds } = select();
      if (!target || !profileIds.length) {
        return;
      }
      const accepted = await updateSessionProfileInvolvementAsync(
        { agentId: target.agentId, sessionKey: target.storeKey, storePath: target.storePath },
        {
          expectedSessionId: input.sessionId,
          expectedEntry: target.entry,
          profileIds,
          change: { kind: "mention", source: input.committedSource },
          assertCurrent() {
            const current = select();
            if (!active || !isDeepStrictEqual(current.profileIds, profileIds)) {
              throw new Error("Committed mention authority changed before involvement commit");
            }
          },
        },
      );
      if (!accepted) {
        throw new Error("Committed mention involvement was refused for a changed session");
      }
    },
    identify,
    senderConnectionIds(client: GatewayClient, senderProfileId: string): Set<string> {
      const sender = readProfile(senderProfileId);
      const requesterId = client.authenticatedUserProfile?.profileId;
      if (!sender || !requesterId || readProfile(requesterId)?.profileId !== sender.profileId) {
        return new Set();
      }
      // Recovery retains the authenticated sender, not the original socket.
      // Delivery uses current connections without borrowing invitation authority.
      const cfg = params.getRuntimeConfig();
      return new Set(
        [...params.getClients()].flatMap((connected) => {
          if (!connected.connId || connected.connectionSignal?.aborted) {
            return [];
          }
          const recipient = identify(connected, cfg);
          return recipient.ok && recipient.value.profile.profileId === sender.profileId
            ? [connected.connId]
            : [];
        }),
      );
    },
    prepareDirectory,
    needsDirectoryPreparation,
    readProfile,
    recipientProfile,
    invalidateDirectory(): void {
      eligibleDirectory = undefined;
    },
    dispose(): void {
      active = false;
      displays.clear();
      directory = undefined;
      eligibleDirectory = undefined;
    },
    mentionable(
      client: GatewayClient | null,
      input: UsersMentionableParams,
      prepared?: { readTarget: () => MentionSharingTarget | null },
    ): Result<UsersMentionableResult, ErrorShape> {
      const cfg = params.getRuntimeConfig();
      const context = resolveContext(client, input, cfg, prepared);
      if (!context.ok) {
        return context;
      }
      const { target, profile, canInvite } = context.value;
      if (!directory) {
        throw new Error("The mention directory has not been prepared.");
      }
      // Keystrokes reuse one bounded eligible roster; identity/session/role changes replace it.
      const key = JSON.stringify([
        profileVersion,
        target,
        canInvite,
        target.membership && [...target.membership].toSorted(),
        cfg.gateway?.roles,
      ]);
      if (eligibleDirectory?.key !== key) {
        const users = directory.profiles.flatMap(({ id, logins }) => {
          const candidate = recipientProfile(id, target, cfg, canInvite);
          return candidate
            ? [
                {
                  profileId: candidate.profileId,
                  displayName: humanMentionDisplayLabel(candidate.label, candidate.profileId),
                  avatarUrl: candidate.avatarUrl,
                  logins,
                  online: false,
                },
              ]
            : [];
        });
        eligibleDirectory = { key, users, truncated: directory.truncated };
      }
      const query = input.query?.trim().toLocaleLowerCase() ?? "";
      const users = eligibleDirectory.users.filter(
        (candidate) =>
          candidate.profileId !== profile.profileId &&
          (!query ||
            candidate.displayName.toLocaleLowerCase().includes(query) ||
            candidate.logins.some((login) => login.toLocaleLowerCase().includes(query))),
      );
      const names = new Map<string, number>();
      for (const candidate of users) {
        names.set(candidate.displayName, (names.get(candidate.displayName) ?? 0) + 1);
      }
      const online = new Set<string>();
      for (const connected of params.getClients()) {
        const id = connected.authenticatedUserProfile?.profileId;
        if (id && !connected.internal?.syntheticClient) {
          const current = readProfile(id);
          if (current) {
            online.add(current.profileId);
          }
        }
      }
      const projected = users.map((candidate) => ({
        profileId: candidate.profileId,
        displayName:
          (names.get(candidate.displayName) ?? 0) > 1
            ? `${truncateUtf16Safe(candidate.displayName, 244)} (${candidate.profileId.slice(0, 8)})`
            : candidate.displayName,
        avatarUrl: candidate.avatarUrl,
        online: online.has(candidate.profileId),
      }));
      projected.sort(
        (left, right) =>
          Number(right.online) - Number(left.online) ||
          left.displayName.localeCompare(right.displayName) ||
          left.profileId.localeCompare(right.profileId),
      );
      return ok({
        users: projected.slice(0, MAX_MENTIONABLE_USERS),
        truncated: eligibleDirectory.truncated || projected.length > MAX_MENTIONABLE_USERS,
      });
    },
    validateRecipients(
      client: GatewayClient | null,
      input: UsersMentionableParams,
      profileIds: readonly string[],
      prepared?: { readTarget: () => MentionSharingTarget | null },
    ): Result<readonly string[], ErrorShape> {
      if (profileIds.length === 0) {
        return ok([]);
      }
      const cfg = params.getRuntimeConfig();
      const context = resolveContext(client, input, cfg, prepared);
      if (!context.ok) {
        return context;
      }
      const { target, profile, canInvite } = context.value;
      const recipients = new Set<string>();
      for (const id of profileIds) {
        const candidate = recipientProfile(id, target, cfg, canInvite);
        if (
          !candidate ||
          candidate.profileId === profile.profileId ||
          profileIds.length > MAX_HUMAN_MENTIONS
        ) {
          return err(
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              "One or more mentioned people are unavailable. Select the recipients again.",
            ),
          );
        }
        recipients.add(candidate.profileId);
      }
      return ok([...recipients]);
    },
  };
}
