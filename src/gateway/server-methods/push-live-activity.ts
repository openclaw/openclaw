import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
  ErrorCodes,
  errorShape,
  validatePushLiveActivityDiscoverParams,
  validatePushLiveActivityPrepareParams,
  validatePushLiveActivityPrepareResult,
  validatePushLiveActivityRegisterParams,
  validatePushLiveActivityRegistrationResult,
  validatePushLiveActivityRotateParams,
  validatePushLiveActivityRevokeParams,
  type PushLiveActivityPrepareParams,
  type PushLiveActivityRegistrationResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { isLikelyApnsToken, isValidApnsTopic } from "../../infra/push-apns-store.js";
import {
  resolveApnsAuthConfigFromEnv,
  resolveApnsRelayConfigFromEnv,
} from "../../infra/push-apns.js";
import type {
  LiveActivityBinding,
  LiveActivityDestination,
  LiveActivityRegistration,
} from "../../infra/push-live-activity-store.js";
import {
  liveActivityScopesAllow,
  readLiveActivityOwner,
  readLiveActivitySession,
} from "../live-activity-authorization.js";
import { isLiveActivityTerminal } from "../live-activity-source.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import { isGatewayClientProfilePending } from "./gateway-client-identity.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

class ActivityAccessError extends Error {}
class ActivityUnknownError extends Error {}

function prepareRequest(
  options: GatewayRequestHandlerOptions,
  requiredScope: "operator.read" | "operator.write" = "operator.write",
) {
  const { client, context } = options;
  const coordinator = context.liveActivityCoordinator;
  const connId = client?.connId;
  const profileId = client?.authenticatedUserProfile?.profileId;
  const deviceId = client?.connect.device?.id;
  if (!coordinator || !client || !connId || !profileId || !deviceId) {
    throw new ActivityAccessError("Live Activities require an authenticated paired operator.");
  }
  const currentOwner = (database?: DatabaseSync) => {
    coordinator.assertOpen();
    if (
      options.signal?.aborted ||
      options.hasCurrentClientAuthority?.() === false ||
      context.requestEntryLifetime?.signal.aborted ||
      client.connId !== connId ||
      !context.getClientConnIds?.((current) => current === client).has(connId) ||
      client.internal?.syntheticClient ||
      client.connect.role !== "operator" ||
      isGatewayClientProfilePending(client) ||
      client.authenticatedUserProfile?.profileId !== profileId ||
      client.connect.device?.id !== deviceId
    ) {
      throw new ActivityAccessError("Live Activity connection changed; reconnect.");
    }
    const owner = readLiveActivityOwner(profileId, deviceId, context.getRuntimeConfig(), database);
    if (!owner) {
      throw new ActivityAccessError("Live Activity owner is unavailable.");
    }
    const granted = client.connect.scopes ?? [];
    const scopes = [...new Set([...granted, ...owner.scopes])].filter(
      (scope) =>
        liveActivityScopesAllow(granted, scope) && liveActivityScopesAllow(owner.scopes, scope),
    );
    if (!liveActivityScopesAllow(scopes, requiredScope)) {
      throw new ActivityAccessError(`Live Activities require current ${requiredScope} permission.`);
    }
    return { ...owner, scopes };
  };
  const captured = currentOwner();
  const assertCurrent = (database?: DatabaseSync) => {
    const current = currentOwner(database);
    if (
      current.profileId !== captured.profileId ||
      current.nodeId !== captured.nodeId ||
      current.pairingGeneration !== captured.pairingGeneration
    ) {
      throw new ActivityAccessError("Live Activity owner changed; prepare again.");
    }
    return current;
  };
  const assertBinding = (
    binding: Readonly<LiveActivityBinding>,
    database?: DatabaseSync,
  ): undefined => {
    const current = assertCurrent(database);
    if (
      binding.gatewayId !== coordinator.gatewayId ||
      binding.deviceId !== deviceId ||
      binding.nodeId !== current.nodeId ||
      binding.pairingGeneration !== current.pairingGeneration ||
      binding.profileId !== current.profileId ||
      !readLiveActivitySession(binding, current, context.getRuntimeConfig(), database)
    ) {
      throw new ActivityAccessError("Live Activity session access changed; prepare again.");
    }
  };
  return { coordinator, captured, assertCurrent, assertBinding };
}

