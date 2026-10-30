/** Captured destination identity and live generation facts for ordinary session events. */

import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../../agents/admitted-run-context.js";
import { prepareAgentDeletionBlocked } from "../../agents/agent-lifecycle-registry.js";
import { resolveConfiguredAgentId } from "../../agents/agent-scope-config.js";
import {
  resolveRequesterPrincipalKey,
  requesterCreatorProfileId,
} from "../../agents/requester-origin.js";
import { createRuntimeToolMatcher } from "../../agents/tool-policy-match.js";
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
import { sessionToolOverridesEqual } from "../../config/sessions/session-tool-overrides.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { getAgentRunContext } from "../../infra/agent-run-registry.js";
import { channelRouteDedupeKey } from "../../plugin-sdk/channel-route.js";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  toAgentStoreSessionKey,
} from "../../routing/session-key.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { readAgentDeletionJournalStatusInWorker } from "../../state/agent-deletion-journal.read.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.read.js";
import type { PreparedCommandOwnerAuthority } from "../command-auth.js";
import { resolveEffectiveReplyRoute } from "./effective-reply-route.js";
import type { SessionEventTarget } from "./session-event-contract.js";
import { narrowSessionEventSettings } from "./session-event-policy.js";

const targetScopes = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionEvents.targetScopes"),
  () =>
    new WeakMap<
      SessionEventTarget,
      {
        env?: NodeJS.ProcessEnv;
        operatorAuthority?: AdmittedRunOperatorAuthority;
        ownerContinuation?: true;
        hasOriginatingCaller?: true;
        /** The captured requester keys the authority, whose source label is shared by owners. */
        commandOwner?: {
          authority: PreparedCommandOwnerAuthority;
          requester: CommandOwnerRequester;
        };
        deletion?: { agentId: string; isBlocked: () => boolean };
      }
    >(),
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
    /** Original host-issued source; the producer owns its lifetime until enqueue. */
    operatorAuthority?: AdmittedRunOperatorAuthority;
    /** The producing turn held command-owner authority under `operatorAuthority`. */
    ownerContinuation?: true;
    /**
     * Continue the producing turn's requester as command owner while they remain one.
     * The identity comes from the host-owned caller, never from the producer.
     */
    retainRequesterOwner?: true;
  } = {},
): Promise<SessionEventTarget> {
  const operatorAuthority = options.operatorAuthority;
  if (operatorAuthority) {
    assertAdmittedRunOperatorAuthority(operatorAuthority);
    operatorAuthority.assertCurrent();
  }
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
    operatorAuthority?.assertCurrent();
    options.assertCaptureCurrent?.();
    options.assertCurrent?.();
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
    await readAgentDeletionJournalStatusInWorker(agentId, { env });
    const deletion = { agentId, isBlocked: prepareAgentDeletionBlocked(agentId, { env }) };
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
    if (caller && callerAgentMatches) {
      assertCaptureCurrent();
      if (caller.sessionEventToolsAllow) {
        if (
          caller.sessionEventToolsAllow.length > 512 ||
          caller.sessionEventToolsAllow.some((name) => name.length > 256)
        ) {
          throw new Error("Session event producer tool surface exceeds the supported bound");
        }
        toolsAllow = intersectSessionEventToolsAllow(caller.sessionEventToolsAllow);
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
    const requester =
      options.retainRequesterOwner && callerAgentMatches ? caller?.requesterOrigin : undefined;
    const commandOwner =
      requester?.messageProvider && requester.senderId
        ? await (
            await import("../command-auth.js")
          ).prepareCommandOwnerAuthority(
            cfg,
            {
              channel: requester.messageProvider,
              accountId: requester.accountId ?? undefined,
              senderId: requester.senderId,
              senderE164: requester.senderE164 ?? undefined,
            },
            { env },
          )
        : undefined;
    assertCaptureCurrent();
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
      settings: producerSettings
        ? narrowSessionEventSettings(producerSettings, destinationSettings)
        : structuredClone(destinationSettings),
    };
    targetScopes.set(target, {
      env,
      operatorAuthority,
      ...(callerAgentMatches &&
      (resolveRequesterPrincipalKey(caller) || requesterCreatorProfileId(caller?.requesterOrigin))
        ? { hasOriginatingCaller: true as const }
        : {}),
      ...(operatorAuthority && options.ownerContinuation ? { ownerContinuation: true } : {}),
      ...(requester?.messageProvider &&
      requester.senderId &&
      commandOwner?.source &&
      commandOwner.isCurrent(cfg)
        ? {
            commandOwner: {
              authority: commandOwner,
              requester: Object.freeze({
                channel: requester.messageProvider,
                accountId: requester.accountId ?? undefined,
                senderId: requester.senderId,
                senderE164: requester.senderE164 ?? undefined,
              }),
            },
          }
        : {}),
      deletion,
    });
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
  const scope = targetScopes.get(target);
  let deletion = scope?.deletion;
  if (!deletion || deletion.agentId !== target.agentId) {
    deletion = {
      agentId: target.agentId,
      isBlocked: prepareAgentDeletionBlocked(target.agentId, { env: scope?.env }),
    };
    targetScopes.set(target, { ...scope, deletion });
  }
  if (deletion.isBlocked()) {
    throw new Error("Session event owner is being deleted");
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
  const env = targetScopes.get(target)?.env;
  const assertAcceptance = () => {
    options.assertAcceptanceCurrent?.();
    assertSessionEventTargetCurrent(target);
  };
  assertAcceptance();
  let preparation:
    | ReturnType<
        typeof import("../../config/sessions/session-accessor.entry-mutation.js").prepareSessionEntryMutationDatabases
      >
    | undefined;
  if (!target.sessionId && options.createIfMissing) {
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
            env,
          },
          assertCurrent: assertAcceptance,
        },
      ],
      Promise.resolve(),
    );
  }
  let lease: Awaited<ReturnType<typeof prepareSessionGenerationFacts>> | undefined;
  try {
    try {
      const prepared = await preparation?.preparations[0];
      assertAcceptance();
      prepared?.assertCurrent();
      lease = await prepareSessionGenerationFacts({
        agentId: target.agentId,
        storePath: target.storePath,
        sessionKey: target.sessionKey,
        sessionId: target.sessionId || null,
        lifecycleRevision: target.lifecycleRevision ?? null,
        env,
      });
      prepared?.assertCurrent();
      assertAcceptance();
    } finally {
      await preparation?.[Symbol.asyncDispose]();
    }
    assertAcceptance();
    lease.assertCurrent();
    const retained = lease;
    const assertTargetCurrent = () => {
      assertSessionEventTargetCurrent(target);
    };
    const assertCurrent = () => {
      assertTargetCurrent();
      retained.assertCurrent();
    };
    assertCurrent();
    return {
      ...retained,
      assertCurrent,
      readSessionSettings: () => {
        assertTargetCurrent();
        return retained.readSessionSettings();
      },
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
    lease?.release();
    throw error;
  }
}

