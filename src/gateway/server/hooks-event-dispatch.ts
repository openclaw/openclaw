import type {
  SessionEventOutcome,
  SessionEventReceipt,
} from "../../auto-reply/reply/session-event-contract.js";
import {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
  type SessionEventTarget,
} from "../../auto-reply/reply/session-event-handoff.js";
import { getRuntimeConfig } from "../../config/io.js";
import { canonicalizeMainSessionAlias, resolveAgentMainSessionKey } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { withSystemEventOwner } from "../../infra/system-event-ownership.js";
import {
  consumeSelectedSystemEventEntries,
  enqueueRequiredSystemEventEntry,
  enqueueSystemEventWithReceipt,
  isSystemEventTurnOwned,
  peekSystemEventEntries,
} from "../../infra/system-events.js";
import { channelRouteDedupeKey } from "../../plugin-sdk/channel-route.js";
import { isUnscopedSessionKeySentinel, toAgentStoreSessionKey } from "../../routing/session-key.js";
import { HookWakeUnavailableError } from "./hooks-request-handler-response.js";

export type HookEventTarget = {
  eventSessionKey: string;
  agentId: string;
  expectedTarget?: SessionEventTarget;
};

export function resolveHookEventTarget(params: {
  cfg: OpenClawConfig;
  resolvedAgentId: string;
  sessionKey?: string;
}): HookEventTarget {
  if (params.cfg.session?.scope === "global") {
    // Each agent owns a literal `global` row in its store. Target the agent,
    // but never force an agent-qualified session key that the runner ignores.
    return {
      eventSessionKey: "global",
      agentId: params.resolvedAgentId,
    };
  }
  const eventSessionKey = params.sessionKey
    ? canonicalizeMainSessionAlias({
        cfg: params.cfg,
        agentId: params.resolvedAgentId,
        sessionKey: toAgentStoreSessionKey({
          agentId: params.resolvedAgentId,
          requestKey: params.sessionKey,
          mainKey: params.cfg.session?.mainKey,
        }),
      })
    : resolveAgentMainSessionKey({ cfg: params.cfg, agentId: params.resolvedAgentId });
  return {
    eventSessionKey,
    agentId: params.resolvedAgentId,
  };
}

/** Owns capture, queue custody, and acceptance for immediate or deferred hook wakes. */
export function createHookWakeDispatcher(reportFailure: (outcome: SessionEventOutcome) => void) {
  const pendingReceipts = new Map<string, SessionEventReceipt>();
  return async (
    value: { text: string; mode: "now" | "next-heartbeat"; sessionKey?: string },
    agentId: string,
    isHooksConfigCurrent?: () => boolean,
  ) => {
    const target = resolveHookEventTarget({
      cfg: getRuntimeConfig(),
      resolvedAgentId: agentId,
      sessionKey: value.sessionKey,
    });
    if (value.mode === "next-heartbeat") {
      if (isHooksConfigCurrent?.() === false) {
        return null;
      }
      const eventOptions = { sessionKey: target.eventSessionKey };
      const queued = enqueueSystemEventWithReceipt(
        value.text,
        isUnscopedSessionKeySentinel(target.eventSessionKey)
          ? withSystemEventOwner(eventOptions, agentId)
          : eventOptions,
      );
      return { eventOutcome: queued ? "queued" : "coalesced" } as const;
    }
    const changedConfig = new Error("Hook configuration changed during wake admission");
    // The HTTP guard publishes its refusal; do not invoke it twice after revocation.
    let configChanged = false;
    const assertAcceptanceCurrent = () => {
      if (configChanged || isHooksConfigCurrent?.() === false) {
        configChanged = true;
        throw changedConfig;
      }
    };
    let expectedTarget: SessionEventTarget;
    try {
      assertAcceptanceCurrent();
      expectedTarget = await captureSessionEventTargetForHost(
        target.agentId,
        target.eventSessionKey,
        { assertCaptureCurrent: assertAcceptanceCurrent },
      );
      assertAcceptanceCurrent();
    } catch (error) {
      if (error === changedConfig) {
        return null;
      }
      throw new HookWakeUnavailableError(formatErrorMessage(error));
    }
    const eventOptions = withSystemEventOwner(
      { sessionKey: target.eventSessionKey, deliveryContext: expectedTarget.deliveryContext },
      target.agentId,
    );
    let occurrence = enqueueRequiredSystemEventEntry(value.text, eventOptions);
    const eventOutcome = occurrence ? "queued" : "coalesced";
    let receipt: SessionEventReceipt | undefined;
    if (!occurrence) {
      const coalesced = peekSystemEventEntries(eventOptions.sessionKey).at(-1);
      if (
        !coalesced ||
        coalesced.text !== value.text.trim() ||
        coalesced.contextKey != null ||
        channelRouteDedupeKey(coalesced.deliveryContext) !==
          channelRouteDedupeKey(eventOptions.deliveryContext)
      ) {
        throw new HookWakeUnavailableError("Hook wake has no pending occurrence to accept");
      }
      if (isSystemEventTurnOwned(eventOptions.sessionKey, coalesced)) {
        receipt = coalesced.id ? pendingReceipts.get(coalesced.id) : undefined;
        if (!receipt) {
          throw new HookWakeUnavailableError("Hook wake acceptance is owned by another dispatcher");
        }
      }
      // A deferred notice still needs its ordinary turn when a later caller asks for now.
      occurrence = coalesced;
    }
    let ownsReceipt = false;
    try {
      if (!receipt) {
        const submitted = enqueueSessionEventForHost(value.text, {
          agentId: target.agentId,
          sessionKey: target.eventSessionKey,
          source: "hook",
          occurrences: [occurrence],
          ...(eventOutcome === "coalesced" ? { preserveOccurrenceOnRejection: true as const } : {}),
          expectedTarget,
          createIfMissing: true,
          assertAcceptanceCurrent,
        });
        receipt = submitted;
        ownsReceipt = true;
        pendingReceipts.set(submitted.id, submitted);
        void submitted.settled.then((outcome) => {
          if (pendingReceipts.get(submitted.id) === submitted) {
            pendingReceipts.delete(submitted.id);
          }
          if (outcome.status !== "completed") {
            reportFailure(outcome);
          }
        });
      }
      const accepted = await receipt.accepted;
      if (!accepted.ok) {
        assertAcceptanceCurrent();
        throw new HookWakeUnavailableError(accepted.error);
      }
      assertAcceptanceCurrent();
    } catch (error) {
      if (ownsReceipt) {
        receipt?.cancel();
      }
      if (eventOutcome === "queued") {
        consumeSelectedSystemEventEntries(eventOptions.sessionKey, [occurrence]);
      }
      if (error === changedConfig) {
        return null;
      }
      throw error;
    }
    return { eventOutcome } as const;
  };
}
