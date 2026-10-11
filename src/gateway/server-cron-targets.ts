import { isAgentDeletionBlocked } from "../agents/agent-lifecycle-registry.js";
import { resolveAgentEntry, tryResolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import type { SessionEventTarget } from "../auto-reply/reply/session-event-contract.js";
import {
  assertSessionEventTargetCurrent,
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
} from "../auto-reply/reply/session-event-handoff.js";
import { prepareSessionEventTargetForHost } from "../auto-reply/reply/session-event-target.js";
import { getRuntimeConfig } from "../config/io.js";
import {
  canonicalizeMainSessionAlias,
  resolveAgentIdFromSessionKey,
  resolveAgentMainSessionKey,
  resolveSystemMainSessionTarget,
} from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronJobEffectiveAgentId } from "../cron/agent-id.js";
import type { CronServiceDeps } from "../cron/service/state.js";
import { resolveCronSessionTargetSessionKey } from "../cron/session-target.js";
import { resolveMainScopedEventSessionKey } from "../infra/event-session-routing.js";
import { withSystemEventOwner } from "../infra/system-event-ownership.js";
import { enqueueAutomationSystemEvent } from "../infra/system-events.js";
import {
  normalizeAgentId,
  resolveEventSessionKey,
  toAgentStoreSessionKey,
} from "../routing/session-key.js";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";
import { assertAgentDatabaseAdmitted } from "../state/agent-database-admission.js";