export function readSessionEventTargetEnvironment(
  target: SessionEventTarget,
): NodeJS.ProcessEnv | undefined {
  return targetScopes.get(target)?.env;
}

export function readSessionEventTargetOperatorAuthority(
  target: SessionEventTarget,
): AdmittedRunOperatorAuthority | undefined {
  return targetScopes.get(target)?.operatorAuthority;
}

/** A captured channel guest still has a caller even without a profile grant. */
export function hasSessionEventOriginatingCaller(target: SessionEventTarget): boolean {
  return Boolean(
    targetScopes.get(target)?.hasOriginatingCaller ||
    readSessionEventTargetOperatorAuthority(target),
  );
}

/** Whether the producing turn was an owner under the target's captured operator source. */
export function readSessionEventTargetOwnerContinuation(target: SessionEventTarget): boolean {
  return targetScopes.get(target)?.ownerContinuation === true;
}

export type CommandOwnerRequester = Readonly<{
  channel: string;
  accountId?: string;
  senderId: string;
  senderE164?: string;
}>;

/** The retained owner authority and the host-captured requester it belongs to. */
export function readSessionEventTargetCommandOwner(
  target: SessionEventTarget,
): { authority: PreparedCommandOwnerAuthority; requester: CommandOwnerRequester } | undefined {
  return targetScopes.get(target)?.commandOwner;
}

function commandOwnerRequesterKey(target: SessionEventTarget): string | undefined {
  const requester = targetScopes.get(target)?.commandOwner?.requester;
  return requester
    ? JSON.stringify([
        requester.channel,
        requester.accountId ?? null,
        requester.senderId,
        requester.senderE164 ?? null,
      ])
    : undefined;
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
      target.chatType !== first.chatType ||
      readSessionEventTargetOperatorAuthority(target) !==
        readSessionEventTargetOperatorAuthority(first) ||
      readSessionEventTargetOwnerContinuation(target) !==
        readSessionEventTargetOwnerContinuation(first) ||
      hasSessionEventOriginatingCaller(target) !== hasSessionEventOriginatingCaller(first) ||
      commandOwnerRequesterKey(target) !== commandOwnerRequesterKey(first) ||
      channelRouteDedupeKey(target.deliveryContext) !== route
    ) {
      throw new Error(
        "Session event batch has different captured destinations or requester authority",
      );
    }
  }
  const assertCurrent = () => {
    for (const target of retained) {
      assertSessionEventTargetCurrent(target);
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
  const matchers = restrictions.map((restriction) => createRuntimeToolMatcher(restriction));
  const candidates = [...new Set(restrictions.flat())].filter((name) =>
    matchers.every((matches) => matches(name)),
  );
  return attachToolAllowlistIntersection(candidates, restrictions);
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
