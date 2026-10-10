import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { assertAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import {
  bindReplyToolAuthorityCallerRead,
  prepareReplyToolAuthorityCallerRead,
} from "../../agents/harness/host-private-capabilities.js";
import type {
  ReplyOperation,
  ReplyToolAuthoritySnapshot,
  ReplyTurnParticipant,
  ReplyTurnParticipants,
} from "./reply-run-registry.contracts.js";

/** Personal targets belong to the admitted turn, independently of its concrete backend attempts. */
export function createReplyTurnParticipants(
  owner: ReplyToolAuthoritySnapshot["personalToolOwner"],
): ReplyTurnParticipants {
  const participants = new Map<string, ReplyTurnParticipant>();
  const releases = new Map<string, () => void>();
  let closed = false;
  const add = (input: NonNullable<typeof owner>) => {
    const authority = input.operatorAuthority;
    if (!authority) {
      return;
    }
    assertAdmittedRunOperatorAuthority(authority);
    const senderId = input.senderId ?? authority.profileId;
    const name = input.senderName ?? senderId;
    let retentionFailed = false;
    try {
      const release = authority.retain?.();
      releases.get(authority.profileId)?.();
      releases.delete(authority.profileId);
      if (release) {
        releases.set(authority.profileId, release);
      }
    } catch {
      // Accepted input stays ambiguous even if its source was revoked at acceptance.
      retentionFailed = true;
    }
    participants.set(
      authority.profileId,
      Object.freeze({
        profileId: authority.profileId,
        senderId,
        name,
        operatorAuthority: authority,
        gatewayUiCommandTarget: input.gatewayUiCommandTarget
          ? Object.freeze({ ...input.gatewayUiCommandTarget })
          : undefined,
        assertCurrent: () => {
          if (closed) {
            throw new Error("This turn has ended; ask again in a new turn.");
          }
          try {
            if (retentionFailed) {
              throw new Error("Participant authority could not be retained");
            }
            authority.assertCurrent();
          } catch {
            throw new Error(`${name}'s access changed; ask them again`);
          }
        },
      }),
    );
  };
  if (owner) {
    add(owner);
  }
  function resolve(
    user?: string,
    options?: { allowTurnOwner?: () => boolean },
  ): ReplyTurnParticipant | undefined {
    if (closed) {
      throw new Error("This turn has ended; ask again in a new turn.");
    }
    const people = [...participants.values()];
    const choices = people.map((person) => `${person.name} (user: ${person.profileId})`).join(", ");
    if (user === undefined && people.length > 1 && !options?.allowTurnOwner?.()) {
      throw new Error(
        `Several people have steered this turn: ${choices}. Pass the requester's requester_profile.id as user, or ask them if unclear.`,
      );
    }
    const person =
      user === undefined ? people[0] : people.find((candidate) => candidate.profileId === user);
    if (user !== undefined && !person) {
      throw new Error(
        `User is not a participant of this turn.${choices ? ` Choose ${choices}.` : " Ask again from your signed-in Control UI."}`,
      );
    }
    person?.assertCurrent();
    return person
      ? {
          ...person,
          assertCurrent: () => {
            // A steer can be accepted while a personal read or write awaits preparation.
            if (user === undefined && participants.size > 1) {
              resolve(user, options);
            }
            person.assertCurrent();
          },
        }
      : undefined;
  }
  return {
    accept(overlay) {
      if (
        !closed &&
        owner?.operatorAuthority &&
        overlay.operatorAuthority?.profileId !== owner.operatorAuthority.profileId
      ) {
        add(overlay);
      }
    },
    resolve,
    close() {
      if (closed) {
        return;
      }
      closed = true;
      participants.clear();
      for (const release of releases.values()) {
        release();
      }
      releases.clear();
    },
  };
}

type OperationToolAuthority = Pick<
  ReplyOperation,
  | "toolAuthorityFingerprint"
  | "toolAuthorityRoute"
  | "requestedToolAuthorityRoute"
  | "automaticFallbackRoute"
  | "bindToolAuthoritySnapshot"
  | "bindToolAuthoritySnapshotAsync"
  | "projectToolAuthorityFingerprint"
  | "projectToolAuthorityFingerprintAsync"
  | "bindToolAuthorityRoute"
  | "bindToolAuthorityRouteAsync"
  | "setAutomaticFallbackRoute"
  | "personalToolParticipants"
> & { bindBackendFingerprint(fingerprint: string | undefined): void; close(): void };

function normalizeToolAuthorityRoute(value: NonNullable<ReplyOperation["toolAuthorityRoute"]>) {
  const provider = normalizeOptionalString(value.provider);
  const model = normalizeOptionalString(value.model);
  if (!provider || !model) {
    throw new Error("Reply operation tool authority route is required");
  }
  return { provider, model };
}

/** Owns frozen policy, concrete attempt routing, and backend authority for one operation. */
export function createReplyOperationToolAuthority(lifecycle: {
  isOpen: () => boolean;
  ownsRunSlot: () => boolean;
  captureCurrent: () => () => void;
}): OperationToolAuthority {
  let fingerprint: string | undefined;
  let snapshot: ReplyToolAuthoritySnapshot | undefined;
  let route: ReplyOperation["toolAuthorityRoute"];
  let automaticFallbackRoute: ReplyOperation["automaticFallbackRoute"];
  let participants: ReplyTurnParticipants | undefined;

  const canInstallSnapshot = (value: ReplyToolAuthoritySnapshot) => {
    if (!lifecycle.isOpen() || (snapshot && snapshot !== value)) {
      throw new Error("Reply operation cannot change tool authority after admission");
    }
    return !snapshot;
  };
  function installSnapshot(value: ReplyToolAuthoritySnapshot, prepared: string) {
    if (!canInstallSnapshot(value)) {
      return;
    }
    const initialFingerprint = normalizeOptionalString(prepared);
    if (!initialFingerprint) {
      throw new Error("Reply operation tool authority fingerprint is required");
    }
    snapshot = value;
    fingerprint = initialFingerprint;
    participants = createReplyTurnParticipants(value.personalToolOwner);
  }

  const result: OperationToolAuthority = {
    get personalToolParticipants() {
      return participants;
    },
    close() {
      participants?.close();
    },
    get toolAuthorityFingerprint() {
      return fingerprint;
    },
    get toolAuthorityRoute() {
      return route;
    },
    get requestedToolAuthorityRoute() {
      return snapshot?.requestedRoute;
    },
    get automaticFallbackRoute() {
      return automaticFallbackRoute;
    },
    bindBackendFingerprint(value) {
      const backendFingerprint = normalizeOptionalString(value);
      if (lifecycle.isOpen() && backendFingerprint) {
        fingerprint = backendFingerprint;
      }
    },
    setAutomaticFallbackRoute(value) {
      if (lifecycle.isOpen() && lifecycle.ownsRunSlot()) {
        automaticFallbackRoute = value ? Object.freeze({ ...value }) : undefined;
      }
    },
    bindToolAuthoritySnapshot(value) {
      if (canInstallSnapshot(value)) {
        installSnapshot(value, value.fingerprint());
      }
    },
    async bindToolAuthoritySnapshotAsync(value) {
      const assertCurrent = lifecycle.captureCurrent();
      if (snapshot === value) {
        return;
      }
      if (snapshot) {
        throw new Error("Reply operation cannot change tool authority after admission");
      }
      // Released plugins may still supply the original two-method snapshot.
      const prepared = await (value.fingerprintAsync?.() ?? value.fingerprint());
      assertCurrent();
      installSnapshot(value, prepared);
    },
    projectToolAuthorityFingerprint(overlay) {
      if (!lifecycle.isOpen() || !snapshot || !route) {
        return undefined;
      }
      try {
        return normalizeOptionalString(snapshot.project(overlay, route));
      } catch {
        return undefined;
      }
    },
    async projectToolAuthorityFingerprintAsync(overlay) {
      if (!lifecycle.isOpen() || !snapshot || !route) {
        return undefined;
      }
      const selected = snapshot;
      const selectedRoute = route;
      const admittedFingerprint = fingerprint;
      try {
        const assertOwner = lifecycle.captureCurrent();
        const assertCurrent = () => {
          assertOwner();
          if (
            snapshot !== selected ||
            route !== selectedRoute ||
            fingerprint !== admittedFingerprint
          ) {
            throw new Error("Reply tool authority route changed during preparation");
          }
        };
        const prepared = await prepareReplyToolAuthorityCallerRead(
          selected.projectAsync,
          overlay,
          admittedFingerprint,
          selectedRoute,
          assertCurrent,
        );
        if (prepared) {
          await prepared.prepareCurrent();
          assertCurrent();
          return admittedFingerprint;
        }
        const current = await (selected.fingerprintAsync?.(selectedRoute) ??
          selected.fingerprint(selectedRoute));
        assertCurrent();
        const projected = await (selected.projectAsync?.(overlay, selectedRoute) ??
          selected.project(overlay, selectedRoute));
        assertCurrent();
        return current === admittedFingerprint ? normalizeOptionalString(projected) : undefined;
      } catch {
        return undefined;
      }
    },
    bindToolAuthorityRoute(value) {
      if (!lifecycle.isOpen() || !snapshot || !lifecycle.ownsRunSlot()) {
        throw new Error("Reply operation has no active tool authority snapshot");
      }
      const preparedRoute = normalizeToolAuthorityRoute(value);
      const preparedFingerprint = snapshot.fingerprint(preparedRoute);
      route = preparedRoute;
      fingerprint = preparedFingerprint;
      return fingerprint;
    },
    async bindToolAuthorityRouteAsync(value) {
      const assertCurrent = lifecycle.captureCurrent();
      const selected = snapshot;
      const previousRoute = route;
      if (!selected || !lifecycle.ownsRunSlot()) {
        throw new Error("Reply operation has no active tool authority snapshot");
      }
      const preparedRoute = normalizeToolAuthorityRoute(value);
      const prepared = await (selected.fingerprintAsync?.(preparedRoute) ??
        selected.fingerprint(preparedRoute));
      assertCurrent();
      if (snapshot !== selected || route !== previousRoute) {
        throw new Error("Reply operation tool authority changed during preparation");
      }
      route = preparedRoute;
      fingerprint = prepared;
      return prepared;
    },
  };
  bindReplyToolAuthorityCallerRead(
    result.projectToolAuthorityFingerprintAsync,
    async (caller, expected, _route, assertActive) => {
      const selected = snapshot;
      const selectedRoute = route;
      const assertOwner = lifecycle.captureCurrent();
      const assertCurrent = () => {
        assertActive();
        assertOwner();
        if (
          !selected ||
          !selectedRoute ||
          snapshot !== selected ||
          route !== selectedRoute ||
          fingerprint !== expected
        ) {
          throw new Error("question creator reply authority is no longer active");
        }
      };
      assertCurrent();
      return await prepareReplyToolAuthorityCallerRead(
        selected?.projectAsync,
        caller,
        expected,
        selectedRoute,
        assertCurrent,
      );
    },
  );
  return result;
}
