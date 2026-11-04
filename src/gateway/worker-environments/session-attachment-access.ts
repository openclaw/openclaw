import { isDeepStrictEqual } from "node:util";
import type { createWorkerProviderLifecycle } from "./provider-lifecycle.js";
import type {
  WorkerEnvironmentAttachment,
  WorkerEnvironmentAttachmentRecord,
  WorkerEnvironmentSessionIdentity,
  WorkerEnvironmentSessionCreateRequest,
} from "./session-attachment.js";
import type { createSessionGuestAuthorityOwner } from "./session-guest-authority-owner.js";
import { readSessionGuestBinding } from "./session-guest.js";
import type { WorkerEnvironmentStore } from "./store.js";

/** Derived attachment access; session lifecycle and the store continue to own authoritative state. */
export function createSessionAttachmentAccess(options: {
  store: WorkerEnvironmentStore;
  closingAttachments: ReadonlyMap<string, number>;
  currentSession: (identity: WorkerEnvironmentSessionIdentity) => boolean;
  isStopping: () => boolean;
  inspectLease: ReturnType<typeof createWorkerProviderLifecycle>["inspectTurnLease"];
  guestAuthorities: Pick<
    ReturnType<typeof createSessionGuestAuthorityOwner>,
    "get" | "assertPrincipal"
  >;
}) {
  const { store, closingAttachments, currentSession, guestAuthorities } = options;
  const assertGuestPrincipal = guestAuthorities.assertPrincipal;
  const project = (
    record: WorkerEnvironmentAttachmentRecord | undefined,
    prepared?: WorkerEnvironmentSessionIdentity,
  ): WorkerEnvironmentAttachment | undefined => {
    if (
      !record ||
      record.closedAtMs !== null ||
      closingAttachments.has(record.sessionId) ||
      options.isStopping() ||
      !(prepared
        ? record.sessionId === prepared.sessionId &&
          record.sessionKey === prepared.sessionKey &&
          record.agentId === prepared.agentId &&
          record.sessionLifecycleRevision === prepared.sessionLifecycleRevision
        : currentSession(record))
    ) {
      return undefined;
    }
    const environment = store.get(record.environmentId);
    if (
      !environment ||
      (environment.state !== "ready" && environment.state !== "idle") ||
      environment.destroyRequestedAtMs !== null
    ) {
      return undefined;
    }
    const guest = readSessionGuestBinding(environment.profileSnapshot);
    if (prepared?.requiresIsolatedEnvironment && !guest) {
      return undefined;
    }
    if (guest) {
      const held = guestAuthorities.get(environment.environmentId);
      if (!held || (prepared && prepared.principalId !== guest.profileId)) {
        return undefined;
      }
      try {
        held.authority.assertCurrent();
      } catch {
        return undefined;
      }
    }
    return {
      ...(prepared?.principalId ? { principalId: prepared.principalId } : {}),
      ...(prepared?.requiresIsolatedEnvironment
        ? { requiresIsolatedEnvironment: true as const }
        : {}),
      ...(guest ? { guest: true as const } : {}),
      sessionId: record.sessionId,
      sessionKey: record.sessionKey,
      agentId: record.agentId,
      ...(record.sessionLifecycleRevision
        ? { sessionLifecycleRevision: record.sessionLifecycleRevision }
        : {}),
      environmentId: record.environmentId,
      generation: record.generation,
      ownerEpoch: environment.ownerEpoch,
    };
  };
  const assertSessionAttachment = (
    binding: WorkerEnvironmentAttachment,
    prepared?: WorkerEnvironmentSessionIdentity,
  ) => {
    assertGuestPrincipal(
      binding.environmentId,
      binding.sessionId,
      prepared?.principalId ?? binding.principalId,
      prepared?.requiresIsolatedEnvironment ?? binding.requiresIsolatedEnvironment,
    );
    const current = project(store.getSessionAttachmentRecord(binding.sessionId), prepared);
    if (
      !current ||
      current.environmentId !== binding.environmentId ||
      current.ownerEpoch !== binding.ownerEpoch ||
      current.generation !== binding.generation ||
      current.agentId !== binding.agentId ||
      current.sessionKey !== binding.sessionKey ||
      current.sessionLifecycleRevision !== binding.sessionLifecycleRevision
    ) {
      throw new Error("Conversation environment attachment is no longer current");
    }
  };
  const touchSessionAttachment = async (
    binding: WorkerEnvironmentAttachment,
    assertCurrent: () => void = () => assertSessionAttachment(binding),
  ) => {
    await store.ready();
    assertCurrent();
    const environment = store.get(binding.environmentId);
    if (environment && readSessionGuestBinding(environment.profileSnapshot)) {
      if (!environment.leaseId || environment.ownerEpoch !== binding.ownerEpoch) {
        throw new Error("Conversation environment lease is no longer current");
      }
      await options.inspectLease({
        environmentId: environment.environmentId,
        ownerEpoch: environment.ownerEpoch,
        leaseId: environment.leaseId,
        assertCurrent,
        signal: guestAuthorities.get(binding.environmentId)?.authority.signal,
        sessionAccess: true,
      });
      assertCurrent();
    }
    await store.touchSessionAttachment(
      store.getSessionAttachmentRecord(binding.sessionId)!,
      assertCurrent,
    );
    assertCurrent();
  };
  const captureSessionAttachment = (identity: WorkerEnvironmentSessionIdentity) => {
    // Admission already read the canonical session. Its identity plus synchronous
    // retirement fences avoid repeating that SQLite read on each proxy connection.
    const binding = project(store.getSessionAttachmentRecord(identity.sessionId), identity);
    if (!binding) {
      throw new Error("No current environment is attached to this conversation");
    }
    const assertCurrent = () => assertSessionAttachment(binding, identity);
    return {
      binding,
      signal: guestAuthorities.get(binding.environmentId)?.authority.signal,
      assertCurrent,
      touch: () => touchSessionAttachment(binding, assertCurrent),
    };
  };

  return { project, assertSessionAttachment, touchSessionAttachment, captureSessionAttachment };
}

/** Select and validate an existing attachment; allocation/reconciliation remain controller-owned. */
export function selectReusableSessionAttachment(
  attachment: WorkerEnvironmentAttachmentRecord | undefined,
  environment: ReturnType<WorkerEnvironmentStore["get"]>,
  request: WorkerEnvironmentSessionCreateRequest,
) {
  if (
    !attachment ||
    !environment ||
    attachment.closedAtMs !== null ||
    ["destroyed", "failed", "orphaned"].includes(environment.state)
  ) {
    return undefined;
  }
  if (
    environment.profileId !== request.profileId ||
    (request.machineClass !== undefined &&
      environment.profileSnapshot.machineClass !== request.machineClass) ||
    (request.os !== undefined && environment.profileSnapshot.os !== request.os) ||
    (request.resources !== undefined &&
      !isDeepStrictEqual(environment.profileSnapshot.resources, request.resources))
  ) {
    throw new Error(
      "Conversation already owns a different environment; stop it before selecting another profile or machine",
    );
  }
  if (environment.destroyRequestedAtMs !== null) {
    throw new Error("Conversation environment is stopping");
  }
  const guest = readSessionGuestBinding(environment.profileSnapshot);
  if (guest && (guest.profileId !== request.principalId || guest.sessionId !== request.sessionId)) {
    throw new Error("Conversation environment belongs to another guest");
  }
  return { attachment, environment, guest };
}
