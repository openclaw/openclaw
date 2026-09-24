import { AsyncLocalStorage } from "node:async_hooks";
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
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { readUserProfileVersion } from "../state/user-profile-events.js";
import type { CurrentUserProfileDisplay } from "./current-user-profile-display.types.js";
import {
  MAX_MENTION_POLICY_PROFILES_PER_READ,
  MAX_MENTION_POLICY_TARGETS,
  type HumanMentionProfileFacts,
  type HumanMentionPolicyReadResult,
} from "./human-mention-policy-read.types.js";
import {
  prepareHumanMentionTargets,
  type HumanMentionTargetInput,
  type HumanMentionTargetAuthority,
  type PreparedHumanMentionTarget,
} from "./human-mention-policy-targets.js";
import {
  readOperatorRolePolicyRevision,
  resolveOperatorRolePolicyForAssignment,
} from "./operator-role-policy.js";
import { ADMIN_SCOPE, READ_SCOPE } from "./operator-scopes.js";
import { authenticatedProfileUnavailableError } from "./server-methods/gateway-client-identity.js";
import { resolveOperatorSessionCreation } from "./server-methods/session-creation-provenance.js";
import type { GatewayClient } from "./server-methods/types.js";
import { prepareSessionCreatorProfile } from "./session-creator.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import {
  createProfileSessionEntryFilter,
  isSessionVisibilityAllowed,
  createSessionListEntryFilter,
  resolveSessionVisibility,
} from "./session-sharing.js";

export type HumanMentionPreparation = {
  profileIds?: readonly string[];
  targets?: readonly HumanMentionTargetInput[];
  directory?: boolean;
};

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

