import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionsPatchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  DEFAULT_RAIL_SHORTCUTS,
  setPersonalSessionPins,
  UI_RAIL_SHORTCUTS_PREFERENCE_KEY as preferenceKey,
} from "../../../packages/gateway-protocol/src/schema/ui-navigation-preferences.js";
import { retainPreparedSessionSharingFacts } from "../../config/sessions/session-accessor.sqlite-entry-cache.js";
import { isPinnableSessionEntry } from "../../config/sessions/session-pin-policy.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import {
  getCanonicalUserPreferences,
  setCanonicalUserPreferences,
} from "../../state/user-preferences.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { resolvePluginSessionOwnershipError } from "../session-plugin-ownership.js";
import type { SessionSharingTarget } from "../session-sharing-policy.js";
import {
  prepareProjectedSessionSharing,
  prepareSessionSharingProfiles,
} from "../session-sharing-read.js";
import { isSameSessionSharingTarget } from "../session-sharing-target-read.js";
import { resolveRequestedSessionStoreTarget } from "../session-store-key.js";
import { PERSONAL_PIN_PROFILE_REQUIRED, sessionPinRequester } from "./session-pin-requester.js";
import {
  SESSION_PATCH_ADDRESS_KEYS,
  type SessionPatchTargetIdentity,
} from "./session-unread-ack.js";
import { sessionChangedError } from "./sessions-patch-errors.js";
import { resolveSessionPatchTargetError } from "./sessions-patch-expectations.js";
import { prepareSessionSharingAccess } from "./sessions-sharing-authority.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import { publishUserPreferencesChanged } from "./user-preference-events.js";

const pinFields = new Set([
  ...SESSION_PATCH_ADDRESS_KEYS,
  "pinned",
  "expectedSidebarRoot",
  "expectedCategory",
  "expectedArchived",
]);
const reject = (message: string) => errorShape(ErrorCodes.INVALID_REQUEST, message);