function prepareSelection(
  options: GatewayRequestHandlerOptions,
  request: PushLiveActivityPrepareParams,
  action = prepareRequest(options),
) {
  const cfg = options.context.getRuntimeConfig();
  const agent = resolveRequestedSessionAgentId(cfg, request.key, request.agentId);
  if (!agent.ok) {
    throw new ActivityUnknownError("Live Activity session is unavailable; refresh the selection.");
  }
  const loaded = loadGatewaySessionEntryReadOnly(request.key, { agentId: agent.agentId });
  const entry = options.context.chatAbortControllers.get(request.publicRunId);
  const fact = entry?.liveActivityFact;
  if (
    !loaded.entry ||
    loaded.entry.sessionId !== request.sessionId ||
    !entry ||
    !entry.preparedSession ||
    !fact?.snapshot ||
    isLiveActivityTerminal(fact.snapshot) ||
    !action.coordinator.runIsCurrent(entry, request.publicRunId) ||
    entry.agentId !== loaded.agentId ||
    entry.sessionKey !== loaded.canonicalKey ||
    entry.preparedSession.sessionId !== loaded.entry.sessionId ||
    entry.preparedSession.lifecycleRevision !== (loaded.entry.lifecycleRevision ?? null)
  ) {
    throw new ActivityUnknownError("Live Activity run fact is not ready; retry preparation.");
  }
  const binding: Readonly<LiveActivityBinding> = Object.freeze({
    gatewayId: action.coordinator.gatewayId,
    deviceId: action.captured.deviceId,
    nodeId: action.captured.nodeId,
    pairingGeneration: action.captured.pairingGeneration,
    profileId: action.captured.profileId,
    agentId: loaded.agentId,
    sessionKey: loaded.canonicalKey,
    sessionId: entry.preparedSession.sessionId,
    lifecycleRevision: entry.preparedSession.lifecycleRevision,
    publicRunId: request.publicRunId,
  });
  const sourceIncarnation = fact.source.sourceIncarnation;
  const assertCurrent = (database?: DatabaseSync): undefined => {
    action.assertBinding(binding, database);
    if (
      options.context.chatAbortControllers.get(request.publicRunId) !== entry ||
      !action.coordinator.sourceIsCurrent(binding, sourceIncarnation) ||
      !entry.liveActivityFact?.snapshot ||
      isLiveActivityTerminal(entry.liveActivityFact.snapshot)
    ) {
      throw new ActivityUnknownError("Live Activity run changed; prepare again.");
    }
  };
  assertCurrent();
  return { action, binding, source: fact.source, sourceIncarnation, entry, assertCurrent };
}

async function prepareDestination(
  destination: LiveActivityDestination,
  options: GatewayRequestHandlerOptions,
) {
  const ownedDestination = Object.freeze({ ...destination });
  if (
    !isValidApnsTopic(ownedDestination.topic) ||
    ownedDestination.topic.endsWith(".push-type.liveactivity") ||
    !isValidApnsTopic(`${ownedDestination.topic}.push-type.liveactivity`)
  ) {
    throw new ActivityAccessError("Live Activity base bundle ID is invalid.");
  }
  if (ownedDestination.transport === "direct") {
    if (!isLikelyApnsToken(ownedDestination.token)) {
      throw new ActivityAccessError("Live Activity token is invalid.");
    }
    const auth = await resolveApnsAuthConfigFromEnv(process.env);
    if (!auth.ok) {
      throw new ActivityUnknownError("Direct Live Activity delivery is unavailable.");
    }
  } else {
    const relay = resolveApnsRelayConfigFromEnv(
      process.env,
      options.context.getRuntimeConfig().gateway,
      { registrationRelayOrigin: ownedDestination.relayOrigin },
    );
    if (!relay.ok) {
      throw new ActivityAccessError("Live Activity relay is unavailable.");
    }
  }
  return ownedDestination;
}

function registrationResult(registration: LiveActivityRegistration) {
  const result: PushLiveActivityRegistrationResult = {
    registrationId: registration.registrationId,
    activityId: registration.activityId,
    binding: registration.binding,
    sourceIncarnation: registration.sourceIncarnation,
    state: registration.state,
    rotationRevision: registration.rotationRevision,
    leaseExpiresAtMs: registration.leaseExpiresAtMs,
  };
  if (!validatePushLiveActivityRegistrationResult(result)) {
    throw new ActivityUnknownError("Live Activity registration is unavailable.");
  }
  return result;
}

