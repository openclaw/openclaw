/** Captured destination identity and live generation facts for ordinary session events. */
import { isAgentDeletionBlocked } from "../../agents/agent-lifecycle-registry.js";
import { resolveConfiguredAgentId } from "../../agents/agent-scope-config.js";
import {
  getGatewayToolCallerIdentity,
  prepareGatewayToolCallerAssertion,
} from "../../agents/tools/gateway-caller-context.js";
import { getRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { canonicalizeMainSessionAlias } from "../../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  assertAgentRunLifecycleGenerationCurrent,
  getAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  toAgentStoreSessionKey,
} from "../../routing/session-key.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.read.js";
import type { SessionEventTarget } from "./session-event-contract.js";

const targetScopes = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionEvents.targetScopes"),
  () => new WeakMap<SessionEventTarget, { env?: NodeJS.ProcessEnv }>(),
);

export function getSessionEventRuntimeConfig() {
  const cfg = getRuntimeConfigSnapshot();
  if (!cfg) {
    throw new Error(
      "Session event admission requires an initialized runtime config; start the Gateway and retry",
    );
  }
  return cfg;
}

export function resolveSessionEventKey(agentId: string, sessionKey: string) {
  const cfg = getSessionEventRuntimeConfig();
  const raw = sessionKey.trim();
  const owner = parseAgentSessionKey(raw)?.agentId;
  if (!raw || (owner && owner !== agentId)) {
    throw new Error("Session event requires an exact session owned by its agent");
  }
  if (raw === "global") {
    return raw;
  }
  return canonicalizeMainSessionAlias({
    cfg,
    agentId,
    sessionKey: toAgentStoreSessionKey({ agentId, requestKey: raw, mainKey: cfg.session?.mainKey }),
  });
}

/** Capture at the producer's admission, before asynchronous work can outlive its session. */
export async function captureSessionEventTargetForHost(
  requestedAgentId: string,
  requestedSessionKey: string,
  options: { env?: NodeJS.ProcessEnv; assertCurrent?: () => void } = {},
): Promise<SessionEventTarget> {
  options.assertCurrent?.();
  const agentId = normalizeAgentId(requestedAgentId);
  const sessionKey = resolveSessionEventKey(agentId, requestedSessionKey);
  const cfg = getSessionEventRuntimeConfig();
  const env = options.env ? { ...options.env } : undefined;
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId, env });
  const generation = getAgentEventLifecycleGeneration();
  const caller = getGatewayToolCallerIdentity();
  const callerMatches =
    caller?.agentId === agentId &&
    resolveSessionEventKey(agentId, caller.sessionKey) === sessionKey;
  const preparedCaller =
    callerMatches && caller?.operationalRunInstance
      ? await prepareGatewayToolCallerAssertion()
      : undefined;
  const assertCaptureCurrent = () => {
    options.assertCurrent?.();
    assertAgentRunLifecycleGenerationCurrent(generation);
    if (!callerMatches || !caller) {
      return;
    }
    if (preparedCaller) {
      preparedCaller.assertCurrent?.();
    } else if (
      caller.receiptAuthority?.() === false ||
      caller.approvalSignals?.some((signal) => signal.aborted)
    ) {
      throw new Error("Session event producer no longer owns its invocation");
    }
  };
  try {
    assertCaptureCurrent();
    const { withSessionEntryReadOnlyInWorker } =
      await import("../../config/sessions/session-entry-read-runtime.js");
    const entry = await withSessionEntryReadOnlyInWorker(
      { agentId, storePath, sessionKey, env },
      assertCaptureCurrent,
      async (read) => {
        if (!read.ok) {
          throw read.error;
        }
        return read.value;
      },
    );
    let toolsAllow: string[] | undefined;
    if (caller && callerMatches) {
      assertCaptureCurrent();
      if (caller.sessionEventToolsAllow) {
        if (
          caller.sessionEventToolsAllow.length > 512 ||
          caller.sessionEventToolsAllow.some((name) => name.length > 256)
        ) {
          throw new Error("Session event producer tool surface exceeds the supported bound");
        }
        toolsAllow = [...caller.sessionEventToolsAllow];
      }
    }
    const target: SessionEventTarget = {
      agentId,
      sessionKey,
      storePath,
      toolsAllow,
      assertCurrent: options.assertCurrent,
      // Empty identity pins absence until normal admission creates the first session.
      sessionId: entry?.sessionId ?? "",
      lifecycleRevision: entry?.lifecycleRevision,
      generation,
      deliveryContext: structuredClone(deliveryContextFromSession(entry)),
      settings: entry
        ? structuredClone({
            permissionMode: entry.permissionMode,
            toolOverrides: entry.toolOverrides,
          })
        : undefined,
    };
    targetScopes.set(target, { env });
    return target;
  } finally {
    preparedCaller?.release();
  }
}

/** Validate the original destination; callers still own the live execution/delivery claim. */
export function assertSessionEventTargetCurrent(target: SessionEventTarget): void {
  target.assertCurrent?.();
  if (!target.agentId || !target.sessionKey) {
    throw new Error("Session event target has no original owner");
  }
  const cfg = getSessionEventRuntimeConfig();
  resolveConfiguredAgentId(cfg, target.agentId);
  assertAgentRunLifecycleGenerationCurrent(target.generation);
  if (isAgentDeletionBlocked(target.agentId)) {
    throw new Error("Session event owner is being deleted");
  }
  const storePath = resolveSessionStorePathCore(cfg.session?.store, {
    agentId: target.agentId,
    env: targetScopes.get(target)?.env,
  });
  if (target.storePath && target.storePath !== storePath) {
    throw new Error("Session event destination store changed while its producer was running");
  }
}

/** Deferred producers retain snapshots; only admitted consumption holds live generation facts. */
export async function prepareSessionEventTargetForHost(target: SessionEventTarget) {
  assertSessionEventTargetCurrent(target);
  if (!target.agentId || !target.sessionKey || !target.storePath) {
    throw new Error("Session event target has no captured destination");
  }
  const { prepareSessionGenerationFacts } =
    await import("../../config/sessions/session-delivery-generation.js");
  const lease = await prepareSessionGenerationFacts({
    agentId: target.agentId,
    storePath: target.storePath,
    sessionKey: target.sessionKey,
    sessionId: target.sessionId || null,
    lifecycleRevision: target.lifecycleRevision ?? null,
  });
  const assertCurrent = () => {
    assertSessionEventTargetCurrent(target);
    lease.assertCurrent();
  };
  try {
    assertCurrent();
    return { ...lease, assertCurrent };
  } catch (error) {
    lease.release();
    throw error;
  }
}

export function readSessionEventTargetEnvironment(
  target: SessionEventTarget,
): NodeJS.ProcessEnv | undefined {
  return targetScopes.get(target)?.env;
}
