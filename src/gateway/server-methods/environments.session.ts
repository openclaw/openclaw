import {
  ErrorCodes,
  errorShape,
  validateEnvironmentsSessionCreateParams,
  validateEnvironmentsSessionDestroyParams,
  validateEnvironmentsSessionStatusParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { authorizeSessionSharingTarget } from "../session-sharing.js";
import { summarizeWorkerEnvironment } from "../worker-environments/environment-summary.js";
import type { WorkerEnvironmentSessionIdentity } from "../worker-environments/session-attachment.js";
import { captureSessionEnvironmentToolPolicy } from "./environments.session-tool-policy.js";
import { loadAccessorSessionEntryForGatewayTarget } from "./sessions-shared.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { dispatchUiCommandToRequester } from "./ui-command.js";
import { defineValidatedGatewayMethod } from "./validation.js";

/** Binds machine effects to the authenticated conversation and its current incarnation. */
export function resolveSessionEnvironmentCaller(
  options: GatewayRequestHandlerOptions,
  requested: { sessionKey?: string; agentId?: string } = {},
): { identity: WorkerEnvironmentSessionIdentity; assertCurrent: () => void; signal?: AbortSignal } {
  const { context, client } = options;
  const tool = client?.internal?.agentToolCaller;
  const runtime = client?.internal?.agentRuntimeIdentity;
  const ambient = client?.internal?.syntheticClient ? getGatewayToolCallerIdentity() : undefined;
  const assertAmbient = ambient ? captureGatewayToolCallerAssertion() : undefined;
  const owner = tool ?? runtime ?? (assertAmbient ? ambient : undefined);
  if (!client || (client.internal?.syntheticClient && !owner)) {
    throw new Error(
      "Conversation environments require an authenticated operator or admitted agent run",
    );
  }
  if (tool && !tool.assertCurrent) {
    throw new Error("Conversation environment tool has no live run authority");
  }
  if (
    owner &&
    ((requested.sessionKey && requested.sessionKey !== owner.sessionKey) ||
      (requested.agentId && requested.agentId !== owner.agentId))
  ) {
    throw new Error("An agent can only manage its own conversation environment");
  }
  const sessionKey = owner?.sessionKey ?? requested.sessionKey;
  if (!sessionKey) {
    throw new Error("sessionKey is required for operator environment requests");
  }
  const selected = resolveRequestedSessionAgentId(
    context.getRuntimeConfig(),
    sessionKey,
    owner?.agentId ?? requested.agentId,
  );
  if (!selected.ok) {
    throw new Error(selected.error.message);
  }
  const readTarget = () =>
    loadAccessorSessionEntryForGatewayTarget({
      cfg: context.getRuntimeConfig(),
      key: sessionKey,
      agentId: selected.agentId,
    });
  const target = readTarget();
  if (!target.entry || target.entry.incognito === true) {
    throw new Error("A persistent conversation is required for an attached environment");
  }
  const identity = {
    sessionId: target.entry.sessionId,
    sessionKey: target.canonicalKey,
    agentId: selected.agentId,
    ...(target.entry.lifecycleRevision
      ? { sessionLifecycleRevision: target.entry.lifecycleRevision }
      : {}),
  };
  const signals = [
    options.signal,
    client.connectionSignal,
    ...(ambient?.approvalSignals ?? []),
  ].filter((signal): signal is AbortSignal => signal !== undefined);
  const signal = signals.length ? AbortSignal.any(signals) : undefined;
  const assertCurrent = () => {
    signal?.throwIfAborted();
    options.sessionMutationCommitGuard?.();
    options.sessionMutationAuthorization?.assertCurrent();
    if (client.invalidated || options.hasCurrentClientAuthority?.() === false) {
      throw new Error("Conversation environment requester is no longer active");
    }
    tool?.assertCurrent?.();
    if (ambient) {
      if (
        !assertAmbient ||
        (ambient.gatewayContextResolver && ambient.gatewayContextResolver() !== context)
      ) {
        throw new Error("Conversation environment tool belongs to a different or retired Gateway");
      }
      assertAmbient();
    }
    if (runtime && context.validateAgentRuntimeApprovalAuthority?.(runtime) !== true) {
      throw new Error("Conversation environment agent run is no longer active");
    }
    const current = readTarget();
    if (
      current.entry?.sessionId !== identity.sessionId ||
      current.canonicalKey !== identity.sessionKey ||
      current.entry.lifecycleRevision !== identity.sessionLifecycleRevision
    ) {
      throw new Error("Conversation identity changed before the environment operation");
    }
    if (!owner) {
      const denied = authorizeSessionSharingTarget({
        cfg: context.getRuntimeConfig(),
        client,
        target: {
          agentId: identity.agentId,
          canonicalKey: current.canonicalKey,
          entry: current.entry,
          storeKey: current.sessionStoreKey,
          storeKeys: current.target.storeKeys,
          storePath: current.storePath,
        },
      });
      if (denied) {
        throw new Error(denied.message);
      }
    }
  };
  assertCurrent();
  return { identity, assertCurrent, signal };
}

function failure(error: unknown) {
  return errorShape(
    ErrorCodes.INVALID_REQUEST,
    error instanceof Error ? error.message : "Conversation environment request failed",
  );
}

export const environmentsSessionHandlers: GatewayRequestHandlers = {
  "environments.session.create": defineValidatedGatewayMethod(
    "environments.session.create",
    validateEnvironmentsSessionCreateParams,
    async (options) => {
      const { params, respond, context } = options;
      try {
        const caller = resolveSessionEnvironmentCaller(options, params);
        const { presentation, ...request } = params;
        const assertAllowed = presentation
          ? captureSessionEnvironmentToolPolicy(options, caller, "screen").assertAllowed
          : caller.assertCurrent;
        assertAllowed();
        const service = context.workerEnvironmentService;
        if (!service) {
          throw new Error("Cloud worker environments are not configured");
        }
        const result = await service.createSessionAttachment(
          { ...request, ...caller.identity },
          assertAllowed,
          caller.signal,
          presentation
            ? async ({ environmentId }) => {
                assertAllowed();
                const dispatched = dispatchUiCommandToRequester({
                  client: options.client,
                  context,
                  params: {
                    sessionKey: caller.identity.sessionKey,
                    agentId: caller.identity.agentId,
                    command:
                      presentation === "desktop"
                        ? {
                            kind: "panel",
                            panel: "desktop",
                            environmentId,
                            open: true,
                            dock: "right",
                          }
                        : {
                            kind: "panel",
                            panel: "portal",
                            environmentId,
                            open: true,
                            dock: "right",
                          },
                  },
                });
                if (!dispatched.ok) {
                  throw new Error(dispatched.error.message);
                }
                assertAllowed();
              }
            : undefined,
        );
        assertAllowed();
        respond(true, { ...result, environment: summarizeWorkerEnvironment(result.environment) });
      } catch (error) {
        respond(false, undefined, failure(error));
      }
    },
  ),
  "environments.session.status": defineValidatedGatewayMethod(
    "environments.session.status",
    validateEnvironmentsSessionStatusParams,
    (options) => {
      const { params, respond, context } = options;
      try {
        const caller = resolveSessionEnvironmentCaller(options, params);
        const result = context.workerEnvironmentService?.getSessionAttachmentStatus(
          caller.identity.sessionId,
        );
        if (params.environmentId && result?.attachment.environmentId !== params.environmentId) {
          throw new Error("Conversation environment target changed");
        }
        caller.assertCurrent();
        respond(
          true,
          result
            ? {
                attachment: result.attachment,
                closed: result.attachment.closedAtMs !== null,
                environment: summarizeWorkerEnvironment(result.environment),
              }
            : { attachment: null },
        );
      } catch (error) {
        respond(false, undefined, failure(error));
      }
    },
  ),
  "environments.session.destroy": defineValidatedGatewayMethod(
    "environments.session.destroy",
    validateEnvironmentsSessionDestroyParams,
    async (options) => {
      const { params, respond, context } = options;
      try {
        const caller = resolveSessionEnvironmentCaller(options, params);
        const service = context.workerEnvironmentService;
        if (!service) {
          throw new Error("Cloud worker environments are not configured");
        }
        const result = await service.destroySessionAttachment(
          { sessionId: caller.identity.sessionId, environmentId: params.environmentId },
          caller.assertCurrent,
        );
        caller.assertCurrent();
        respond(true, {
          stopped: true,
          ...(result ? { environment: summarizeWorkerEnvironment(result) } : {}),
        });
      } catch (error) {
        respond(false, undefined, failure(error));
      }
    },
  ),
};
