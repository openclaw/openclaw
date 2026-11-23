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
  const accesses: Array<NonNullable<Awaited<ReturnType<typeof prepareSessionSharingAccess>>>> = [];
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
        accesses.push(access);
      }
      if (!readTarget && !access) {
        continue;
      }
      const current = () => {
        if (!readTarget) {
          return access!.readCurrent();
        }
        const facts = readTarget(resolved.value);
        facts.assertCurrent();
        return {
          target: facts.target,
          sharing: prepareProjectedSessionSharing({
            cfg: context.getCommittedRuntimeConfig?.() ?? context.getRuntimeConfig(),
            client: options.client,
            profiles,
            isMember: (_target, id) =>
              facts.isMember?.(id) ?? facts.members.some((member) => member.identityId === id),
          }),
        };
      };
      let initial: SessionSharingTarget | null;
      try {
        initial = current().target;
      } catch (error) {
        // A stale target has no canonical sharing witness. It must not prevent a
        // different, admitted target from succeeding; final mutation fences still throw.
        if (!many || !(error instanceof SessionMutationAuthorizationChangedError)) {
          throw error;
        }
        errors.set(index, error.error);
        continue;
      }
      const check = () => {
        owner.assertCurrent();
        if (many) {
          options.sessionMutationAuthorization?.assertTargetCurrent({
            sessionKey,
            agentId: input.agentId,
          });
        } else {
          options.sessionMutationAuthorization?.assertCurrent();
        }
        const { target, sharing } = current();
        if (
          !target ||
          !initial ||
          !sharing.canReadTarget(target) ||
          target.entry.incognito ||
          isIncognitoSessionKey(target.canonicalKey)
        ) {
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
      const error = check();
      if (error || !initial) {
        errors.set(index, error ?? reject("Session not found."));
        continue;
      }
      if (accepted.has(initial.canonicalKey)) {
        return respond(false, undefined, reject("Duplicate target."));
      }
      accepted.set(initial.canonicalKey, {
        target: initial,
        assertCurrent: () => {
          const failure = check();
          if (failure) {
            throw new SessionMutationAuthorizationChangedError(failure);
          }
        },
      });
    }
    if (accepted.size) {
      const assertCurrent = () => {
        owner.assertCurrent();
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
      if (next.length !== entries.length) {
        const result = await setCanonicalUserPreferences(
          owner.profileId,
          { [preferenceKey]: next },
          { expectedEntries: { [preferenceKey]: raw ?? null }, assertCurrent },
        );
        if (!result?.ok) {
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
    for (const access of accesses) {
      access[Symbol.dispose]();
    }
  }
}
