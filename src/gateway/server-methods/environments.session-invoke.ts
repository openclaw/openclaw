import { createHash } from "node:crypto";
import {
  NODE_COMPUTER_RESOURCE_FETCH_COMMAND,
  type SessionEnvironmentNodeCommand,
} from "../../../packages/gateway-protocol/src/environment-node-capabilities.js";
import {
  ErrorCodes,
  errorShape,
  validateEnvironmentsSessionInvokeParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { captureNodePairingGeneration } from "../../infra/device-pairing-node-state.js";
import { isForbiddenBrowserProxyMutation } from "../node-browser-proxy-policy.js";
import { isNodeCommandAllowed, resolveNodeCommandAllowlist } from "../node-command-policy.js";
import { captureGatewayClientUploadCommitGuard } from "../upload-policy.js";
import { boundedWorkerError } from "../worker-environments/worker-error.js";
import { captureSessionEnvironmentToolPolicy } from "./environments.session-tool-policy.js";
import { resolveSessionEnvironmentCaller } from "./environments.session.js";
import type { GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

const tools: Record<
  SessionEnvironmentNodeCommand,
  "file_fetch" | "file_write" | "dir_fetch" | "dir_list" | "browser"
> = {
  "file.fetch": "file_fetch",
  "file.stat": "file_fetch",
  "file.write": "file_write",
  "file.create": "file_write",
  "dir.fetch": "dir_fetch",
  "dir.list": "dir_list",
  "browser.proxy": "browser",
  "browser.proxy.upload.v1": "browser",
  [NODE_COMPUTER_RESOURCE_FETCH_COMMAND]: "file_fetch",
};

/** Dedicated-machine authority replaces paired-host path grants, never the caller's tool policy. */
export const environmentsSessionInvokeHandlers: GatewayRequestHandlers = {
  "environments.session.invoke": defineValidatedGatewayMethod(
    "environments.session.invoke",
    validateEnvironmentsSessionInvokeParams,
    async (options) => {
      const { params, context, respond } = options;
      const caller = await resolveSessionEnvironmentCaller(options, params);
      try {
        const service = context.workerEnvironmentService;
        if (!service) {
          throw new Error("Environment service unavailable");
        }
        const attachment = service.captureSessionAttachment(caller.identity);
        const binding = attachment.binding;
        if (params.environmentId !== binding.environmentId) {
          throw new Error("No matching environment is attached to this conversation");
        }
        if (
          (params.expectedOwnerEpoch !== undefined &&
            params.expectedOwnerEpoch !== binding.ownerEpoch) ||
          (params.expectedGeneration !== undefined &&
            params.expectedGeneration !== binding.generation)
        ) {
          throw new Error("Attached browser staging owner changed");
        }
        const policy = captureSessionEnvironmentToolPolicy(options, caller, tools[params.command]);
        const readCurrent = () => {
          caller.assertCurrent();
          attachment.assertCurrent();
          policy.assertAllowed();
          const owned = service.getSessionAttachmentStatus(
            caller.identity.sessionId,
            caller.identity.principalId,
            caller.identity.requiresIsolatedEnvironment,
          )?.environment;
          if (
            !owned ||
            owned.environmentId !== binding.environmentId ||
            owned.ownerEpoch !== binding.ownerEpoch ||
            owned.sharedHost !== false ||
            owned.state !== "ready" ||
            !owned.nodeDeviceId
          ) {
            throw new Error("Attached capability requires a current dedicated tool node");
          }
          return owned;
        };
        const owned = readCurrent();
        const nodeId = owned.nodeDeviceId;
        if (!nodeId) {
          throw new Error("Attached tool node unavailable");
        }
        const generation = await captureNodePairingGeneration(nodeId);
        readCurrent();
        if (!generation) {
          throw new Error("Attached tool node pairing is unavailable");
        }
        const node = context.nodeRegistry.getForPairingGeneration(nodeId, generation.key);
        if (!node) {
          throw new Error("Attached tool node is disconnected; reconnect it and retry");
        }
        const admittedConfig = context.getRuntimeConfig();
        const assertUploadAllowed = captureGatewayClientUploadCommitGuard({
          method: "node.invoke",
          requestParams: { ...params, nodeId },
          client: options.client,
          context,
        });
        const assertDispatch = () => {
          const current = readCurrent();
          if (
            current.nodeDeviceId !== nodeId ||
            context.nodeRegistry.getForPairingGeneration(nodeId, generation.key)?.connId !==
              node.connId
          ) {
            throw new Error("Attached tool node owner changed");
          }
          if (!node.commands.includes(params.command)) {
            throw new Error("Attached tool node does not support the requested capability");
          }
          if (params.command !== NODE_COMPUTER_RESOURCE_FETCH_COMMAND) {
            for (const config of [admittedConfig, context.getRuntimeConfig()]) {
              const allowed = isNodeCommandAllowed({
                command: params.command,
                declaredCommands: node.commands,
                allowlist: resolveNodeCommandAllowlist(config, {
                  ...node,
                  approvedCommands: node.commands,
                }),
              });
              if (!allowed.ok) {
                throw new Error("Attached tool capability is disabled by node policy");
              }
            }
          }
          if (
            params.command === "browser.proxy" &&
            isForbiddenBrowserProxyMutation(params.params)
          ) {
            throw new Error(
              "Persistent browser profile mutations are unavailable through this route",
            );
          }
          assertUploadAllowed?.();
        };
        assertDispatch();
        await attachment.touch();
        assertDispatch();
        const signals = [caller.signal, attachment.signal].filter((signal): signal is AbortSignal =>
          Boolean(signal),
        );
        const result = await context.nodeRegistry.invoke({
          nodeId,
          expectedConnId: node.connId,
          expectedPairingGeneration: generation.key,
          command: params.command,
          params: params.params,
          timeoutMs: params.timeoutMs ?? 120_000,
          ...(signals.length ? { signal: AbortSignal.any(signals) } : {}),
          sessionKey: caller.identity.sessionKey,
          idempotencyKey: createHash("sha256")
            .update(
              JSON.stringify([
                caller.identity.sessionId,
                caller.identity.principalId,
                binding.environmentId,
                binding.ownerEpoch,
                binding.generation,
                params.command,
                params.params,
                params.timeoutMs,
                params.idempotencyKey,
              ]),
            )
            .digest("hex"),
          isDispatchAuthorized: () => {
            assertDispatch();
            return true;
          },
        });
        assertDispatch();
        respond(true, {
          ...result,
          nodeId,
          connection: { nodeId, connectionId: node.connId },
          attachment: {
            environmentId: binding.environmentId,
            ownerEpoch: binding.ownerEpoch,
            generation: binding.generation,
          },
        });
      } finally {
        caller.release();
      }
    },
    (error) => errorShape(ErrorCodes.INVALID_REQUEST, boundedWorkerError(error)),
  ),
};
