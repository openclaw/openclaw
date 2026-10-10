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
import {
  updateSessionProfileInvolvement,
  updateSessionProfileInvolvementAsync,
} from "../config/sessions/session-accessor.js";
import { captureIncognitoSessionSource } from "../config/sessions/session-incognito-binding.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { readUserProfileVersion } from "../state/user-profile-events.js";
import { readUserProfileDirectory } from "../state/user-profile-reads.js";
import {
  resolveCurrentUserProfileDisplay,
  type CurrentUserProfileDisplay,
} from "./current-user-profile-display.js";
import type { MentionCommittedInput } from "./mention-inbox.types.js";
import {
  authorizeGatewaySessionCreation,
  resolveOperatorRolePolicyForProfile,
} from "./operator-role-policy.js";
import { ADMIN_SCOPE, READ_SCOPE } from "./operator-scopes.js";
import { authenticatedProfileUnavailableError } from "./server-methods/gateway-client-identity.js";
import type { GatewayClient } from "./server-methods/types.js";
import { resolveOperatorSessionCreation } from "./session-creation-provenance.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import { prepareSessionMutationFacts } from "./session-sharing-preparation.js";
import {
  createProfileSessionEntryFilter,
  isSessionVisibilityAllowed,
  prepareSessionSharing,
  resolveSessionSharingTarget,
  resolveSessionVisibility,
} from "./session-sharing.js";

const MAX_DIRECTORY_PROFILES = 10_000;

type MentionProfile = Extract<CurrentUserProfileDisplay, { kind: "resolved" }>;
type MentionTarget = {
  agentId: string;
  sessionKey?: string;
  entry: Pick<SessionEntry, "createdActor" | "visibility" | "incognito">;
};
type MentionReader = { profile: MentionProfile; canRead: (target: MentionTarget) => boolean };