/** Resolve and admit scheduler events against the current roster and canonical session owner. */
export function createGatewayCronTargetResolver(
  env: NodeJS.ProcessEnv,
  log: Pick<ReturnType<typeof import("../logging/logger.js").getChildLogger>, "warn">,
) {
  const resolveCronAgent = (requested?: string | null) => {
    const runtimeConfig = getRuntimeConfig();
    const normalized =
      typeof requested === "string" && requested.trim() ? normalizeAgentId(requested) : undefined;
    const defaultAgentId = tryResolveAmbientOwnerAgentId(runtimeConfig);
    if (
      normalized !== undefined &&
      normalized !== defaultAgentId &&
      !resolveAgentEntry(runtimeConfig, normalized)
    ) {
      throw new Error(`cron job agent is unavailable: ${normalized}`);
    }
    const agentId = resolveCronJobEffectiveAgentId(
      normalized ? { agentId: normalized } : {},
      defaultAgentId,
    );
    if (isAgentDeletionBlocked(agentId, { env })) {
      throw new Error(`cron job agent is unavailable: ${agentId}`);
    }
    assertAgentDatabaseAdmitted(agentId, { env });
    return { agentId, cfg: runtimeConfig };
  };

  const resolveCronSessionKey = (paramsValue: {
    runtimeConfig: OpenClawConfig;
    agentId: string;
    requestedSessionKey?: string | null;
  }) => {
    const requested = paramsValue.requestedSessionKey?.trim();
    const candidate = toAgentStoreSessionKey({
      agentId: paramsValue.agentId,
      requestKey: requested,
      mainKey: paramsValue.runtimeConfig.session?.mainKey,
    });
    const canonical = canonicalizeMainSessionAlias({
      cfg: paramsValue.runtimeConfig,
      agentId: paramsValue.agentId,
      sessionKey: candidate,
    });
    if (canonical !== "global") {
      const sessionAgentId = resolveAgentIdFromSessionKey(canonical);
      if (normalizeAgentId(sessionAgentId) !== normalizeAgentId(paramsValue.agentId)) {
        return resolveAgentMainSessionKey({
          cfg: paramsValue.runtimeConfig,
          agentId: paramsValue.agentId,
        });
      }
    }
    return (
      resolveMainScopedEventSessionKey({
        cfg: paramsValue.runtimeConfig,
        sessionKey: canonical,
        agentId: paramsValue.agentId,
      }) ?? canonical
    );
  };

  const resolveCronTarget = (opts?: {
    agentId?: string | null;
    sessionKey?: string | null;
    preserveUntargeted?: boolean;
  }) => {
    const requestedAgentId =
      typeof opts?.agentId === "string" && opts.agentId.trim()
        ? normalizeAgentId(opts.agentId)
        : undefined;
    const requestedSessionKey =
      typeof opts?.sessionKey === "string" && opts.sessionKey.trim() ? opts.sessionKey : undefined;
    if (opts?.preserveUntargeted && !requestedAgentId && !requestedSessionKey) {
      return { runtimeConfig: getRuntimeConfig(), agentId: undefined, sessionKey: undefined };
    }
    if (!requestedAgentId && !requestedSessionKey) {
      const runtimeConfig = getRuntimeConfig();
      return { runtimeConfig, ...resolveSystemMainSessionTarget(runtimeConfig) };
    }

    // Derive from canonical agent-prefixed keys only. Relative keys intentionally
    // fall through to the configured default instead of hardcoding "main".
    const derivedAgentId =
      requestedSessionKey && parseAgentSessionKey(requestedSessionKey)
        ? resolveAgentIdFromSessionKey(requestedSessionKey)
        : undefined;
    const { agentId, cfg: runtimeConfig } = resolveCronAgent(requestedAgentId ?? derivedAgentId);
    const resolvedSessionKey = resolveCronSessionKey({
      runtimeConfig,
      agentId,
      requestedSessionKey,
    });
    const sessionKey =
      resolvedSessionKey && runtimeConfig.session?.scope === "global"
        ? resolveEventSessionKey(
            resolvedSessionKey,
            runtimeConfig.session?.mainKey,
            runtimeConfig.session?.scope,
          )
        : resolvedSessionKey;
    return { runtimeConfig, agentId, sessionKey };
  };

  const deferSessionEvent: NonNullable<CronServiceDeps["deferSessionEvent"]> = (
    text,
    job,
    expectedTarget,
    assertCurrent,
    notBeforeRunAtMs,
    coalescing,
    createIfMissing,
  ) => {
    const { agentId, sessionKey } = resolveCronTarget({
      agentId: job.agentId,
      sessionKey: resolveCronSessionTargetSessionKey(job.sessionTarget),
    });
    if (!agentId || !sessionKey) {
      throw new Error("Deferred automation has no configured session destination");
    }
    const enqueue = (target: SessionEventTarget) => {
      assertCurrent();
      if (target.agentId !== agentId || target.sessionKey !== sessionKey) {
        throw new Error("Deferred automation target does not match its scheduled receiver");
      }
      assertSessionEventTargetCurrent(target);
      const receiver = coalescing && {
        revision: coalescing.revision,
        assertCurrent: coalescing.assertCurrent,
      };
      const outcome = enqueueAutomationSystemEvent(
        text,
        withSystemEventOwner({ sessionKey: target.sessionKey }, target.agentId),
        {
          jobId: job.id,
          notBeforeRunAtMs,
          assertCurrent: () => assertSessionEventTargetCurrent(target),
          prepare: () => prepareSessionEventTargetForHost(target),
          ...(receiver
            ? {
                coalescing: {
                  key: JSON.stringify([
                    receiver.revision,
                    target.agentId,
                    target.sessionKey,
                    target.storePath,
                    target.sessionId,
                    target.lifecycleRevision,
                    target.generation,
                  ]),
                  assertCurrent: () => {
                    receiver.assertCurrent();
                    assertSessionEventTargetCurrent(target);
                  },
                },
              }
            : {}),
        },
      );
      coalescing?.onOutcome(outcome);
    };
    const admit = async (target: SessionEventTarget) => {
      if (!target.sessionId && !createIfMissing) {
        throw new Error("Deferred session event origin no longer exists");
      }
      const prepared = await prepareSessionEventTargetForHost(target, {
        createIfMissing,
        assertAcceptanceCurrent: assertCurrent,
      });
      try {
        prepared.assertCurrent();
        enqueue(target);
      } finally {
        prepared.release();
      }
    };
    if (expectedTarget) {
      return admit(expectedTarget);
    }
    return captureSessionEventTargetForHost(agentId, sessionKey, {
      env,
      assertCaptureCurrent: assertCurrent,
    }).then(admit);
  };

  const enqueueSessionEvent: NonNullable<CronServiceDeps["enqueueSessionEvent"]> = (text, opts) => {
    const { agentId, sessionKey } = resolveCronTarget(opts);
    if (!agentId || !sessionKey) {
      throw new Error("Session event has no configured owner");
    }
    const receipt = enqueueSessionEventForHost(text, {
      ...opts,
      agentId,
      sessionKey,
      source: "cron",
    });
    void receipt.settled.then((result) => {
      if (result.status !== "completed") {
        log.warn({ result }, "Session event did not complete");
      }
    });
    return receipt.accepted;
  };
  return { resolveCronAgent, resolveCronTarget, deferSessionEvent, enqueueSessionEvent };
}
