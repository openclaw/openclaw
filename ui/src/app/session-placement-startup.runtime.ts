import type { GatewaySessionRow } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../i18n/locales/en-new-session-setup.ts";
import type { ChatAttachment } from "../lib/chat/chat-types.ts";
import { formatUiError } from "../lib/format-error.ts";
import {
  createGatewayConnectionLifecycle,
  type GatewayConnectionScope,
} from "../lib/gateway-connection-lifecycle.ts";
import { areUiSessionKeysEquivalent } from "../lib/sessions/session-key.ts";
import {
  clearSessionPlacementRecovery,
  listSessionPlacementRecoveries,
  readSessionPlacementRecovery,
  type SessionPlacementRecovery,
  type SessionPlacementStartMode,
  type SessionPlacementPendingRecovery,
  type SessionPlacementPausedRecovery,
  pauseSessionPlacementRecovery,
  writeSessionPlacementRecoveryIfAvailable,
} from "../lib/sessions/session-placement-recovery.ts";
import { advanceSessionPlacementDraft } from "../lib/sessions/session-placement-submit.ts";
import { generateUUID } from "../lib/uuid.ts";
import { restoreChatApiAttachments } from "../pages/chat/attachment-restoration.ts";
import { buildInitialChatSubmission } from "../pages/chat/user-message-content.ts";
import { buildPlacementStartupInitialTurn } from "./session-placement-initial-turn.ts";
import {
  capturePlacementStartupConnection,
  type ApplicationPlacementStartupRuntime,
  type ApplicationPlacementStartupDependencies,
} from "./session-placement-startup.ts";

registerNewSessionSetupEnglish();

type PlacementStartupPhase = NonNullable<
  ReturnType<ApplicationPlacementStartupRuntime["get"]>
>["phase"];
type StartupPlacementPhase = Exclude<
  PlacementStartupPhase,
  "pending" | "sending" | "reconnecting" | "cancelled" | "failed"
>;

const STARTUP_PLACEMENT_STATES: ReadonlySet<string> = new Set<StartupPlacementPhase>([
  "requested",
  "provisioning",
  "syncing",
  "starting",
  "active",
]);

function isStartupPlacementPhase(value: string): value is StartupPlacementPhase {
  return STARTUP_PLACEMENT_STATES.has(value);
}

type PlacementStartupInput = Parameters<ApplicationPlacementStartupRuntime["start"]>[0];

type PlacementStartupOwner = Pick<
  SessionPlacementRecovery,
  "gatewayUrl" | "messageId" | "recoveryScope" | "sessionKey"
>;

type PlacementStartupEntry = {
  work:
    | { kind: "running"; recovery: SessionPlacementPendingRecovery }
    | { kind: "checking"; recovery: SessionPlacementRecovery }
    | { kind: "cancelled"; recovery: SessionPlacementRecovery }
    | { kind: "paused"; recovery: SessionPlacementPausedRecovery };
  readonly owner: PlacementStartupOwner;
  readonly attachments: ChatAttachment[];
  readonly persistRecovery: boolean;
  readonly createdAt: number;
  readonly scope: GatewayConnectionScope;
  readonly retainsConnection: () => boolean;
};

