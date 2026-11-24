import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  ErrorCodes,
  type SessionsPatchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { ArchivePinStatus } from "../../../packages/gateway-protocol/src/schema/sessions-patch.js";
import {
  parseSidebarSessionReference,
  UI_RAIL_SHORTCUTS_PREFERENCE_KEY as preferenceKey,
} from "../../../packages/gateway-protocol/src/schema/ui-navigation-preferences.js";
import { safeEqualSecret } from "../../security/secret-equal.js";
import {
  getCanonicalUserPreferences,
  setCanonicalUserPreferences,
} from "../../state/user-preferences.js";
import { usesLegacySessionPins } from "../session-pin-compatibility.js";
import type { SessionSharingTarget } from "../session-sharing-target.types.js";
import { isSyntheticGatewayCaller } from "./gateway-personal-caller.js";
import { respondError } from "./response.js";
import { sessionPinRequester } from "./session-pin-requester.js";
import type { SessionPatchTargetIdentity } from "./session-unread-ack.js";
import type { MutationOutcome, PreparedPatchTarget } from "./sessions-patch-types.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import { publishUserPreferencesChanged } from "./user-preference-events.js";

export function archivePinRequester(options: GatewayRequestHandlerOptions) {
  const { client } = options;
  if (!client?.connId || isSyntheticGatewayCaller(client) || usesLegacySessionPins(client)) {
    return undefined;
  }
  const owner = sessionPinRequester(options);
  return owner && { ...owner, connId: client.connId };
}

const archiveOnlyFields = new Set([
  "key",
  "agentId",
  "archived",
  "retirePersonalPin",
  "expectedSessionId",
  "expectedArchived",
  "expectedLifecycleRevision",
]);

type ArchiveOwner = NonNullable<ReturnType<typeof archivePinRequester>>;
type Slot = [retainedBefore: number, original: string, target: string];

// The client holds the short-lived receipt; the Gateway stores neither layouts nor pending Undos.
// Bind only the actual removals to the connection, profile and exact *post*-archive layout.
const receiptKey = randomBytes(32);
function signature(owner: ArchiveOwner, layout: readonly unknown[], slots: string) {
  return createHmac("sha256", receiptKey)
    .update(JSON.stringify([owner.connId, owner.profileId, layout, slots]))
    .digest("base64url");
}
function targetId(storePath: string, agentId: string, key: string, sessionId: string) {
  return createHash("sha256")
    .update(JSON.stringify([storePath, agentId, key, sessionId]))
    .digest("base64url");
}

/** Read the intent base before the lifecycle operation can yield to a competing layout edit. */
export async function prepareArchivePins(
  options: GatewayRequestHandlerOptions,
  patch: Partial<SessionsPatchParams>,
  requested: readonly SessionPatchTargetIdentity[],
) {
  if (
    patch.archived !== true ||
    Object.keys(patch).some((key) => !archiveOnlyFields.has(key)) ||
    requested.some((target) => target.expectedArchived === true)
  ) {
    respondError(
      options.respond,
      ErrorCodes.INVALID_REQUEST,
      "Retiring a personal pin requires an archive-only patch on an active thread.",
    );
    return undefined;
  }
  const owner = archivePinRequester(options);
  if (!owner) {
    respondError(
      options.respond,
      ErrorCodes.FORBIDDEN,
      "Personal archive requires a signed-in connection with personal session pins.",
    );
    return undefined;
  }
  const prefs = await getCanonicalUserPreferences(owner.profileId, [preferenceKey]).catch(
    () => undefined,
  );
  const layout: unknown =
    prefs?.profileId === owner.profileId ? (prefs.entries[preferenceKey] ?? []) : undefined;
  const status = new Map<number, ArchivePinStatus>();
  let undo: string | undefined;
  return {
    receipt(index: number, archivedAt: number | undefined) {
      return { archivePin: status.get(index) ?? "unknown", archivedAt };
    },
    get undo() {
      return undo ? { archivePinUndo: undo } : {};
    },
    // The mutation owner still holds the selected lifecycle targets here, *after* their SQLite commits.
    async retire(
      targets: readonly PreparedPatchTarget[],
      outcomes: readonly (MutationOutcome | undefined)[],
    ) {
      if (!Array.isArray(layout)) {
        return;
      }
      const committed = new Map<string, { index: number; id: string }>();
      for (const { canonicalKey, index, storePath, targetAgentId } of targets) {
        const outcome = outcomes[index];
        if (outcome?.ok && outcome.applied && outcome.entry.archivedAt !== undefined) {
          status.set(index, "unchanged");
          committed.set(canonicalKey, {
            index,
            id: targetId(storePath, targetAgentId, canonicalKey, outcome.entry.sessionId),
          });
        }
      }
      const slots: Slot[] = [];
      const removed = new Set<number>();
      const next = layout.filter((entry, index) => {
        const key =
          typeof entry === "string" &&
          entry.startsWith("session:") &&
          parseSidebarSessionReference(entry);
        const target = key && committed.get(key);
        if (!target) {
          return true;
        }
        slots.push([index - slots.length, entry, target.id]);
        removed.add(target.index);
        return false;
      });
      if (!slots.length) {
        return;
      }
      const result = await setCanonicalUserPreferences(
        owner.profileId,
        { [preferenceKey]: next },
        {
          assertCurrent: owner.assertCurrent,
          expectedEntries: { [preferenceKey]: layout },
        },
      ).catch(() => undefined);
      for (const index of removed) {
        status.set(
          index,
          result?.ok ? "removed" : result?.error.code === "conflict" ? "conflict" : "unknown",
        );
      }
      if (result?.ok) {
        const payload = JSON.stringify(slots);
        undo = `${signature(owner, next, payload)}.${payload}`;
        publishUserPreferencesChanged(options.context, result.value.profileId, [preferenceKey]);
      }
    },
  };
}

/** Existing pin-only admission guards the live targets; the preference writer CAS checks this same layout. */
export function restoreArchivePinSlots(
  receipt: string,
  owner: ArchiveOwner,
  layout: unknown,
  targets: Iterable<{ target: SessionSharingTarget }>,
): unknown[] | undefined {
  if (!Array.isArray(layout)) {
    return undefined;
  }
  const split = receipt.indexOf(".");
  const payload = receipt.slice(split + 1);
  if (split < 0 || !safeEqualSecret(receipt.slice(0, split), signature(owner, layout, payload))) {
    return undefined;
  }
  // Only our signed original slots reach the decoder. A mixed restore can select a subset.
  const slots: Slot[] = JSON.parse(payload);
  const wanted = new Set(
    Array.from(targets, ({ target }) =>
      targetId(target.storePath, target.agentId, target.canonicalKey, target.entry.sessionId),
    ),
  );
  const restored = new Set<string>();
  const next: unknown[] = [...layout];
  let inserted = 0;
  for (const [before, original, id] of slots) {
    if (wanted.has(id)) {
      next.splice(before + inserted++, 0, original);
      restored.add(id);
    }
  }
  return restored.size === wanted.size ? next : undefined;
}