async function respondActivity(
  options: GatewayRequestHandlerOptions,
  operation: () => void | Promise<void>,
) {
  try {
    await operation();
  } catch (error) {
    const denied = error instanceof ActivityAccessError;
    options.respond(
      false,
      undefined,
      errorShape(
        denied ? ErrorCodes.FORBIDDEN : ErrorCodes.UNAVAILABLE,
        error instanceof ActivityAccessError || error instanceof ActivityUnknownError
          ? error.message
          : "Live Activity request is unavailable; retry from the current session.",
        denied ? undefined : { retryable: true, retryAfterMs: 250 },
      ),
    );
  }
}

export const liveActivityHandlers: GatewayRequestHandlers = {
  "push.liveActivity.discover": async (options) => {
    if (
      !assertValidParams(
        options.params,
        validatePushLiveActivityDiscoverParams,
        options.req.method,
        options.respond,
      )
    ) {
      return;
    }
    const request = options.params;
    await respondActivity(options, () => {
      const action = prepareRequest(options, "operator.read");
      const owner = action.assertCurrent();
      const selectors = request.selectors;
      if (
        selectors.gatewayDeviceId !== action.coordinator.gatewayId ||
        selectors.deviceId !== owner.deviceId ||
        selectors.profileId !== owner.profileId
      ) {
        throw new ActivityAccessError("Live Activity owner differs.");
      }
      const loaded = loadGatewaySessionEntryReadOnly(selectors.sessionKey, {
        agentId: selectors.agentId,
      });
      if (
        !readLiveActivitySession(
          { ...selectors, lifecycleRevision: loaded.entry?.lifecycleRevision ?? null },
          owner,
          options.context.getRuntimeConfig(),
        )
      ) {
        throw new ActivityAccessError("Live Activity session is unavailable.");
      }
      const registration = action.coordinator.store.loadByActivity(
        action.coordinator.gatewayId,
        owner.deviceId,
        request.activityId,
      );
      if (!registration) {
        action.assertCurrent();
        options.respond(true, { status: "unknown" });
        return;
      }
      const binding = registration.binding;
      if (
        !isDeepStrictEqual(selectors, {
          gatewayDeviceId: binding.gatewayId,
          deviceId: binding.deviceId,
          profileId: binding.profileId,
          agentId: binding.agentId,
          sessionKey: binding.sessionKey,
          sessionId: binding.sessionId,
          runId: binding.publicRunId,
        })
      ) {
        throw new ActivityAccessError("Live Activity selection differs.");
      }
      action.assertBinding(binding);
      // Discovery projects existing deadlines but never performs maintenance,
      // renews authority, or invents a terminal run outcome.
      const expired =
        Date.now() >=
        Math.min(registration.leaseExpiresAtMs, registration.terminalDeadlineMs ?? Infinity);
      options.respond(true, {
        status: "found",
        registration: registrationResult(
          expired ? { ...registration, state: "tombstone" } : registration,
        ),
      });
    });
  },
  "push.liveActivity.prepare": async (options) => {
    if (
      !assertValidParams(
        options.params,
        validatePushLiveActivityPrepareParams,
        options.req.method,
        options.respond,
      )
    ) {
      return;
    }
    const request = options.params;
    await respondActivity(options, () => {
      const selection = prepareSelection(options, request);
      const result = {
        binding: selection.binding,
        sourceIncarnation: selection.sourceIncarnation,
        snapshot: selection.entry.liveActivityFact?.snapshot,
      };
      if (!validatePushLiveActivityPrepareResult(result)) {
        throw new ActivityUnknownError("Live Activity run fact is unavailable.");
      }
      selection.assertCurrent();
      options.respond(true, result);
    });
  },
  "push.liveActivity.register": async (options) => {
    if (
      !assertValidParams(
        options.params,
        validatePushLiveActivityRegisterParams,
        options.req.method,
        options.respond,
      )
    ) {
      return;
    }
    const request = options.params;
    await respondActivity(options, async () => {
      const action = prepareRequest(options);
      // Lost ACK replay is discovery, not a fresh registration. It does not
      // require the public run owner to remain in the abort map.
      const existing = action.coordinator.store.loadByActivity(
        action.coordinator.gatewayId,
        action.captured.deviceId,
        request.activityId,
      );
      if (existing) {
        action.assertBinding(existing.binding);
        if (
          !isDeepStrictEqual(request.expected, {
            binding: existing.binding,
            sourceIncarnation: existing.sourceIncarnation,
          })
        ) {
          throw new ActivityAccessError("Live Activity registration binding differs.");
        }
        options.respond(true, registrationResult(existing));
        return;
      }
      const selection = prepareSelection(
        options,
        {
          key: request.expected.binding.sessionKey,
          agentId: request.expected.binding.agentId,
          sessionId: request.expected.binding.sessionId,
          publicRunId: request.expected.binding.publicRunId,
        },
        action,
      );
      if (
        !isDeepStrictEqual(request.expected, {
          binding: selection.binding,
          sourceIncarnation: selection.sourceIncarnation,
        })
      ) {
        throw new ActivityAccessError("Live Activity preparation changed; prepare again.");
      }
      const destination = await prepareDestination(request.destination, options);
      selection.assertCurrent();
      const registered = action.coordinator.store.register(
        {
          activityId: request.activityId,
          binding: selection.binding,
          sourceIncarnation: selection.sourceIncarnation,
          destination,
        },
        (_binding, _incarnation, database) => {
          selection.assertCurrent(database);
          return true;
        },
      );
      if (!registered.ok) {
        throw new ActivityUnknownError(
          `Live Activity registration ${registered.error}; prepare again.`,
        );
      }
      action.coordinator.bindRegistration(registered.value, selection.source);
      const snapshot = selection.entry.liveActivityFact?.snapshot;
      if (!snapshot) {
        throw new ActivityUnknownError("Live Activity initial fact is unavailable.");
      }
      const observed = action.coordinator.store.observe(
        registered.value.registrationId,
        snapshot,
        (_binding, _incarnation, database) => {
          selection.assertCurrent(database);
          return true;
        },
      );
      if (!observed.ok) {
        throw new ActivityUnknownError("Live Activity initial fact changed; prepare again.");
      }
      action.coordinator.wake();
      options.respond(true, registrationResult(registered.value));
    });
  },
  "push.liveActivity.rotate": async (options) => {
    if (
      !assertValidParams(
        options.params,
        validatePushLiveActivityRotateParams,
        options.req.method,
        options.respond,
      )
    ) {
      return;
    }
    const request = options.params;
    await respondActivity(options, async () => {
      const action = prepareRequest(options);
      const registration = action.coordinator.store.load(request.registrationId);
      if (!registration) {
        throw new ActivityUnknownError("Live Activity registration was not found.");
      }
      action.assertBinding(registration.binding);
      const destination = await prepareDestination(request.destination, options);
      action.assertBinding(registration.binding);
      const rotated = action.coordinator.store.rotate(
        { ...request, destination },
        (binding, _incarnation, database) => {
          action.assertBinding(binding, database);
          return true;
        },
      );
      if (!rotated.ok) {
        throw new ActivityUnknownError(
          `Live Activity rotation ${rotated.error}; reload registration.`,
        );
      }
      action.coordinator.wake();
      options.respond(true, registrationResult(rotated.value));
    });
  },
  "push.liveActivity.revoke": async (options) => {
    if (
      !assertValidParams(
        options.params,
        validatePushLiveActivityRevokeParams,
        options.req.method,
        options.respond,
      )
    ) {
      return;
    }
    const request = options.params;
    await respondActivity(options, () => {
      const action = prepareRequest(options);
      const registration = action.coordinator.store.load(request.registrationId);
      if (!registration) {
        throw new ActivityUnknownError("Live Activity registration was not found.");
      }
      action.assertBinding(registration.binding);
      const revoked = action.coordinator.store.revoke(
        request,
        (binding, _incarnation, database) => {
          action.assertBinding(binding, database);
          return true;
        },
      );
      if (!revoked.ok) {
        throw new ActivityUnknownError(
          `Live Activity revocation ${revoked.error}; reload registration.`,
        );
      }
      action.coordinator.wake();
      options.respond(true, { removed: revoked.value });
    });
  },
};