export default function createApplicationPlacementStartupRuntime(
  params: ApplicationPlacementStartupDependencies,
): ApplicationPlacementStartupRuntime {
  const listeners = new Set<() => void>();
  const entries = new Map<string, PlacementStartupEntry>();
  const connection = createGatewayConnectionLifecycle(params.gateway.snapshot);

  const publish = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const findEntry = (sessionKey: string) => {
    for (const [key, entry] of entries) {
      if (areUiSessionKeysEquivalent(key, sessionKey)) {
        return { key, entry };
      }
    }
    return null;
  };

  const ownsEntry = (entry: PlacementStartupEntry) =>
    findEntry(entry.owner.sessionKey)?.entry === entry;

  const lifecycleCurrent = (entry: PlacementStartupEntry) => {
    const snapshot = params.gateway.snapshot;
    return Boolean(
      entry.retainsConnection() &&
      connection.isCurrent(entry.scope) &&
      snapshot.client?.recoveryScopeReady,
    );
  };

  const ownsRecovery = (entry: PlacementStartupEntry) => {
    const stored = entry.persistRecovery
      ? readSessionPlacementRecovery(
          entry.owner.gatewayUrl,
          entry.owner.recoveryScope,
          entry.owner.sessionKey,
        )
      : null;
    return ownsEntry(entry) && (!stored || stored.messageId === entry.owner.messageId);
  };
  const isCurrent = (entry: PlacementStartupEntry) =>
    lifecycleCurrent(entry) && ownsRecovery(entry);

  const retireEntry = (entry: PlacementStartupEntry, notify = true) => {
    const found = findEntry(entry.owner.sessionKey);
    if (found?.entry !== entry) {
      return;
    }
    entries.delete(found.key);
    if (notify) {
      publish();
    }
  };

  const prepareAcceptedMessage = (
    entry: PlacementStartupEntry,
    recovery: SessionPlacementRecovery,
    messageId: string,
    consumedByEventId?: string,
  ) => {
    const submission = buildInitialChatSubmission(
      entry.owner.sessionKey,
      {
        text: recovery.message,
        mentions: recovery.mentions,
        attachments: entry.attachments,
        createdAt: entry.createdAt,
      },
      entry.scope.client,
      messageId,
    );
    params.chatSubmissions.retain(
      submission ? { ...submission, ...(consumedByEventId ? { consumedByEventId } : {}) } : null,
    );
  };

  const refreshAfterFailure = (entry: PlacementStartupEntry) => {
    if (!isCurrent(entry) || entry.work.kind === "cancelled") {
      return;
    }
    params.sessions.invalidate();
  };

  const pauseEntry = (
    entry: PlacementStartupEntry,
    recovery: SessionPlacementRecovery,
    error: string,
  ) => {
    const { recovery: paused } = pauseSessionPlacementRecovery(
      recovery,
      error,
      entry.persistRecovery,
    );
    entry.work = { kind: "paused", recovery: paused };
    publish();
  };

  const run = (
    entry: PlacementStartupEntry,
    recovery: SessionPlacementRecovery,
    mode: SessionPlacementStartMode,
  ) => {
    let currentRecovery = recovery;
    void advanceSessionPlacementDraft({
      client: entry.scope.client,
      recovery: currentRecovery,
      persistRecovery: entry.persistRecovery,
      cleanupOnCancellation: () => !entry.persistRecovery && entry.work.kind !== "paused",
      mode,
      isLifecycleCurrent: () => lifecycleCurrent(entry),
      ownsRecovery: () => ownsRecovery(entry),
      clearRecovery: () =>
        clearSessionPlacementRecovery(
          entry.owner.gatewayUrl,
          entry.owner.recoveryScope,
          entry.owner.sessionKey,
          entry.owner.messageId,
        ),
      setRecoveryPhase: (phase) => {
        currentRecovery = { ...currentRecovery, phase };
        entry.work = { kind: "running", recovery: currentRecovery };
        publish();
      },
    })
      .then((result) => {
        if (!ownsRecovery(entry) || !entry.retainsConnection()) {
          retireEntry(entry);
          return;
        }
        if (result.status === "paused") {
          entry.work = { kind: "paused", recovery: result.recovery };
          publish();
          handleGatewaySnapshot(params.gateway.snapshot);
          return;
        }
        if (result.status === "cancelled" && result.cleanupError) {
          pauseEntry(entry, currentRecovery, result.cleanupError);
          handleGatewaySnapshot(params.gateway.snapshot);
          return;
        }
        if (result.status === "cancelled" && !entry.persistRecovery) {
          entry.work = { kind: "cancelled", recovery: currentRecovery };
          const cancelled = [...entries.values()].filter((item) => item.work.kind === "cancelled");
          for (const retired of cancelled.slice(0, -32)) {
            retireEntry(retired, false);
          }
          publish();
          return;
        }
        if (!lifecycleCurrent(entry)) {
          if (result.status === "started" || result.status === "accepted") {
            // Acceptance can clear storage before a reconnect reaches this continuation.
            // Keep display custody and reconcile on the authenticated replacement client.
            entry.work = { kind: "checking", recovery: currentRecovery };
            handleGatewaySnapshot(params.gateway.snapshot);
          } else if (result.status !== "interrupted") {
            retireEntry(entry);
          }
          return;
        }
        // A private recovery read does not populate the pane's transcript. Keep
        // display custody until that pane receives its own authoritative input.
        if (result.status === "started" || result.status === "accepted") {
          prepareAcceptedMessage(
            entry,
            currentRecovery,
            result.status === "started" ? result.messageId : entry.owner.messageId,
            result.status === "accepted" ? result.consumedByEventId : undefined,
          );
        }
        retireEntry(entry);
      })
      .catch((error: unknown) => {
        if (isCurrent(entry)) {
          pauseEntry(entry, currentRecovery, formatUiError(error));
        }
      })
      .finally(() => refreshAfterFailure(entry));
  };

  const start = (input: PlacementStartupInput) => {
    if (input.recovery.phase === "creating") {
      return;
    }
    connection.transition(params.gateway.snapshot);
    const existing = findEntry(input.recovery.sessionKey)?.entry;
    if (
      existing &&
      existing.owner.messageId === input.recovery.messageId &&
      existing.retainsConnection() &&
      (existing.work.kind === "cancelled" ||
        (isCurrent(existing) &&
          (existing.work.kind !== "paused" || input.recovery.phase === "paused")))
    ) {
      return;
    }
    if (existing) {
      retireEntry(existing, false);
    }
    const scope = connection.capture();
    if (!scope) {
      return;
    }
    const owner: PlacementStartupOwner = {
      sessionKey: input.recovery.sessionKey,
      messageId: input.recovery.messageId,
      gatewayUrl: input.recovery.gatewayUrl,
      recoveryScope: input.recovery.recoveryScope,
    };
    const entry: PlacementStartupEntry = {
      work:
        input.recovery.phase === "paused"
          ? { kind: "paused", recovery: input.recovery }
          : {
              kind: input.recovery.phase === "sending" ? "checking" : "running",
              recovery: input.recovery,
            },
      owner,
      // Status reads must not rescan payloads or mint new attachment identities.
      attachments:
        input.displayAttachments ?? restoreChatApiAttachments(input.recovery.attachments),
      persistRecovery: input.persistRecovery,
      createdAt:
        existing?.owner.messageId === owner.messageId ? existing.createdAt : input.createdAt,
      scope,
      retainsConnection: capturePlacementStartupConnection(params.gateway, owner),
    };
    entries.set(owner.sessionKey, entry);
    publish();
    if (input.recovery.phase !== "paused") {
      run(entry, input.recovery, input.mode);
    }
  };

  const handleGatewaySnapshot = (
    snapshot: ApplicationPlacementStartupDependencies["gateway"]["snapshot"],
  ) => {
    connection.transition(snapshot);
    if (snapshot.phase !== "connected") {
      return;
    }
    if (!snapshot.client?.recoveryScopeReady || !snapshot.client.recoveryScope) {
      return;
    }
    // Paused memory-only submissions have no storage row to rehydrate. Replace
    // their lifecycle binding only after the same credential scope is validated.
    for (const entry of entries.values()) {
      if (
        (entry.work.kind === "paused" || entry.work.kind === "checking") &&
        !lifecycleCurrent(entry) &&
        entry.retainsConnection() &&
        ownsRecovery(entry)
      ) {
        start({
          recovery: entry.work.recovery,
          persistRecovery: entry.persistRecovery,
          mode: "recover",
          createdAt: entry.createdAt,
        });
      }
    }
    for (const recovery of listSessionPlacementRecoveries(
      params.gateway.connection.gatewayUrl,
      snapshot.client.recoveryScope,
    )) {
      start({ recovery, persistRecovery: true, mode: "recover", createdAt: Date.now() });
    }
  };

  return {
    resumeRecovery: () => handleGatewaySnapshot(params.gateway.snapshot),
    hasPendingTurn(sessionKey) {
      const entry = findEntry(sessionKey)?.entry;
      return Boolean(
        entry &&
        entry.work.kind !== "cancelled" &&
        entry.retainsConnection() &&
        ownsRecovery(entry),
      );
    },
    get(sessionKey) {
      const entry = findEntry(sessionKey)?.entry;
      if (!entry || !entry.retainsConnection() || !ownsRecovery(entry)) {
        return null;
      }
      const cancelled = entry.work.kind === "cancelled";
      const reconnecting = !cancelled && !lifecycleCurrent(entry);
      const error = cancelled
        ? t("newSession.placementCancelled")
        : entry.work.recovery.phase === "paused"
          ? entry.work.recovery.error
          : undefined;
      let phase: PlacementStartupPhase = reconnecting
        ? "reconnecting"
        : cancelled
          ? "cancelled"
          : entry.work.kind !== "running"
            ? "failed"
            : entry.work.recovery.phase === "sending"
              ? "sending"
              : "pending";
      if (phase === "pending") {
        const row = params.sessions.state.result?.sessions.find((candidate: GatewaySessionRow) =>
          areUiSessionKeysEquivalent(candidate.key, entry.owner.sessionKey),
        );
        const placementState = row?.placement?.state;
        if (placementState && isStartupPlacementPhase(placementState)) {
          phase = placementState;
        }
      }
      return {
        sessionKey: entry.owner.sessionKey,
        targetKind: entry.work.recovery.target.kind,
        phase,
        startedAt: entry.createdAt,
        initialTurn: buildPlacementStartupInitialTurn({
          recovery: entry.work.recovery,
          attachments: entry.attachments,
          createdAt: entry.createdAt,
          checking:
            entry.work.kind === "checking" ||
            (cancelled && entry.work.recovery.phase === "sending"),
          reconnecting,
          error: cancelled ? error : undefined,
        }),
        ...(entry.work.kind !== "running"
          ? {
              ...(error ? { error } : {}),
              retryable: !reconnecting && !cancelled,
              ...(!cancelled
                ? {
                    action:
                      entry.work.kind === "checking" ||
                      (entry.work.recovery.phase === "paused" &&
                        entry.work.recovery.reason === "unconfirmed")
                        ? ("check-delivery" as const)
                        : ("retry" as const),
                  }
                : {}),
            }
          : {}),
      };
    },
    start,
    pause(sessionKey, error) {
      const entry = findEntry(sessionKey)?.entry;
      if (!entry || entry.work.kind === "cancelled" || !isCurrent(entry)) {
        return;
      }
      const { recovery } = pauseSessionPlacementRecovery(
        entry.work.recovery,
        error,
        entry.persistRecovery,
      );
      // Replace the owner before Stop leaves the browser; late active dispatch replies lose send authority.
      entry.work = { kind: "paused", recovery };
      retireEntry(entry, false);
      start({
        recovery,
        persistRecovery: entry.persistRecovery,
        mode: "recover",
        createdAt: entry.createdAt,
      });
    },
    retry(sessionKey) {
      const entry = findEntry(sessionKey)?.entry;
      if (!entry || entry.work.kind !== "paused" || !isCurrent(entry)) {
        return;
      }
      if (entry.work.recovery.reason === "unconfirmed") {
        entry.work = { kind: "checking", recovery: entry.work.recovery };
        publish();
        run(entry, entry.work.recovery, "recover");
        return;
      }
      const { reason, error: _error, ...submission } = entry.work.recovery;
      const recovery: SessionPlacementPendingRecovery = {
        ...submission,
        phase: "dispatching",
        messageId: reason === "rejected" ? generateUUID() : submission.messageId,
      };
      // Rotate a known failed attempt atomically with its durable ownership.
      // Late completion of the old key cannot retire or replace this attempt.
      if (
        entry.persistRecovery &&
        !writeSessionPlacementRecoveryIfAvailable(recovery, submission.messageId)
      ) {
        pauseEntry(entry, entry.work.recovery, "placement recovery storage is unavailable");
        return;
      }
      start({
        recovery,
        persistRecovery: entry.persistRecovery,
        mode: "retry",
        createdAt: entry.createdAt,
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      connection.dispose();
      entries.clear();
      listeners.clear();
    },
  };
}
