import { sleepWithAbort } from "@openclaw/retry";
import type { GatewaySessionRow } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { registerNewSessionRuntimeEnglish } from "../i18n/locales/en-new-session-runtime.ts";
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
  type ApplicationPlacementStartupStatus,
} from "./session-placement-startup.ts";

registerNewSessionRuntimeEnglish();

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
    | { kind: "waiting"; recovery: SessionPlacementPendingRecovery }
    | { kind: "cancelled"; recovery: SessionPlacementRecovery }
    | { kind: "paused"; recovery: SessionPlacementPausedRecovery };
  readonly owner: PlacementStartupOwner;
  readonly attachments: ChatAttachment[];
  readonly persistRecovery: boolean;
  readonly createdAt: number;
  readonly scope: GatewayConnectionScope;
  readonly retainsConnection: () => boolean;
  readonly abort: AbortController;
};

export default function createApplicationPlacementStartupRuntime(
  params: ApplicationPlacementStartupDependencies,
  publish: () => void,
): ApplicationPlacementStartupRuntime {
  const entries = new Map<string, PlacementStartupEntry>();
  const connection = createGatewayConnectionLifecycle(params.gateway.snapshot);

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
      !entry.abort.signal.aborted &&
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
    entry.abort.abort();
    if (notify) {
      publish();
    }
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
      describe: params.sessions.describe,
      recovery: currentRecovery,
      persistRecovery: entry.persistRecovery,
      cleanupOnCancellation: () =>
        !entry.persistRecovery &&
        currentRecovery.phase !== "sending" &&
        entry.work.kind !== "paused",
      mode,
      signal: entry.abort.signal,
      isLifecycleCurrent: () => lifecycleCurrent(entry),
      ownsRecovery: () => ownsRecovery(entry),
      clearRecovery: () =>
        clearSessionPlacementRecovery(
          entry.owner.gatewayUrl,
          entry.owner.recoveryScope,
          entry.owner.sessionKey,
          entry.owner.messageId,
        ),
      setRecoveryPhase: (phase, _durable, sessionId) => {
        currentRecovery = { ...currentRecovery, phase, sessionId };
        entry.work = { kind: "running", recovery: currentRecovery };
        publish();
      },
    })
      .then(async (result) => {
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
        if (result.status === "pending") {
          entry.work = { kind: "waiting", recovery: result.recovery };
          publish();
          await sleepWithAbort(result.retryAfterMs, entry.abort.signal);
          if (isCurrent(entry) && entry.work.kind === "waiting") {
            entry.work = { kind: "running", recovery: result.recovery };
            run(entry, result.recovery, "recover");
          }
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
        if (result.status === "started") {
          // An ACK owns delivery even if a new hello arrives before this continuation.
          const submission = buildInitialChatSubmission(
            entry.owner.sessionKey,
            {
              text: currentRecovery.message,
              mentions: currentRecovery.mentions,
              attachments: entry.attachments,
              createdAt: entry.createdAt,
            },
            params.gateway.snapshot.client ?? entry.scope.client,
            result.messageId,
          );
          params.chatSubmissions.retain(
            submission ? { ...submission, sessionId: currentRecovery.sessionId } : null,
          );
        } else if (!lifecycleCurrent(entry) && result.status === "interrupted") {
          return;
        }
        retireEntry(entry);
      })
      .catch((error: unknown) => {
        if (isCurrent(entry)) {
          pauseEntry(entry, currentRecovery, formatUiError(error));
        }
      })
      .finally(() => {
        if (isCurrent(entry) && entry.work.kind !== "cancelled") {
          params.sessions.invalidate();
        }
      });
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
              kind: "running",
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
      abort: new AbortController(),
    };
    entries.set(owner.sessionKey, entry);
    publish();
    if (input.recovery.phase !== "paused") {
      run(entry, input.recovery, input.mode);
    }
  };

  const restartEntry = (
    entry: PlacementStartupEntry,
    recovery: SessionPlacementRecovery,
    mode: SessionPlacementStartMode,
  ) =>
    start({ recovery, persistRecovery: entry.persistRecovery, mode, createdAt: entry.createdAt });

  const handleGatewaySnapshot = (
    snapshot: ApplicationPlacementStartupDependencies["gateway"]["snapshot"],
  ) => {
    connection.transition(snapshot);
    for (const entry of entries.values()) {
      if (!lifecycleCurrent(entry)) {
        entry.abort.abort();
      }
    }
    if (snapshot.phase !== "connected") {
      return;
    }
    if (!snapshot.client?.recoveryScopeReady || !snapshot.client.recoveryScope) {
      return;
    }
    // Replace lifecycle bindings only after the same credential scope is validated.
    // Attempted input reuses its key; the Gateway owns duplicate admission.
    // Unsent incognito starts still belong to their interrupted dispatch's cleanup.
    for (const entry of entries.values()) {
      if (
        entry.work.kind !== "cancelled" &&
        (entry.persistRecovery ||
          entry.work.recovery.phase === "sending" ||
          entry.work.kind === "paused") &&
        !lifecycleCurrent(entry) &&
        entry.retainsConnection() &&
        ownsRecovery(entry)
      ) {
        restartEntry(entry, entry.work.recovery, "recover");
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
          : entry.work.kind === "paused"
            ? "failed"
            : entry.work.kind === "waiting"
              ? "reconnecting"
              : entry.work.recovery.phase === "sending"
                ? "sending"
                : "pending";
      let startStatus: ApplicationPlacementStartupStatus["startStatus"];
      if (phase === "pending") {
        const row = params.sessions.state.result?.sessions.find((candidate: GatewaySessionRow) =>
          areUiSessionKeysEquivalent(candidate.key, entry.owner.sessionKey),
        );
        const placementState = row?.placement?.state;
        startStatus =
          row?.placement?.state === "provisioning" ? row.placement.startStatus : undefined;
        if (placementState && isStartupPlacementPhase(placementState)) {
          phase = placementState;
        }
      }
      return {
        sessionKey: entry.owner.sessionKey,
        targetKind: entry.work.recovery.target.kind,
        phase,
        ...(startStatus ? { startStatus } : {}),
        startedAt: entry.createdAt,
        initialTurn: buildPlacementStartupInitialTurn({
          recovery: entry.work.recovery,
          attachments: entry.attachments,
          createdAt: entry.createdAt,
          reconnecting: reconnecting || entry.work.kind === "waiting",
          error: cancelled ? error : undefined,
        }),
        ...(entry.work.kind === "paused" || cancelled
          ? {
              ...(error ? { error } : {}),
              retryable: !reconnecting && !cancelled,
              ...(!cancelled ? { action: "retry" as const } : {}),
            }
          : {}),
      };
    },
    start,
    discard(sessionKey) {
      const entry = findEntry(sessionKey)?.entry;
      if (!entry || !entry.retainsConnection() || !ownsRecovery(entry)) {
        return;
      }
      clearSessionPlacementRecovery(
        entry.owner.gatewayUrl,
        entry.owner.recoveryScope,
        entry.owner.sessionKey,
        entry.owner.messageId,
      );
      retireEntry(entry);
    },
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
      restartEntry(entry, recovery, "recover");
    },
    retry(sessionKey) {
      const entry = findEntry(sessionKey)?.entry;
      if (!entry || entry.work.kind !== "paused" || !isCurrent(entry)) {
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
      restartEntry(entry, recovery, "retry");
    },
    dispose() {
      connection.dispose();
      for (const entry of entries.values()) {
        entry.abort.abort();
      }
      entries.clear();
    },
  };
}