function scopesAllowRead(scopes: readonly string[]): boolean {
  return roleScopesAllow({
    role: "operator",
    requestedScopes: [READ_SCOPE],
    allowedScopes: scopes,
  });
}

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
      pruneMapToMaxSize(displays, MAX_DIRECTORY_PROFILES - 1);
      displays.set(profileId, profile);
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
      !scopesAllowRead(client.connect.scopes ?? [])
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
    if (policy && !scopesAllowRead(policy.scopes)) {
      return err(errorShape(ErrorCodes.FORBIDDEN, "Your operator role cannot read mentions."));
    }
    const admin =
      client.connect.scopes?.includes(ADMIN_SCOPE) &&
      (!policy || policy.scopes.includes(ADMIN_SCOPE));
    // The reader lives for one synchronous projection, never across an await.
    const { entryFilter } = prepareSessionSharing({
      cfg,
      client: {
        connect: { ...client.connect, scopes: admin ? [ADMIN_SCOPE] : [READ_SCOPE] },
        internal: { operatorRoleActor: { kind: "operator", profileId: profile.profileId } },
      },
    });
    return ok({
      profile,
      canRead: (target) => entryFilter?.(target.sessionKey, target.entry) ?? true,
    });
  }

  function recipientProfile(
    profileId: string,
    target: MentionTarget,
    cfg: OpenClawConfig,
  ): MentionProfile | undefined {
    const profile = readProfile(profileId);
    // Administrator read access does not make incognito sessions eligible for mentions.
    if (!profile || target.entry.incognito === true || isIncognitoSessionKey(target.sessionKey)) {
      return undefined;
    }
    const policy = resolveOperatorRolePolicyForProfile(profile.profileId, cfg);
    const scopes = policy?.scopes ?? [READ_SCOPE];
    if (!scopesAllowRead(scopes)) {
      return undefined;
    }
    if (scopes.includes(ADMIN_SCOPE)) {
      return profile;
    }
    const entryFilter = createProfileSessionEntryFilter({
      profileId: profile.profileId,
      sessionCap: policy?.sessions.others,
    });
    return entryFilter(target.sessionKey, target.entry) ? profile : undefined;
  }

  function resolveContext(
    client: GatewayClient | null,
    input: UsersMentionableParams,
    cfg: OpenClawConfig,
  ): Result<{ target: MentionTarget; profile: MentionProfile }, ErrorShape> {
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
      const binding = captureIncognitoSessionSource({
        sessionKey: input.sessionKey,
        agentId: agent.agentId,
      });
      const resolved =
        binding && "kind" in binding
          ? null
          : resolveSessionSharingTarget({
              cfg,
              sessionKey: input.sessionKey,
              agentId: agent.agentId,
            });
      const target = resolved && {
        agentId: resolved.agentId,
        sessionKey: resolved.canonicalKey,
        entry: {
          createdActor: resolved.entry.createdActor,
          visibility: resolved.entry.visibility,
          incognito: resolved.entry.incognito,
        },
      };
      if (!target || !requester.canRead(target)) {
        return err(errorShape(ErrorCodes.INVALID_REQUEST, "Session was not found."));
      }
      return ok({ target, profile: requester.profile });
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
    target: {
      agentId: string;
      canonicalKey: string;
      entry: Pick<SessionEntry, "sessionId" | "createdActor" | "visibility" | "incognito">;
    } | null,
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
    recordCommittedInvolvement(input: MentionCommittedInput): void {
      if (isIncognitoSessionKey(input.sessionKey)) {
        return;
      }
      const cfg = params.getRuntimeConfig();
      const target = resolveSessionSharingTarget({
        cfg,
        sessionKey: input.sessionKey,
        agentId: input.agentId,
      });
      const profileIds = involvedProfiles(input, target, cfg);
      if (target && profileIds.length) {
        updateSessionProfileInvolvement(
          { agentId: target.agentId, sessionKey: target.storeKey, storePath: target.storePath },
          {
            expectedSessionId: input.sessionId,
            profileIds,
            change: { kind: "mention", source: input.committedSource },
          },
        );
      }
    },
    async recordCommittedInvolvementAsync(input: MentionCommittedInput): Promise<void> {
      const cfg = params.getRuntimeConfig();
      const agent = resolveRequestedSessionAgentId(cfg, input.sessionKey, input.agentId);
      if (!agent.ok || isIncognitoSessionKey(input.sessionKey)) {
        return;
      }
      const facts = await prepareSessionMutationFacts({
        cfg,
        sessionKey: input.sessionKey,
        agentId: agent.agentId,
        allowMissing: true,
      });
      try {
        const target = facts.readCurrent(params.getRuntimeConfig()).target;
        const profileIds = involvedProfiles(input, target, params.getRuntimeConfig());
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
              const currentCfg = params.getRuntimeConfig();
              const current = facts.readCurrent(currentCfg).target;
              if (
                !active ||
                !isDeepStrictEqual(involvedProfiles(input, current, currentCfg), profileIds)
              ) {
                throw new Error("Committed mention authority changed before involvement commit");
              }
            },
          },
        );
        if (!accepted) {
          throw new Error("Committed mention involvement was refused for a changed session");
        }
      } finally {
        facts.release();
      }
    },
    identify,
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
    ): Result<UsersMentionableResult, ErrorShape> {
      const cfg = params.getRuntimeConfig();
      const context = resolveContext(client, input, cfg);
      if (!context.ok) {
        return context;
      }
      const { target, profile } = context.value;
      if (!directory) {
        throw new Error("The mention directory has not been prepared.");
      }
      // Keystrokes reuse one bounded eligible roster; identity/session/role changes replace it.
      const key = JSON.stringify([profileVersion, target, cfg.gateway?.roles]);
      if (eligibleDirectory?.key !== key) {
        const users = directory.profiles.flatMap(({ id, logins }) => {
          const candidate = recipientProfile(id, target, cfg);
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
    ): Result<readonly string[], ErrorShape> {
      if (profileIds.length === 0) {
        return ok([]);
      }
      const cfg = params.getRuntimeConfig();
      const context = resolveContext(client, input, cfg);
      if (!context.ok) {
        return context;
      }
      const { target, profile } = context.value;
      const recipients = new Set<string>();
      for (const id of profileIds) {
        const candidate = recipientProfile(id, target, cfg);
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