/** Profile preferences and session metadata have different transaction owners. Never half-apply a mixed patch. */
export async function patchPersonalSessionPins(
  options: GatewayRequestHandlerOptions,
  targets: readonly SessionPatchTargetIdentity[],
  patch: Partial<SessionsPatchParams>,
  many: boolean,
) {
  const { respond, context } = options;
  const owner = sessionPinRequester(options);
  if (!owner) {
    return respond(
      false,
      undefined,
      errorShape(ErrorCodes.FORBIDDEN, PERSONAL_PIN_PROFILE_REQUIRED),
    );
  }
  if ([patch, ...targets].some((input) => Object.keys(input).some((key) => !pinFields.has(key)))) {
    return respond(
      false,
      undefined,
      reject("Send pinned separately from shared session settings and their preconditions."),
    );
  }
  const profiles = await prepareSessionSharingProfiles(options.client);
  const pinned = patch.pinned === true;
  const errors = new Map<number, ErrorShape>();
  const accepted = new Map<
    string,
    { index: number; target: SessionSharingTarget; assertCurrent: () => void }
  >();
  const releases: Array<() => void> = [];
  try {
    for (const [index, input] of targets.entries()) {
      const sessionKey = input.key.trim();
      const address = { sessionKey, agentId: input.agentId };
      const resolved = resolveRequestedSessionStoreTarget(
        context.getRuntimeConfig(),
        sessionKey,
        input.agentId,
      );
      if (!resolved.ok) {
        errors.set(index, resolved.error);
        continue;
      }
      const readTarget = options.sessionMutationAuthorization?.readTargetSharing;
      // The router already holds the exact physical store, including custom/aliased stores.
      // Direct handler callers without that witness must prepare their own equivalent read.
      const access = readTarget
        ? undefined
        : await prepareSessionSharingAccess(
            {
              ...options,
              ...address,
              prepareMembership: true,
              respond: (_ok, _value, error) => {
                if (error) {
                  errors.set(index, error);
                }
              },
            },
            () => {
              throw new Error("Session pin request ended.");
            },
          );
      if (access) {
        releases.push(access[Symbol.dispose]);
      }
      if (!readTarget && !access) {
        continue;
      }
      owner.assertCurrent();
      let initial: SessionSharingTarget;
      let current: () => SessionSharingTarget | null;
      try {
        if (many) {
          options.sessionMutationAuthorization?.assertTargetCurrent(address);
        } else {
          options.sessionMutationAuthorization?.assertCurrent();
        }
        const facts = readTarget?.(resolved.value);
        facts?.assertCurrent();
        const { target, sharing } = facts
          ? {
              target: facts.target,
              sharing: prepareProjectedSessionSharing({
                cfg: context.getCommittedRuntimeConfig?.() ?? context.getRuntimeConfig(),
                client: options.client,
                profiles,
                isMember: (_target, id) =>
                  facts.isMember?.(id) ?? facts.members.some((member) => member.identityId === id),
              }),
            }
          : access!.readCurrent();
        if (
          !target ||
          !sharing.canReadTarget(target) ||
          target.entry.incognito ||
          isIncognitoSessionKey(target.canonicalKey)
        ) {
          errors.set(index, reject("Session not found or not visible."));
          continue;
        }
        initial = target;
        if (facts) {
          // readTargetSharing reauthorizes fresh input. Retain its selected physical row,
          // not a new membership decision, across the profile preference transaction.
          if (!target.readSource) {
            errors.set(index, sessionChangedError(sessionKey));
            continue;
          }
          const row = retainPreparedSessionSharingFacts({
            databaseIdentity: `file:${target.readSource.databaseIdentity}`,
            sessionKey: target.storeKey,
            entry: target.entry,
            membership: new Set(),
          });
          releases.push(row.release);
          current = () => {
            facts.assertCurrent();
            const entry = row.readCurrent()?.entry;
            return entry ? { ...target, entry } : null;
          };
        } else {
          current = () => access!.readCurrent().target;
        }
      } catch (error) {
        // A stale target must not prevent another target in the batch from succeeding.
        if (!many || !(error instanceof SessionMutationAuthorizationChangedError)) {
          throw error;
        }
        errors.set(index, error.error);
        continue;
      }
      const check = (target: SessionSharingTarget | null) => {
        if (!target || target.entry.incognito || isIncognitoSessionKey(target.canonicalKey)) {
          return reject("Session not found or not visible.");
        }
        if (!isSameSessionSharingTarget(target, initial)) {
          return sessionChangedError(sessionKey);
        }
        const condition =
          resolveSessionPatchTargetError(target.entry, {
            key: sessionKey,
            fullPatch: { ...input, pinned },
          }) ??
          resolvePluginSessionOwnershipError({
            action: "patch",
            entry: target.entry,
            key: sessionKey,
            pluginOwnerId: options.client?.internal?.pluginRuntimeOwnerId,
          });
        if (condition) {
          return condition;
        }
        if (
          target.canonicalKey === "unknown" ||
          (target.canonicalKey === "global" &&
            context.getRuntimeConfig().session?.scope !== "global")
        ) {
          return reject("Select an agent-qualified session to manage its sidebar pin.");
        }
        if (pinned && target.entry.archivedAt !== undefined) {
          return reject("Cannot pin an archived session; restore it first.");
        }
        if (pinned && (target.entry.snoozedUntil ?? 0) > Date.now()) {
          return reject(
            "Wake the snoozed session first, then pin it. A personal pin cannot wake it for everyone.",
          );
        }
        if (pinned && !isPinnableSessionEntry(target.canonicalKey, target.entry)) {
          return reject("Cannot pin a child session; promote it or pin its parent instead.");
        }
        return undefined;
      };
      const error = check(initial);
      if (error) {
        errors.set(index, error);
        continue;
      }
      if (accepted.has(initial.canonicalKey)) {
        return respond(false, undefined, reject("Duplicate target."));
      }
      accepted.set(initial.canonicalKey, {
        index,
        target: initial,
        assertCurrent: () => {
          if (check(current())) {
            // The requester may no longer see the row. Do not disclose its new state.
            throw new SessionMutationAuthorizationChangedError(sessionChangedError(sessionKey));
          }
        },
      });
    }
    if (accepted.size) {
      profiles.admit();
      const recheck = () => {
        owner.assertCurrent();
        profiles.readCurrent();
        let stale: SessionMutationAuthorizationChangedError | undefined;
        for (const [key, item] of accepted) {
          try {
            item.assertCurrent();
          } catch (error) {
            if (!many || !(error instanceof SessionMutationAuthorizationChangedError)) {
              throw error;
            }
            errors.set(item.index, error.error);
            accepted.delete(key);
            stale = error;
          }
        }
        return stale;
      };
      const prefs = await getCanonicalUserPreferences(owner.profileId, [preferenceKey]);
      recheck();
      if (!prefs || prefs.profileId !== owner.profileId) {
        return respond(
          false,
          undefined,
          errorShape(ErrorCodes.FORBIDDEN, PERSONAL_PIN_PROFILE_REQUIRED),
        );
      }
      const raw = prefs.entries[preferenceKey];
      if (raw !== undefined && !Array.isArray(raw)) {
        return respond(
          false,
          undefined,
          reject("Invalid rail shortcuts. Repair the profile preference before editing pins."),
        );
      }
      const entries: unknown[] = raw ?? DEFAULT_RAIL_SHORTCUTS;
      while (accepted.size) {
        const next = setPersonalSessionPins(entries, [...accepted.keys()], pinned);
        if (next.length === entries.length) {
          break;
        }
        let refused: SessionMutationAuthorizationChangedError | undefined;
        let result: Awaited<ReturnType<typeof setCanonicalUserPreferences>>;
        try {
          result = await setCanonicalUserPreferences(
            owner.profileId,
            { [preferenceKey]: next },
            {
              expectedEntries: { [preferenceKey]: raw ?? null },
              assertCurrent: () => {
                const stale = recheck();
                if (stale) {
                  refused = stale;
                  throw stale;
                }
              },
            },
          );
        } catch (error) {
          // Only our own pre-write refusal permits a smaller batch with the original CAS.
          // Never replay an uncertain write, preference conflict, or requester-wide refusal.
          if (!refused || error !== refused) {
            throw error;
          }
          continue;
        }
        if (!result?.ok) {
          if (result?.error.code === "value-too-large") {
            return respond(
              false,
              undefined,
              reject(
                "Your sidebar is full. Remove an existing pin or rail shortcut and try again.",
              ),
            );
          }
          return respond(
            false,
            undefined,
            reject(
              result && result.error.code === "conflict"
                ? "Personal pins changed. Refresh the list and retry."
                : "Could not save personal pins.",
            ),
          );
        }
        publishUserPreferencesChanged(context, result.value.profileId, [preferenceKey]);
        break;
      }
    }
    if (many) {
      return respond(
        true,
        {
          outcomes: targets.map(({ key, agentId }, i) =>
            errors.has(i)
              ? { key, agentId, ok: false, error: errors.get(i) }
              : { key, agentId, ok: true },
          ),
        },
        undefined,
      );
    }
    const result = accepted.values().next().value;
    if (!result) {
      return respond(false, undefined, errors.get(0) ?? reject("Session not found."));
    }
    const { target } = result;
    return respond(
      true,
      {
        ok: true,
        key: target.canonicalKey,
        path: target.storePath,
        entry: { sessionId: target.entry.sessionId, updatedAt: target.entry.updatedAt, pinned },
      },
      undefined,
    );
  } finally {
    for (const release of releases) {
      release();
    }
  }
}
