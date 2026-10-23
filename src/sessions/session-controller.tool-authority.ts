import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { assertAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import {
  bindReplyToolAuthorityCallerRead,
  prepareReplyToolAuthorityCallerRead,
} from "../agents/harness/host-private-capabilities.js";
import {
  MessageInjectionPolicyMismatchError,
  MessageInjectionTargetUnavailableError,
} from "../auto-reply/reply/message-injection-authority.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import type {
  EmbeddedRunToolAuthorityBinding,
  ReplyOperation,
  ReplyToolAuthorityOverlay,
  ReplyToolAuthorityRequester,
  ReplyToolAuthoritySnapshot,
  ReplyTurnParticipant,
  ReplyTurnParticipants,
  SessionControllerEntry,
} from "./session-controller.contracts.js";
import {
  getAttachedBackend,
  getAttachedBackendAttachment,
  isCurrentSessionControllerOperation,
} from "./session-controller.state.js";

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
        requesterOrigin: input.requesterOrigin,
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
  | "projectRequesterToolAuthorityFingerprint"
  | "projectRequesterToolAuthorityFingerprintAsync"
  | "bindToolAuthorityRoute"
  | "bindToolAuthorityRouteAsync"
  | "setAutomaticFallbackRoute"
  | "personalToolParticipants"
  | "requesterPrincipalKey"
