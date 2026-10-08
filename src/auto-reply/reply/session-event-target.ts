/** Captured destination identity and live generation facts for ordinary session events. */
import { isAgentDeletionBlocked } from "../../agents/agent-lifecycle-registry.js";
import { resolveConfiguredAgentId } from "../../agents/agent-scope-config.js";
import { intersectSessionPermissionModes } from "../../agents/session-permission-exec-mode.js";
import { isRuntimeToolAllowed } from "../../agents/tool-policy-match.js";
import {
  attachToolAllowlistIntersection,
  readToolAllowlistIntersection,
} from "../../agents/tool-policy-shared.js";
import {
  getGatewayToolCallerIdentity,
  prepareGatewayToolCallerAssertion,
} from "../../agents/tools/gateway-caller-context.js";
import { getRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { canonicalizeMainSessionAlias } from "../../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import type { SessionEntryReadSourcePreparation } from "../../config/sessions/session-entry-read-runtime.types.js";
import { isSessionStoreReadCandidateCurrent } from "../../config/sessions/session-store-read-candidates.js";
import {
  intersectSessionToolOverrides,
  sessionToolOverridesEqual,
} from "../../config/sessions/session-tool-overrides.js";
import {
  assertAgentRunLifecycleGenerationCurrent,
  getAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import { getAgentRunContext } from "../../infra/agent-run-registry.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { channelRouteDedupeKey } from "../../plugin-sdk/channel-route.js";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  toAgentStoreSessionKey,
} from "../../routing/session-key.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.read.js";
import { resolveEffectiveReplyRoute } from "./effective-reply-route.js";
import type { SessionEventTarget } from "./session-event-contract.js";

type CapturedEventSource = {
  database: Parameters<SessionEntryReadSourcePreparation>[0];
  identity: Parameters<SessionEntryReadSourcePreparation>[1];
  selectedStore: { path: string; physicalPath: string };
};

function assertCapturedEventSource(source: CapturedEventSource) {
  const identity = readDatabasePathIdentitySync(source.database.path);
  if (
    identity.key !== source.identity.key ||
    identity.birthtime !== source.identity.birthtime ||
    !isSessionStoreReadCandidateCurrent(source.selectedStore)
  ) {
    throw new Error("Session event destination storage changed after capture");
  }
}

const targetScopes = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionEvents.targetScopes"),
  () =>
    new WeakMap<SessionEventTarget, { env?: NodeJS.ProcessEnv; source?: CapturedEventSource }>(),
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
  options: {
    env?: NodeJS.ProcessEnv;
    assertCurrent?: () => void;
    /** Submitting invocation authority ends after capture/acceptance, not event settlement. */
    assertCaptureCurrent?: () => void;
    /** Prepared host policy survives adapters that translate or clear the original tool cap. */
    producerPolicy?: Readonly<Pick<SessionEventTarget, "toolsAllow" | "settings">>;
  } = {},
): Promise<SessionEventTarget> {
  options.assertCaptureCurrent?.();
  options.assertCurrent?.();
  const agentId = normalizeAgentId(requestedAgentId);
  const sessionKey = resolveSessionEventKey(agentId, requestedSessionKey);
  const cfg = getSessionEventRuntimeConfig();
  const env = options.env ? { ...options.env } : undefined;
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId, env });
  const generation = getAgentEventLifecycleGeneration();
  const caller = getGatewayToolCallerIdentity();
  const callerAgentMatches = caller?.agentId === agentId;
  if (callerAgentMatches) {
    // Validate producer ownership even when routing selects another session of this agent.
    resolveSessionEventKey(agentId, caller.sessionKey);
  }
  // Routing can remap a completion without widening its originating delivery policy.
  const deliver =
    callerAgentMatches &&
    (caller.sessionEventDelivery === false ||
      (caller.operationalRunInstance &&
        getAgentRunContext(caller.operationalRunInstance.runId)?.sessionEventDelivery === false))
      ? false
      : undefined;
  const preparedCaller =
    callerAgentMatches && caller?.operationalRunInstance
      ? await prepareGatewayToolCallerAssertion()
      : undefined;
  const assertCaptureCurrent = () => {
    options.assertCaptureCurrent?.();
    options.assertCurrent?.();
    assertAgentRunLifecycleGenerationCurrent(generation);
    if (!callerAgentMatches || !caller) {
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
    let source: CapturedEventSource | undefined;
    let preparedSource: Pick<CapturedEventSource, "database" | "identity"> | undefined;
    const entry = await withSessionEntryReadOnlyInWorker(
      { agentId, storePath, sessionKey, env },
      assertCaptureCurrent,
      async (read, owner) => {
        if (!read.ok) {
          throw read.error;
        }
        if (preparedSource && owner.selectedStore) {
          source = { ...preparedSource, selectedStore: { ...owner.selectedStore } };
        }
        return read.value;
      },
      (database, identity) => {
        preparedSource = {
          database: { ...database, env: { ...database.env } },
          identity: { ...identity },
        };
      },
    );
    if (source) {
      assertCapturedEventSource(source);
    }
    let toolsAllow: string[] | undefined;
    if (caller && callerAgentMatches) {
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
    toolsAllow = intersectSessionEventToolsAllow(toolsAllow, options.producerPolicy?.toolsAllow);
    const destinationSettings = entry
      ? { permissionMode: entry.permissionMode, toolOverrides: entry.toolOverrides }
      : undefined;
    const callerSettings = callerAgentMatches ? caller?.sessionEventSettings : undefined;
    const producerSettings =
      options.producerPolicy?.settings && callerSettings
        ? narrowSessionEventSettings(options.producerPolicy.settings, callerSettings)
        : (options.producerPolicy?.settings ?? callerSettings);
    const target: SessionEventTarget = {
      agentId,
      sessionKey,
      storePath,
      toolsAllow,
      deliver,
      assertCurrent: options.assertCurrent,
      // Empty identity pins absence until normal admission creates the first session.
      sessionId: entry?.sessionId ?? "",
      lifecycleRevision: entry?.lifecycleRevision,
      generation,
      deliveryContext: structuredClone(deliveryContextFromSession(entry)),
      chatType: resolveEffectiveReplyRoute({ ctx: { InternalTurnSource: "event" }, entry })
        .chatType,
      settings: structuredClone(
        producerSettings
          ? narrowSessionEventSettings(producerSettings, destinationSettings)
          : destinationSettings,
      ),
    };
    targetScopes.set(target, { env, source });
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
export async function prepareSessionEventTargetForHost(
  target: SessionEventTarget,
  options: { createIfMissing?: true; assertAcceptanceCurrent?: () => void } = {},
) {
  assertSessionEventTargetCurrent(target);
  if (!target.agentId || !target.sessionKey || !target.storePath) {
    throw new Error("Session event target has no captured destination");
  }
  const { prepareSessionGenerationFacts } =
    await import("../../config/sessions/session-delivery-generation.js");
  const source = targetScopes.get(target)?.source;
  const assertAcceptance = () => {
    options.assertAcceptanceCurrent?.();
    assertSessionEventTargetCurrent(target);
  };
  const assertSource = () => {
    if (source) {
      assertCapturedEventSource(source);
    }
  };
  assertAcceptance();
  assertSource();
  let preparation:
    | ReturnType<
        typeof import("../../config/sessions/session-accessor.entry-mutation.js").prepareSessionEntryMutationDatabases
      >
    | undefined;
  if (!target.sessionId && options.createIfMissing) {
    if (!source) {
      throw new Error("Fresh session event has no captured physical storage owner");
    }
    const { prepareSessionEntryMutationDatabases } =
      await import("../../config/sessions/session-accessor.entry-mutation.js");
    assertAcceptance();
    preparation = prepareSessionEntryMutationDatabases(
      [
        {
          scope: {
            agentId: target.agentId,
            storePath: target.storePath,
            sessionKey: target.sessionKey,
            env: source.database.env,
          },
          assertCurrent: assertAcceptance,
          expectedSource: source,
        },
      ],
      Promise.resolve(),
    );
  }
  let lease: Awaited<ReturnType<typeof prepareSessionGenerationFacts>> | undefined;
  let preparedSource = source;
  try {
    try {
      const prepared = await preparation?.preparations[0];
      assertAcceptance();
      prepared?.assertCurrent();
      if (!prepared) {
        assertSource();
      } else if (source?.identity.key.startsWith("path:")) {
        const accepted = prepared.execution?.fileIdentity;
        if (!accepted || typeof accepted.birthtime !== "string") {
          throw new Error("Fresh session event has no accepted physical storage identity");
        }
        preparedSource = {
          ...source,
          identity: {
            ...source.identity,
            key: `file:${accepted.physicalIdentity}`,
            birthtime: accepted.birthtime,
          },
        };
      }
      lease = await prepareSessionGenerationFacts({
        agentId: target.agentId,
        storePath: source?.database.path ?? target.storePath,
        sessionKey: target.sessionKey,
        sessionId: target.sessionId || null,
        lifecycleRevision: target.lifecycleRevision ?? null,
        env: source?.database.env,
      });
      prepared?.assertCurrent();
      assertAcceptance();
      if (preparedSource) {
        assertCapturedEventSource(preparedSource);
      }
    } finally {
      await preparation?.[Symbol.asyncDispose]();
    }
    assertAcceptance();
    if (preparedSource) {
      assertCapturedEventSource(preparedSource);
    }
    lease.assertCurrent();
    // Only canonical native preparation can advance captured physical absence.
    if (preparedSource !== source) {
      const captured = targetScopes.get(target);
      if (captured?.source !== source) {
        throw new Error("Session event storage was already prepared by another admission");
      }
      targetScopes.set(target, { ...captured, source: preparedSource });
    }
  } catch (error) {
    lease?.release();
    throw error;
  }
  const retained = lease;
  const assertTargetCurrent = () => {
    assertSessionEventTargetCurrent(target);
    if (preparedSource) {
      assertCapturedEventSource(preparedSource);
    }
  };
  const assertCurrent = () => {
    assertTargetCurrent();
    retained.assertCurrent();
  };
  try {
    assertCurrent();
    return {
      ...retained,
      assertCurrent,
      bindCreation: (operation: Parameters<typeof retained.bindCreation>[0]) => {
        assertTargetCurrent();
        const assertCreationCurrent = retained.bindCreation(operation, (binding) => {
          // Retain the committed origin even if this attempt stops before model start.
          target.sessionId = binding.sessionId;
          target.lifecycleRevision = binding.lifecycleRevision;
        });
        return () => {
          assertTargetCurrent();
          assertCreationCurrent();
        };
      },
    };
  } catch (error) {
    retained.release();
    throw error;
  }
}

export function readSessionEventTargetEnvironment(
  target: SessionEventTarget,
): NodeJS.ProcessEnv | undefined {
  return targetScopes.get(target)?.env;
}

/** Coalesced work retains every producer's original destination and permission bound. */
export function combineSessionEventTargetsForHost(
  targets: readonly SessionEventTarget[],
): SessionEventTarget {
  const first = targets[0];
  if (!first) {
    throw new Error("Session event batch requires a captured destination");
  }
  const retained = [...targets];
  const route = channelRouteDedupeKey(first.deliveryContext);
  for (const target of retained) {
    if (
      target.agentId !== first.agentId ||
      target.sessionKey !== first.sessionKey ||
      target.storePath !== first.storePath ||
      target.sessionId !== first.sessionId ||
      target.lifecycleRevision !== first.lifecycleRevision ||
      target.generation !== first.generation ||
      target.chatType !== first.chatType ||
      channelRouteDedupeKey(target.deliveryContext) !== route
    ) {
      throw new Error("Session event batch has different captured destinations");
    }
  }
  const assertCurrent = () => {
    for (const target of retained) {
      assertSessionEventTargetCurrent(target);
      const source = targetScopes.get(target)?.source;
      if (source) {
        assertCapturedEventSource(source);
      }
    }
  };
  assertCurrent();
  const combined: SessionEventTarget = {
    ...first,
    deliveryContext: structuredClone(first.deliveryContext),
    assertCurrent,
    settings: retained.reduce(
      (settings, target) => narrowSessionEventSettings(settings, target.settings),
      first.settings,
    ),
    toolsAllow: intersectSessionEventToolsAllow(...retained.map((target) => target.toolsAllow)),
    deliver: retained.some((target) => target.deliver === false) ? false : first.deliver,
  };
  targetScopes.set(combined, targetScopes.get(first) ?? {});
  return combined;
}

/** Retain each canonical cap independently; overlapping globs cannot be flattened safely. */
export function intersectSessionEventToolsAllow(
  ...allowlists: Array<readonly string[] | undefined>
): string[] | undefined {
  const restrictions = allowlists.flatMap((allow) =>
    allow === undefined
      ? []
      : (readToolAllowlistIntersection(allow) ?? [allow]).map((restriction) => restriction.slice()),
  );
  if (restrictions.length === 0) {
    return undefined;
  }
  const candidates = [...new Set(restrictions.flat())].filter((name) =>
    restrictions.every((restriction) => isRuntimeToolAllowed(name, restriction)),
  );
  return attachToolAllowlistIntersection(candidates, restrictions);
}

/** A delayed producer can retain restrictions, never replace current session authority. */
export function narrowSessionEventSettings(
  retained: SessionEventTarget["settings"],
  current: SessionEventTarget["settings"],
): NonNullable<SessionEventTarget["settings"]> {
  return {
    permissionMode: intersectSessionPermissionModes(
      retained?.permissionMode,
      current?.permissionMode,
    ),
    toolOverrides: intersectSessionToolOverrides(retained?.toolOverrides, current?.toolOverrides),
  };
}

/** Frozen tools may continue only while the current session still covers their admitted policy. */
export function assertSessionEventSettingsCurrent(
  admitted: SessionEventTarget["settings"],
  current: SessionEventTarget["settings"],
): void {
  const narrowed = narrowSessionEventSettings(admitted, current);
  if (
    admitted?.permissionMode !== narrowed.permissionMode ||
    !sessionToolOverridesEqual(admitted?.toolOverrides, narrowed.toolOverrides)
  ) {
    throw new Error(
      "Session event permissions were restricted; start a new turn under the current policy.",
    );
  }
}
