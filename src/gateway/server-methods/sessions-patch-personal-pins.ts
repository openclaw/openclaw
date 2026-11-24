import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionsPatchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  DEFAULT_RAIL_SHORTCUTS,
  parseSidebarSessionReference,
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
import { usesLegacySessionPins } from "../session-pin-compatibility.js";
import { resolvePluginSessionOwnershipError } from "../session-plugin-ownership.js";
import type { SessionSharingTarget } from "../session-sharing-policy.js";
import {
  prepareProjectedSessionSharing,
  prepareSessionSharingProfiles,
} from "../session-sharing-read.js";
import { isSameSessionSharingTarget } from "../session-sharing-target-read.js";
import { resolveRequestedSessionStoreTarget } from "../session-store-key.js";
import { PERSONAL_PIN_PROFILE_REQUIRED, sessionPinRequester } from "./session-pin-requester.js";
import type { SessionPatchTargetIdentity } from "./session-unread-ack.js";
import { sessionChangedError } from "./sessions-patch-errors.js";
import { resolveSessionPatchTargetError } from "./sessions-patch-expectations.js";
import { prepareSessionSharingAccess } from "./sessions-sharing-authority.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import { publishUserPreferencesChanged } from "./user-preference-events.js";

const pinFields = new Set([
  "key",
  "agentId",
  "pinned",
  "pinPlacement",
  "expectedSessionId",
  "expectedLifecycleRevision",
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
  if (
    patch.pinPlacement &&
    (many ||
      patch.pinned !== true ||
      !patch.expectedSessionId ||
      usesLegacySessionPins(options.client))
  ) {
    return respond(
      false,
      undefined,
      reject("Pin placement requires a personal pinned:true patch with expectedSessionId."),
    );
  }
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
  const accepted = new Map<string, { target: SessionSharingTarget; assertCurrent: () => void }>();
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
      const assertCurrent = () => {
        owner.assertCurrent();
        profiles.readCurrent();
        for (const item of accepted.values()) {
          item.assertCurrent();
        }
      };
      const prefs = await getCanonicalUserPreferences(owner.profileId, [preferenceKey]);
      assertCurrent();
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
      const next = setPersonalSessionPins(entries, [...accepted.keys()], pinned);
      if (patch.pinPlacement) {
        const { relativeTo, side } = patch.pinPlacement;
        // Only a session: entry is a named destination. A rail-only shortcut cannot stand in for it.
        const anchor = entries.findIndex(
          (entry) =>
            typeof entry === "string" &&
            entry.startsWith("session:") &&
            parseSidebarSessionReference(entry) === relativeTo,
        );
        if (anchor < 0 || next.length === entries.length) {
          return respond(
            false,
            undefined,
            reject("Pin placement changed. Refresh the list and retry."),
          );
        }
        // A guarded placement is single-target and inserts only an initially unpinned row.
        const added = next.pop();
        next.splice(anchor + (side === "after" ? 1 : 0), 0, added);
      }
      if (next.length !== entries.length) {
        const result = await setCanonicalUserPreferences(
          owner.profileId,
          { [preferenceKey]: next },
          { expectedEntries: { [preferenceKey]: raw ?? null }, assertCurrent },
        );
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