> & {
  bindBackendFingerprint(fingerprint: string | undefined): void;
  bindAttemptSnapshot(snapshot: ReplyToolAuthoritySnapshot): Promise<() => void>;
  close(): void;
};

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
  readOperation: () => ReplyOperation;
  readOwner: () => SessionControllerEntry;
}): OperationToolAuthority {
  const ownsRunSlot = () => lifecycle.readOwner().active === lifecycle.readOperation();
  const captureCurrent = () => {
    const operation = lifecycle.readOperation();
    const capturedOwner = lifecycle.readOwner();
    const key = operation.key;
    const id = operation.sessionId;
    const generation = operation.lifecycleGeneration;
    const backend = getAttachedBackend(operation);
    const assertCurrent = () => {
      if (
        lifecycle.readOwner() !== capturedOwner ||
        !isCurrentSessionControllerOperation(operation) ||
        !lifecycle.isOpen() ||
        operation.abortSignal.aborted ||
        operation.key !== key ||
        operation.sessionId !== id ||
        getAttachedBackend(operation) !== backend ||
        getAgentEventLifecycleGeneration() !== generation
      ) {
        throw new Error("Reply operation authority is no longer active");
      }
    };
    assertCurrent();
    return assertCurrent;
  };
  let fingerprint: string | undefined;
  let snapshot: ReplyToolAuthoritySnapshot | undefined;
  let requestedRoute: ReplyToolAuthoritySnapshot["requestedRoute"];
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
    requestedRoute ??= value.requestedRoute;
    fingerprint = initialFingerprint;
    participants ??= createReplyTurnParticipants(value.personalToolOwner);
  }

  const project = (caller: ReplyToolAuthorityOverlay | ReplyToolAuthorityRequester) => {
    if (!lifecycle.isOpen() || !snapshot || !route) {
      return undefined;
    }
    try {
      return normalizeOptionalString(
        "requesterOrigin" in caller
          ? snapshot.projectRequester?.(caller, route)
          : snapshot.project(caller, route),
      );
    } catch {
      return undefined;
    }
  };
  const projectAsync = async (caller: ReplyToolAuthorityOverlay | ReplyToolAuthorityRequester) => {
    if (!lifecycle.isOpen() || !snapshot || !route) {
      return undefined;
    }
    const selected = snapshot;
    const selectedRoute = route;
    const admittedFingerprint = fingerprint;
    try {
      const assertOwner = captureCurrent();
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
        "requesterOrigin" in caller ? selected.projectRequesterAsync : selected.projectAsync,
        caller,
        admittedFingerprint,
        selectedRoute,
        assertCurrent,
      );
      if (prepared) {
        await prepared.prepareCurrent();
        assertCurrent();
        return admittedFingerprint;
      }
      if (
        !selected.fingerprintAsync ||
        (!("requesterOrigin" in caller) && !selected.projectAsync)
      ) {
        warnPluginSdkDeprecation({
          family: "reply-tool-authority-sync-preparation",
          method: "ReplyToolAuthoritySnapshot.fingerprint/project",
          replacement: "implement fingerprintAsync() and projectAsync()",
        });
      }
      const current = await (selected.fingerprintAsync?.(selectedRoute) ??
        selected.fingerprint(selectedRoute));
      assertCurrent();
      const projected =
        "requesterOrigin" in caller
          ? await (selected.projectRequesterAsync?.(caller, selectedRoute) ??
              selected.projectRequester?.(caller, selectedRoute))
          : await (selected.projectAsync?.(caller, selectedRoute) ??
              selected.project(caller, selectedRoute));
      assertCurrent();
      return current === admittedFingerprint ? normalizeOptionalString(projected) : undefined;
    } catch {
      return undefined;
    }
  };

  const result: OperationToolAuthority = {
    get requesterPrincipalKey() {
      return snapshot?.requesterPrincipalKey;
    },
    get personalToolParticipants() {
      return participants;
    },
    close() {
      snapshot?.close?.();
      participants?.close();
    },
    get toolAuthorityFingerprint() {
      return fingerprint;
    },
    get toolAuthorityRoute() {
      return route;
    },
    get requestedToolAuthorityRoute() {
      return requestedRoute;
    },
    async bindAttemptSnapshot(value) {
      const assertCurrent = captureCurrent();
      if (snapshot) {
        throw new Error("Reply operation already owns an attempt tool authority snapshot");
      }
      await result.bindToolAuthoritySnapshotAsync(value);
      assertCurrent();
      return () => {
        if (snapshot !== value) {
          return;
        }
        // A direct retry prepares the successor's policy after the old attempt closes.
        value.close?.();
        snapshot = undefined;
        fingerprint = undefined;
        route = undefined;
      };
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
      if (lifecycle.isOpen() && ownsRunSlot()) {
        automaticFallbackRoute = value ? Object.freeze({ ...value }) : undefined;
      }
    },
    bindToolAuthoritySnapshot(value) {
      warnPluginSdkDeprecation({
        family: "reply-tool-authority-sync-preparation",
        method: "replyOperation.bindToolAuthoritySnapshot",
        replacement: "await bindToolAuthoritySnapshotAsync()",
      });
      if (canInstallSnapshot(value)) {
        installSnapshot(value, value.fingerprint());
      }
    },
    async bindToolAuthoritySnapshotAsync(value) {
      const assertCurrent = captureCurrent();
      if (snapshot === value) {
        return;
      }
      if (snapshot) {
        throw new Error("Reply operation cannot change tool authority after admission");
      }
      try {
        // Released plugins may still supply the original two-method snapshot.
        if (!value.fingerprintAsync) {
          warnPluginSdkDeprecation({
            family: "reply-tool-authority-sync-preparation",
            method: "ReplyToolAuthoritySnapshot.fingerprint",
            replacement: "implement fingerprintAsync() and projectAsync()",
          });
        }
        const prepared = await (value.fingerprintAsync?.() ?? value.fingerprint());
        assertCurrent();
        installSnapshot(value, prepared);
      } catch (error) {
        value.close?.();
        throw error;
      }
    },
    projectToolAuthorityFingerprint(overlay) {
      warnPluginSdkDeprecation({
        family: "reply-tool-authority-sync-preparation",
        method: "replyOperation.projectToolAuthorityFingerprint",
        replacement: "await projectToolAuthorityFingerprintAsync()",
      });
      return project(overlay);
    },
    projectToolAuthorityFingerprintAsync: projectAsync,
    projectRequesterToolAuthorityFingerprint: project,
    projectRequesterToolAuthorityFingerprintAsync: projectAsync,
    bindToolAuthorityRoute(value) {
      warnPluginSdkDeprecation({
        family: "reply-tool-authority-sync-preparation",
        method: "replyOperation.bindToolAuthorityRoute",
        replacement: "await bindToolAuthorityRouteAsync()",
      });
      if (!lifecycle.isOpen() || !snapshot || !ownsRunSlot()) {
        throw new Error("Reply operation has no active tool authority snapshot");
      }
      const preparedRoute = normalizeToolAuthorityRoute(value);
      const preparedFingerprint = snapshot.fingerprint(preparedRoute);
      route = preparedRoute;
      fingerprint = preparedFingerprint;
      return fingerprint;
    },
    async bindToolAuthorityRouteAsync(value) {
      const assertCurrent = captureCurrent();
      const selected = snapshot;
      const previousRoute = route;
      if (!selected || !ownsRunSlot()) {
        throw new Error("Reply operation has no active tool authority snapshot");
      }
      const preparedRoute = normalizeToolAuthorityRoute(value);
      if (!selected.fingerprintAsync) {
        warnPluginSdkDeprecation({
          family: "reply-tool-authority-sync-preparation",
          method: "ReplyToolAuthoritySnapshot.fingerprint",
          replacement: "implement fingerprintAsync() and projectAsync()",
        });
      }
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
      const assertOwner = captureCurrent();
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
        caller && "requesterOrigin" in caller
          ? selected?.projectRequesterAsync
          : selected?.projectAsync,
        caller,
        expected,
        selectedRoute,
        assertCurrent,
      );
    },
  );
  return result;
}

