import type { DatabaseSync } from "node:sqlite";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AgentEventRuntimePayload } from "../infra/agent-events.js";
import { getAgentRunContextOwnerStatus } from "../infra/agent-run-registry.js";
import type { DeviceIdentity } from "../infra/device-identity.js";
import {
  resolveApnsAuthConfigFromEnv,
  resolveApnsRelayConfigFromEnv,
  sendApnsLiveActivity,
} from "../infra/push-apns.js";
import { createApnsLiveActivityPayload } from "../infra/push-live-activity-payload.js";
import {
  LIVE_ACTIVITY_MAX_ATTEMPT_MS,
  LiveActivityStore,
  type LiveActivityBinding,
  type LiveActivityClaim,
  type LiveActivityDeliveryOwner,
  type LiveActivityRegistration,
  type LiveActivitySnapshot,
} from "../infra/push-live-activity-store.js";
import type { SubsystemLogger } from "../logging/subsystem.js";
import type { SessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import {
  isChatAbortControllerEntryAbortable,
  type ChatAbortControllerEntry,
} from "./chat-abort.js";
import { isLiveActivityBindingCurrent } from "./live-activity-authorization.js";
import {
  attachLiveActivitySource,
  captureLiveActivitySource,
  isLiveActivityTerminal,
  readLiveActivitySource,
  type CommittedLiveActivityFact,
  type LiveActivitySource,
} from "./live-activity-source.js";

const DELIVERY_CONCURRENCY = 4;

type DeliveryAttempt = {
  claim: LiveActivityClaim;
  controller: AbortController;
  promise: Promise<void>;
  current: boolean;
};

export function createLiveActivityCoordinator(params: {
  gatewayIdentity: DeviceIdentity;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  getRuntimeConfig: () => OpenClawConfig;
  log: Pick<SubsystemLogger, "warn">;
}) {
  const store = new LiveActivityStore();
  const gatewayId = params.gatewayIdentity.deviceId;
  // Registration authority retains the original entry, not another run ledger.
  // The sole latest pre-registration fact remains on that exact chat owner.
  const sources = new Map<string, LiveActivitySource>();
  const attempts = new Map<string, DeliveryAttempt>();
  const terminalWrites = new WeakMap<LiveActivitySource, Set<() => void>>();
  let closing = false;
  let closed = false;
  let scheduled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopping: Promise<void> | undefined;

  const assertOpen = (): undefined => {
    if (closing || closed) {
      throw new Error("Live Activity delivery is closing");
    }
  };
  const runIsCurrent = (entry: ChatAbortControllerEntry, publicRunId: string): boolean => {
    const source = entry.liveActivityFact?.source;
    return Boolean(
      params.chatAbortControllers.get(publicRunId) === entry &&
      entry.kind !== "agent" &&
      entry.controlUiVisible !== false &&
      entry.projectSessionActive !== false &&
      !entry.projectSessionTerminalPending &&
      !entry.projectSessionTerminalPersisted &&
      !entry.registrationCleanupRequested &&
      entry.preparedSession?.sessionId === entry.sessionId &&
      entry.isAdmissionCurrent?.() === true &&
      isChatAbortControllerEntryAbortable(entry) &&
      source &&
      source.entry === entry &&
      source.publicRunId === publicRunId &&
      source.publicRunId === entry.liveActivityRun?.publicRunId &&
      source.internalRunId === entry.liveActivityRun?.internalRunId &&
      source.agentId === entry.agentId &&
      source.sessionKey === entry.sessionKey &&
      source.preparedSession === entry.preparedSession &&
      source.lifecycleGeneration === entry.lifecycleGeneration &&
      getAgentRunContextOwnerStatus(
        source.internalRunId,
        source.contextClaimId,
        source.lifecycleGeneration,
      ) === "active",
    );
  };
  const sourceIsCurrent = (binding: Readonly<LiveActivityBinding>, sourceIncarnation: string) => {
    const entry = params.chatAbortControllers.get(binding.publicRunId);
    return Boolean(
      entry &&
      runIsCurrent(entry, binding.publicRunId) &&
      entry.agentId === binding.agentId &&
      entry.sessionKey === binding.sessionKey &&
      entry.preparedSession?.sessionId === binding.sessionId &&
      entry.preparedSession.lifecycleRevision === binding.lifecycleRevision &&
      entry.liveActivityFact?.source.sourceIncarnation === sourceIncarnation,
    );
  };
  const bindingIsCurrent = (binding: Readonly<LiveActivityBinding>, database: DatabaseSync) =>
    binding.gatewayId === gatewayId &&
    isLiveActivityBindingCurrent(binding, params.getRuntimeConfig(), database);
  const deliveryOwner =
    (registration: LiveActivityRegistration): LiveActivityDeliveryOwner =>
    (binding, sourceIncarnation, database) => {
      if (!bindingIsCurrent(binding, database)) {
        return "lost";
      }
      if (registration.snapshot && isLiveActivityTerminal(registration.snapshot)) {
        return registration.sourceIncarnation === sourceIncarnation ? "ready" : "lost";
      }
      const source = sources.get(registration.registrationId);
      if (
        !source ||
        source.sourceIncarnation !== sourceIncarnation ||
        params.chatAbortControllers.get(source.publicRunId) !== source.entry ||
        source.entry.liveActivityFact?.source !== source ||
        source.entry.preparedSession !== source.preparedSession ||
        source.entry.liveActivityRun?.publicRunId !== source.publicRunId ||
        source.entry.liveActivityRun.internalRunId !== source.internalRunId ||
        source.entry.lifecycleGeneration !== source.lifecycleGeneration
      ) {
        return "lost";
      }
      const pending = terminalWrites.get(source);
      if (pending?.size) {
        for (const assertCurrent of pending) {
          try {
            assertCurrent();
            return "held";
          } catch {
            // A closing execution cannot lend authority to a different write.
          }
        }
        return "lost";
      }
      return source ===
        params.chatAbortControllers.get(binding.publicRunId)?.liveActivityFact?.source &&
        sourceIsCurrent(binding, sourceIncarnation)
        ? "ready"
        : "lost";
    };

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const wake = () => {
    if (closing || closed || scheduled) {
      return;
    }
    clearTimer();
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (closing || closed) {
        return;
      }
      try {
        pump();
      } catch {
        params.log.warn("Live Activity maintenance failed");
      }
    });
  };
  const retire = (predicate: (binding: Readonly<LiveActivityBinding>) => boolean) => {
    if (closed) {
      return;
    }
    for (const registration of store.list(gatewayId)) {
      if (predicate(registration.binding)) {
        attempts.get(registration.registrationId)?.controller.abort();
        store.retireOwner(registration.binding);
        sources.delete(registration.registrationId);
      }
    }
    wake();
  };
  const invalidateAttempt = (attempt: DeliveryAttempt) => {
    attempt.current = false;
    try {
      // Consume an authorized claim before a queued permanent response resumes.
      // An unconsumed claim remains fenced by its aborted signal and delivery owner.
      store.settle(attempt.claim, "transient");
    } finally {
      attempt.controller.abort();
    }
  };
  const holdTerminal = (source: LiveActivitySource, assertCurrent: () => void) => {
    const pending = terminalWrites.get(source) ?? new Set<() => void>();
    pending.add(assertCurrent);
    terminalWrites.set(source, pending);
    for (const [id, attempt] of attempts) {
      if (sources.get(id) === source && !isLiveActivityTerminal(attempt.claim.snapshot)) {
        try {
          invalidateAttempt(attempt);
        } catch {
          params.log.warn("Live Activity terminal claim settlement failed");
        }
      }
    }
    return () => {
      pending.delete(assertCurrent);
      if (!pending.size) {
        terminalWrites.delete(source);
      }
      wake();
    };
  };
  const dispatch = async (attempt: DeliveryAttempt) => {
    const { claim, controller } = attempt;
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(0, claim.attemptDeadlineMs - Date.now()),
    );
    timeout.unref?.();
    try {
      // Serialize before consuming authority; retries use the store-reserved
      // timestamp and immutable source snapshot, never an attempt-time refresh.
      const payload = createApnsLiveActivityPayload({
        snapshot: claim.snapshot,
        timestamp: claim.timestampSeconds,
      });
      const assertCurrent = (): undefined => {
        assertOpen();
        controller.signal.throwIfAborted();
        if (!attempt.current || attempts.get(claim.registration.registrationId) !== attempt) {
          throw new Error("Live Activity dispatch was superseded");
        }
        const authorized = store.authorizeDispatch(claim, deliveryOwner(claim.registration));
        if (!authorized.ok) {
          throw new Error("Live Activity dispatch authority expired");
        }
      };
      const destination = claim.destination;
      const registration = {
        ...destination,
        purpose: "liveActivity" as const,
        bundleId: destination.topic,
      };
      const common = { payload, signal: controller.signal, assertCurrent };
      let result;
      if (registration.transport === "direct") {
        const auth = await resolveApnsAuthConfigFromEnv(process.env);
        if (!auth.ok) {
          return;
        }
        result = await sendApnsLiveActivity({
          ...common,
          registration,
          auth: auth.value,
          timeoutMs: Math.max(1, claim.attemptDeadlineMs - Date.now()),
        });
      } else {
        const relay = resolveApnsRelayConfigFromEnv(
          process.env,
          params.getRuntimeConfig().gateway,
          {
            registrationRelayOrigin:
              destination.transport === "relay" ? destination.relayOrigin : undefined,
          },
        );
        if (!relay.ok) {
          return;
        }
        result = await sendApnsLiveActivity({
          ...common,
          registration,
          relayConfig: relay.value,
          relayGatewayIdentity: params.gatewayIdentity,
        });
      }
      if (
        !attempt.current ||
        controller.signal.aborted ||
        attempts.get(claim.registration.registrationId) !== attempt
      ) {
        return;
      }
      const terminalConflict =
        destination.transport === "relay" &&
        result.status === 409 &&
        result.reason === "ActivityTerminalConflict";
      const destinationInvalid =
        result.status === 410 ||
        (destination.transport === "direct" &&
          result.status === 400 &&
          result.reason === "BadDeviceToken");
      // Busy/stale admissions, legacy 409s, and provider auth/config failures
      // are retryable. Settlement CAS discards outcomes of superseded claims.
      const settled = store.settle(
        claim,
        result.ok ? "accepted" : terminalConflict || destinationInvalid ? "permanent" : "transient",
      );
      if (terminalConflict && settled.ok) {
        params.log.warn("Live Activity terminal payload conflict");
      }
    } catch {
      // Cancellation and transport failures are not permission to clear an
      // ordinary push token. The exact activity claim owns its retry state.
      store.settle(claim, "transient");
    } finally {
      clearTimeout(timeout);
    }
  };
  const pump = () => {
    clearTimer();
    store.sweep();
    const registrations = store.list(gatewayId);
    const retained = new Set(registrations.map((registration) => registration.registrationId));
    for (const id of sources.keys()) {
      if (!retained.has(id)) {
        sources.delete(id);
      }
    }
    let next = store.nextMaintenanceAtMs();
    for (const registration of registrations) {
      if (!registration.snapshot) {
        continue;
      }
      const due = registration.nextAttemptAtMs;
      if (
        due !== null &&
        due <= Date.now() &&
        !attempts.has(registration.registrationId) &&
        attempts.size < DELIVERY_CONCURRENCY
      ) {
        const claimed = store.claim(
          registration.registrationId,
          deliveryOwner(registration),
          LIVE_ACTIVITY_MAX_ATTEMPT_MS,
        );
        if (claimed.ok) {
          const attempt: DeliveryAttempt = {
            claim: claimed.value,
            controller: new AbortController(),
            promise: Promise.resolve(),
            current: true,
          };
          attempts.set(registration.registrationId, attempt);
          attempt.promise = Promise.resolve()
            .then(() => dispatch(attempt))
            .catch(() => params.log.warn("Live Activity dispatch failed"))
            .finally(() => {
              if (attempts.get(registration.registrationId) === attempt) {
                attempts.delete(registration.registrationId);
              }
              wake();
            });
        }
      }
    }
    // Reread after claims: same-second ordering and claims both move due time.
    for (const registration of store.list(gatewayId)) {
      const due = registration.nextAttemptAtMs;
      if (due !== null && due > Date.now()) {
        next = next === null ? due : Math.min(next, due);
      }
    }
    if (next !== null && !closing) {
      timer = setTimeout(wake, Math.max(1, next - Date.now()));
      timer.unref?.();
    }
  };

  const observe = (fact: CommittedLiveActivityFact) => {
    if (closed || (closing && !isLiveActivityTerminal(fact.snapshot))) {
      return;
    }
    const entry = params.chatAbortControllers.get(fact.publicRunId);
    if (
      entry === fact.source.entry &&
      entry.liveActivityFact?.source === fact.source &&
      entry.agentId === fact.agentId &&
      entry.sessionKey === fact.sessionKey &&
      entry.preparedSession?.sessionId === fact.sessionId &&
      entry.preparedSession.lifecycleRevision === fact.lifecycleRevision
    ) {
      const previous = entry.liveActivityFact.snapshot;
      const snapshot: LiveActivitySnapshot = isLiveActivityTerminal(fact.snapshot)
        ? { ...fact.snapshot, sequence: previous?.sequence ?? 0 }
        : fact.snapshot;
      if (
        (!previous ||
          (!isLiveActivityTerminal(previous) &&
            (isLiveActivityTerminal(fact.snapshot) || snapshot.sequence > previous.sequence) &&
            fact.snapshot.observedAtMs >= previous.observedAtMs)) &&
        (isLiveActivityTerminal(fact.snapshot) || runIsCurrent(entry, fact.publicRunId))
      ) {
        entry.liveActivityFact = Object.freeze({
          source: fact.source,
          snapshot: Object.freeze(snapshot),
        });
      }
    }
    for (const registration of store.list(gatewayId)) {
      const binding = registration.binding;
      if (
        sources.get(registration.registrationId) !== fact.source ||
        registration.sourceIncarnation !== fact.source.sourceIncarnation ||
        binding.publicRunId !== fact.publicRunId ||
        binding.agentId !== fact.agentId ||
        binding.sessionKey !== fact.sessionKey ||
        binding.sessionId !== fact.sessionId ||
        binding.lifecycleRevision !== fact.lifecycleRevision
      ) {
        continue;
      }
      // onCommitted already accepted this terminal. A removed abort entry or a
      // successor run cannot erase that fact; session identity still fences it.
      const observed = store.observe(
        registration.registrationId,
        fact.snapshot,
        (owner, incarnation, database) =>
          bindingIsCurrent(owner, database) &&
          (isLiveActivityTerminal(fact.snapshot)
            ? incarnation === fact.source.sourceIncarnation
            : sourceIsCurrent(owner, incarnation)),
      );
      if (observed.ok && isLiveActivityTerminal(fact.snapshot)) {
        sources.delete(registration.registrationId);
      }
    }
    wake();
  };

  const observeRuntimeEvent = (event: AgentEventRuntimePayload) => {
    const terminalLifecycle =
      event.stream === "lifecycle" && (event.data.phase === "end" || event.data.phase === "error");
    if (
      closed ||
      (closing && !terminalLifecycle) ||
      event.controlUiVisible === false ||
      event.projectSessionLifecycle === false
    ) {
      return;
    }
    const capturedSource = readLiveActivitySource(event);
    let source = capturedSource;
    if (!source) {
      for (const [publicRunId, entry] of params.chatAbortControllers) {
        if (
          entry.liveActivityRun?.publicRunId === publicRunId &&
          entry.liveActivityRun.internalRunId === event.runId
        ) {
          // Ambiguous runtime reuse is unknown, never an arbitrary matching owner.
          if (source) {
            return;
          }
          source = captureLiveActivitySource(event, entry);
        }
      }
    }
    if (!source && terminalLifecycle) {
      source = [...sources.values()].find(
        (candidate) =>
          candidate.internalRunId === event.runId &&
          candidate.contextClaimId === event.contextClaimId &&
          candidate.lifecycleGeneration === event.lifecycleGeneration,
      );
    }
    if (
      !source ||
      (event.sessionId !== undefined && event.sessionId !== source.preparedSession.sessionId)
    ) {
      return;
    }
    if (!capturedSource) {
      attachLiveActivitySource(event, source);
    }
    const entry = source.entry;
    if (
      params.chatAbortControllers.get(source.publicRunId) !== entry ||
      getAgentRunContextOwnerStatus(
        source.internalRunId,
        source.contextClaimId,
        source.lifecycleGeneration,
      ) !== "active"
    ) {
      return;
    }
    if (entry.liveActivityFact?.source !== source) {
      entry.liveActivityFact = Object.freeze({ source, snapshot: null });
    }
    if (!runIsCurrent(entry, source.publicRunId)) {
      return;
    }
    const status =
      event.stream === "tool"
        ? event.data.phase === "start"
          ? "toolRunning"
          : event.data.phase === "result"
            ? "running"
            : undefined
        : event.stream === "approval"
          ? event.data.phase === "requested" && event.data.status === "pending"
            ? "approvalNeeded"
            : event.data.phase === "resolved"
              ? "running"
              : undefined
          : undefined;
    if (!status) {
      return;
    }
    const startedAtMs = entry.liveActivityFact?.snapshot?.startedAtMs;
    const snapshot: LiveActivitySnapshot = Object.freeze({
      sourceIncarnation: source.sourceIncarnation,
      sequence: event.seq,
      observedAtMs: event.ts,
      status,
      ...(startedAtMs !== undefined ? { startedAtMs } : {}),
    });
    observe({
      source,
      publicRunId: source.publicRunId,
      agentId: source.agentId,
      sessionKey: source.sessionKey,
      sessionId: source.preparedSession.sessionId,
      lifecycleRevision: source.preparedSession.lifecycleRevision,
      snapshot,
    });
  };
  const beginClose = () => {
    closing = true;
    clearTimer();
    for (const attempt of attempts.values()) {
      attempt.controller.abort();
    }
  };
  const stop = () =>
    (stopping ??= (async () => {
      beginClose();
      await Promise.allSettled([...attempts.values()].map((attempt) => attempt.promise));
      closed = true;
      sources.clear();
      store.close();
    })());

  // Store admission bounds this recovery scan. Never infer fresh progress from
  // a session row after restart; only accepted terminal facts survive the run.
  for (const registration of store.list(gatewayId)) {
    if (!registration.snapshot || !isLiveActivityTerminal(registration.snapshot)) {
      store.retireOwner(registration.binding);
    }
  }
  wake();
  return {
    gatewayId,
    store,
    assertOpen,
    runIsCurrent,
    sourceIsCurrent,
    bindRegistration: (registration: LiveActivityRegistration, source: LiveActivitySource) => {
      assertOpen();
      if (
        !sourceIsCurrent(registration.binding, source.sourceIncarnation) ||
        registration.sourceIncarnation !== source.sourceIncarnation ||
        params.chatAbortControllers.get(source.publicRunId) !== source.entry
      ) {
        throw new Error("Live Activity producer changed");
      }
      sources.set(registration.registrationId, source);
    },
    observe,
    holdTerminal,
    observeRuntimeEvent,
    wake,
    beginClose,
    stop,
    retireDevice: (deviceId: string) => retire((binding) => binding.deviceId === deviceId),
    retireProfile: (profileId: string) => retire((binding) => binding.profileId === profileId),
    retireSession: (mutation: SessionIdentityMutation) =>
      retire(
        (binding) =>
          binding.agentId === mutation.agentId &&
          (mutation.previous.sessionId === binding.sessionId ||
            mutation.previous.sessionKeys.includes(binding.sessionKey)),
      ),
  };
}

export type LiveActivityCoordinator = ReturnType<typeof createLiveActivityCoordinator>;