/** One caller owns preparation through selection/commit; the Inbox uses its FIFO. */
export function createHumanMentionPolicy(params: {
  getRuntimeConfig: () => OpenClawConfig;
  getClients: () => Iterable<GatewayClient>;
  getRetainedPreparation?: () => HumanMentionPreparation;
  onInvalidated?: () => void;
}) {
  let active = true;
  let profileVersion = -1;
  let roleVersion = -1;
  let targetConfig: OpenClawConfig | undefined;
  let targetRevision = 0;
  const stateContext = captureOpenClawStateWorkerContext();
  // Cached close custody belongs to this policy, not a requesting maintenance scope.
  const inOwnerContext = AsyncLocalStorage.snapshot();
  const profiles = new Map<string, HumanMentionProfileFacts>();
  const targets = new Map<string, PreparedHumanMentionTarget | null>();
  const targetAuthorities = new Map<HumanMentionTargetAuthority, Set<string>>();
  let directory: HumanMentionPolicyReadResult["directory"];
  let eligibleDirectory:
    | { key: string; users: (MentionableUser & { logins: string[] })[]; truncated: boolean }
    | undefined;
  const targetKey = (target: HumanMentionTargetInput) =>
    JSON.stringify([target.agentId, target.sessionKey]);
  function releaseUncachedTargetAuthorities() {
    for (const [authority, keys] of targetAuthorities) {
      for (const key of keys) {
        if (!targets.has(key)) {
          keys.delete(key);
        }
      }
      if (!keys.size) {
        authority.dispose();
        targetAuthorities.delete(authority);
      }
    }
  }
  const invalidateTargets = (sessionKey?: string) => {
    targetRevision++;
    for (const [key, target] of targets) {
      if (!sessionKey || !target || target.storeKeys.includes(sessionKey)) {
        targets.delete(key);
      }
    }
    releaseUncachedTargetAuthorities();
    eligibleDirectory = undefined;
    params.onInvalidated?.();
  };
  const stopRows = sessionChanges.subscribe(() => invalidateTargets());
  const stopSessions = onSessionIdentityMutation(() => invalidateTargets());

  function synchronizeProfileVersion(): void {
    if (active) {
      stateContext.admission.assertCurrent();
    }
    const version = readUserProfileVersion();
    const roles = readOperatorRolePolicyRevision();
    if (profileVersion !== version || roleVersion !== roles) {
      profileVersion = version;
      roleVersion = roles;
      profiles.clear();
      directory = undefined;
      eligibleDirectory = undefined;
      params.onInvalidated?.();
    }
    const cfg = params.getRuntimeConfig();
    if (targetConfig !== cfg) {
      targetConfig = cfg;
      invalidateTargets();
    }
  }

  function preparationCohort(input: HumanMentionPreparation) {
    synchronizeProfileVersion();
    synchronizeTargetAuthority();
    const retained = params.getRetainedPreparation?.();
    const profileIds = new Set([
      ...(retained?.profileIds ?? []),
      ...(input.profileIds ?? []),
      ...(directory?.profiles.map(({ id }) => id) ?? []),
    ]);
    for (const client of params.getClients()) {
      const id = client.authenticatedUserProfile?.profileId;
      if (id) {
        profileIds.add(id);
      }
    }
    const requiredTargets = new Map(
      [...(retained?.targets ?? []), ...(input.targets ?? [])].map((target) => [
        targetKey(target),
        target,
      ]),
    );
    // Keep only live ownership: retained source recipients (including tombstones),
    // active senders/targets, the bounded directory, current clients and this operation.
    // Canonical facts share the same object as their requested alias; creator alias
    // lists stay complete. FIFO ownership prevents pruning another operation's facts.
    const keepProfiles = new Set(profileIds);
    for (const id of profileIds) {
      const display = profiles.get(id)?.display;
      if (display?.kind === "resolved") {
        keepProfiles.add(display.profileId);
      }
    }
    for (const id of profiles.keys()) {
      if (!keepProfiles.has(id)) {
        profiles.delete(id);
      }
    }
    for (const key of targets.keys()) {
      if (!requiredTargets.has(key)) {
        targets.delete(key);
      }
    }
    releaseUncachedTargetAuthorities();
    return { profileIds: [...profileIds], targets: [...requiredTargets.values()] };
  }

  function needsPreparation(input: HumanMentionPreparation = {}): boolean {
    if (!active) {
      return false;
    }
    const cohort = preparationCohort(input);
    return (
      Boolean(input.directory && !directory) ||
      cohort.profileIds.some((id) => !profiles.has(id)) ||
      cohort.targets.some((target) => !targets.has(targetKey(target)))
    );
  }

  function synchronizeTargetAuthority(): void {
    for (const authority of targetAuthorities.keys()) {
      try {
        authority.assertCurrent();
      } catch {
        invalidateTargets();
        break;
      }
    }
  }

  async function prepare(input: HumanMentionPreparation = {}): Promise<void> {
    if (!active) {
      return;
    }
    const cohort = preparationCohort(input);
    const version = profileVersion;
    const roles = roleVersion;
    const revision = targetRevision;
    const cfg = params.getRuntimeConfig();
    const profileIds = cohort.profileIds.filter((id) => !profiles.has(id));
    const targetInputs = cohort.targets.filter((target) => !targets.has(targetKey(target)));
    const includeDirectory = Boolean(input.directory && !directory);
    const acquired = new Set<HumanMentionTargetAuthority>();
    const readProfiles = async (): Promise<HumanMentionPolicyReadResult> => {
      const facts: HumanMentionPolicyReadResult = { profiles: [] };
      const readCount = Math.max(profileIds.length, includeDirectory ? 1 : 0);
      for (let offset = 0; offset < readCount; offset += MAX_MENTION_POLICY_PROFILES_PER_READ) {
        const batch = profileIds.slice(offset, offset + MAX_MENTION_POLICY_PROFILES_PER_READ);
        const readDirectory = offset === 0 && includeDirectory;
        const result = await executeExistingOpenClawStateRead(
          { path: stateContext.admission.databasePath, env: stateContext.environment },
          { type: "mentions.policy", input: { profileIds: batch, directory: readDirectory } },
          { context: stateContext, current: true },
        );
        stateContext.admission.assertCurrent();
        if (result && (!result.ok || result.type !== "mentions.policy")) {
          throw new Error("Mention profile policy is unavailable");
        }
        const prepared: HumanMentionPolicyReadResult =
          result?.ok && result.type === "mentions.policy"
            ? result.result
            : {
                profiles: batch.map((requestedId) => ({
                  requestedId,
                  display: { kind: "unresolved" },
                  role: null,
                  aliases: [],
                })),
                ...(readDirectory ? { directory: { profiles: [], truncated: false } } : {}),
              };
        facts.profiles.push(...prepared.profiles);
        if (prepared.directory) {
          facts.directory = prepared.directory;
        }
      }
      return facts;
    };
    const readTargets = async () => {
      const prepared: Array<{
        input: HumanMentionTargetInput;
        target: PreparedHumanMentionTarget | null;
        authority?: HumanMentionTargetAuthority;
      }> = [];
      for (let offset = 0; offset < targetInputs.length; offset += MAX_MENTION_POLICY_TARGETS) {
        const batch = targetInputs.slice(offset, offset + MAX_MENTION_POLICY_TARGETS);
        let authority: HumanMentionTargetAuthority | undefined;
        const values = await inOwnerContext(() =>
          prepareHumanMentionTargets(cfg, batch, (retained) => {
            authority = retained;
            acquired.add(retained);
          }),
        );
        stateContext.admission.assertCurrent();
        authority?.assertCurrent();
        for (const [index, target] of batch.entries()) {
          prepared.push({ input: target, target: values[index] ?? null, authority });
        }
      }
      return prepared;
    };
    try {
      // A failed sibling must settle before unadopted target custody can be released.
      const [profileRead, targetRead] = await Promise.allSettled([readProfiles(), readTargets()]);
      if (profileRead.status === "rejected") {
        throw profileRead.reason;
      }
      if (targetRead.status === "rejected") {
        throw targetRead.reason;
      }
      const facts = profileRead.value;
      const preparedTargets = targetRead.value;
      stateContext.admission.assertCurrent();
      synchronizeProfileVersion();
      if (!active) {
        return;
      }
      if (version === profileVersion && roles === roleVersion) {
        for (const fact of facts.profiles) {
          const canonicalId = fact.display.kind === "resolved" ? fact.display.profileId : undefined;
          const canonical = (canonicalId && profiles.get(canonicalId)) || fact;
          profiles.set(fact.requestedId, canonical);
          if (canonicalId) {
            profiles.set(canonicalId, canonical);
          }
        }
        if (facts.directory) {
          directory = facts.directory;
        }
      }
      if (revision === targetRevision && cfg === params.getRuntimeConfig()) {
        for (const authority of acquired) {
          authority.assertCurrent();
        }
        for (const prepared of preparedTargets) {
          const key = targetKey(prepared.input);
          targets.set(key, prepared.target);
          if (prepared.authority) {
            const keys = targetAuthorities.get(prepared.authority) ?? new Set<string>();
            keys.add(key);
            targetAuthorities.set(prepared.authority, keys);
          }
        }
      }
    } finally {
      for (const authority of acquired) {
        if (!targetAuthorities.has(authority)) {
          authority.dispose();
        }
      }
    }
  }

  function readProfile(profileId: string): MentionProfile | undefined {
    synchronizeProfileVersion();
    const profile = active ? profiles.get(profileId)?.display : undefined;
    return profile?.kind === "resolved" ? profile : undefined;
  }

  function rolePolicy(profileId: string, cfg: OpenClawConfig) {
    return resolveOperatorRolePolicyForAssignment(
      profileId,
      profiles.get(profileId)?.role ?? null,
      cfg,
    );
  }

  function creatorFilter(profileId: string) {
    return prepareSessionCreatorProfile(profileId, new Set(profiles.get(profileId)?.aliases ?? []));
  }

  function resolveTarget(
    input: HumanMentionTargetInput & { cfg?: OpenClawConfig },
  ): PreparedHumanMentionTarget | null {
    synchronizeProfileVersion();
    synchronizeTargetAuthority();
    if (
      !active ||
      (input.cfg && input.cfg !== params.getRuntimeConfig()) ||
      !targets.has(targetKey(input))
    ) {
      throw new Error("Mention session policy has not been prepared");
    }
    return targets.get(targetKey(input)) ?? null;
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
    const policy = rolePolicy(profile.profileId, cfg);
    if (policy && !scopesAllowRead(policy.scopes)) {
      return err(errorShape(ErrorCodes.FORBIDDEN, "Your operator role cannot read mentions."));
    }
    const admin =
      client.connect.scopes?.includes(ADMIN_SCOPE) &&
      (!policy || policy.scopes.includes(ADMIN_SCOPE));
    // The reader lives for one synchronous projection, never across an await.
    const entryFilter = createSessionListEntryFilter(
      {
        cfg,
        client: {
          connect: { ...client.connect, scopes: admin ? [ADMIN_SCOPE] : [READ_SCOPE] },
          internal: { operatorRoleActor: { kind: "operator", profileId: profile.profileId } },
        },
      },
      creatorFilter(profile.profileId),
      { sessionCap: policy?.sessions.others },
    );
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
    const policy = rolePolicy(profile.profileId, cfg);
    const scopes = policy?.scopes ?? [READ_SCOPE];
    if (!scopesAllowRead(scopes)) {
      return undefined;
    }
    if (scopes.includes(ADMIN_SCOPE)) {
      return profile;
    }
    const entryFilter = createProfileSessionEntryFilter(
      {
        profileId: profile.profileId,
        sessionCap: policy?.sessions.others,
      },
      creatorFilter(profile.profileId),
    );
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
      const resolved = resolveTarget({ sessionKey: input.sessionKey, agentId: input.agentId });
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
    const role = rolePolicy(requester.profile.profileId, cfg);
    if (role && role.agents !== "*" && !role.agents.includes(agent.agentId)) {
      return err(
        errorShape(
          ErrorCodes.FORBIDDEN,
          'Your operator role cannot create sessions for agent "' +
            agent.agentId +
            '"; choose an allowed agent or ask a gateway administrator to update your role.',
        ),
      );
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

  return {
    identify,
    prepare,
    needsPreparation,
    resolveTarget,
    readProfile,
    recipientProfile,
    invalidateTargets,
    dispose(): void {
      active = false;
      profiles.clear();
      invalidateTargets();
      stopRows();
      stopSessions();
      directory = undefined;
      eligibleDirectory = undefined;
    },
    mentionable(
      client: GatewayClient | null,
      input: UsersMentionableParams,
    ): Result<UsersMentionableResult, ErrorShape> {
      const cfg = params.getRuntimeConfig();
      // Incognito never has recipients. This non-disclosing answer does not open
      // the process-held database or attest that an arbitrary key exists.
      if ("sessionKey" in input && isIncognitoSessionKey(input.sessionKey)) {
        const requester = identify(client, cfg);
        return requester.ok ? ok({ users: [], truncated: false }) : requester;
      }
      const context = resolveContext(client, input, cfg);
      if (!context.ok) {
        return context;
      }
      const { target, profile } = context.value;
      if (!directory) {
        throw new Error("The mention directory has not been prepared.");
      }
      // Keystrokes reuse one bounded eligible roster; identity/session/role changes replace it.
      const key = JSON.stringify([profileVersion, roleVersion, target, cfg.gateway?.roles]);
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