/** Bind current caller preparation to this exact captured execution and policy owner. */
export function bindCapturedReplyToolAuthorityCallerRead(params: {
  projector: object;
  operation: ReplyOperation;
  backendAttachment: NonNullable<ReturnType<typeof getAttachedBackendAttachment>>;
  toolAuthority?: ReturnType<EmbeddedRunToolAuthorityBinding>;
}): void {
  const { operation, backendAttachment, toolAuthority } = params;
  const attemptAuthority = toolAuthority?.source === "attempt";
  bindReplyToolAuthorityCallerRead(
    params.projector,
    async (caller, expected, _route, assertSource) => {
      const route = operation.toolAuthorityRoute;
      const assertCaptured = () => {
        assertSource();
        if (
          !isCurrentSessionControllerOperation(operation) ||
          operation.result ||
          operation.abortSignal.aborted ||
          (!attemptAuthority &&
            (operation.toolAuthorityRoute !== route ||
              operation.toolAuthorityFingerprint !== expected)) ||
          getAttachedBackendAttachment(operation) !== backendAttachment
        ) {
          throw new MessageInjectionTargetUnavailableError(
            "Reply steering target is no longer running",
          );
        }
        toolAuthority?.assertActive();
      };
      assertCaptured();
      if (!attemptAuthority && caller && "kind" in caller) {
        const selected = operation.requestedToolAuthorityRoute;
        const active = operation.toolAuthorityRoute;
        const fallback = operation.automaticFallbackRoute;
        const selectionChanged =
          selected !== undefined &&
          (selected.provider !== caller.selectedRoute.provider ||
            selected.model !== caller.selectedRoute.model);
        const activeDiffers =
          active !== undefined &&
          (active.provider !== caller.selectedRoute.provider ||
            active.model !== caller.selectedRoute.model);
        const compatibleFallback =
          selected &&
          !selectionChanged &&
          caller.fallbackAvailability.kind !== "disabled_by_model_override" &&
          caller.fallbackAvailability.kind !== "disabled_by_model_selection_lock" &&
          fallback?.provider === active?.provider &&
          fallback?.model === active?.model;
        if (selectionChanged || (activeDiffers && !compatibleFallback)) {
          throw new MessageInjectionPolicyMismatchError(
            "model-fallback-changed",
            "The selected model changed before steering",
          );
        }
      }
      return prepareReplyToolAuthorityCallerRead(
        toolAuthority?.projectAsync ?? operation.projectToolAuthorityFingerprintAsync,
        caller,
        expected,
        operation.toolAuthorityRoute,
        assertCaptured,
      );
    },
  );
}
