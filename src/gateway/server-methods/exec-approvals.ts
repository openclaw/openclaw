import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  ErrorCodes,
  errorShape,
  validateExecApprovalsGetParams,
  validateExecApprovalsNodeGetParams,
  validateExecApprovalsNodeSnapshot,
  validateExecApprovalsNodeSetParams,
  validateExecApprovalsSetParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  ensureExecApprovalsSnapshot,
  normalizeExecApprovals,
  readExecApprovalsSnapshotAsync,
  redactExecApprovals,
  resolveExecApprovalsFromFile,
  updateExecApprovals,
  type ExecApprovalsFile,
  type ExecApprovalsSnapshot,
} from "../../infra/exec-approvals.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { isNodeCommandAllowed, resolveNodeCommandAllowlist } from "../node-command-policy.js";
import type { NodeSession } from "../node-registry.js";
import { resolveBaseHashParam } from "./base-hash.js";
import {
  captureLocalStateMutationGuard,
  localStateOwnerChangedError,
} from "./local-state-owner.js";
import {
  respondUnavailableOnNodeInvokeErrorWithProvenance,
  parseGatewayPayload,
} from "./nodes.helpers.js";
import { respondUnavailableOnThrow } from "./response.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams, defineValidatedGatewayHandler, type Validator } from "./validation.js";

function requireApprovalsBaseHash(
  params: unknown,
  snapshot: ExecApprovalsSnapshot,
  respond: RespondFn,
): boolean {
  // Approval allowlists are admin-editable state. Require the caller's last
  // observed hash before writing so stale UI tabs cannot overwrite changes.
  const baseHash = resolveBaseHashParam(params);
  if (snapshot.exists && (!snapshot.hash || !baseHash)) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `exec approvals base hash ${snapshot.hash ? "required" : "unavailable"}; re-run exec.approvals.get and retry`,
      ),
    );
    return false;
  }
  if (baseHash && baseHash !== snapshot.hash) {
    respondApprovalsChanged(respond);
    return false;
  }
  return true;
}

function respondApprovalsChanged(respond: RespondFn): void {
  respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      "exec approvals changed since last load; re-run exec.approvals.get and retry",
    ),
  );
}

function toExecApprovalsPayload(snapshot: ExecApprovalsSnapshot) {
  return {
    ...redactExecApprovals(snapshot),
    resolvedDefaults: resolveExecApprovalsFromFile({ file: snapshot.file }).defaults,
  };
}

function captureExecApprovalsOwnerGuard(
  expectedOwnerId: string | undefined,
  options: GatewayRequestHandlerOptions,
): { assertCurrent: () => void; assertPreparationCurrent: () => void } | null {
  const authority = readGatewayRequestMutationAuthority(options);
  try {
    const assertOwner = expectedOwnerId
      ? captureLocalStateMutationGuard(expectedOwnerId, options)
      : undefined;
    return {
      assertPreparationCurrent: authority.assertPreparationCurrent,
      assertCurrent: () => {
        if (authority.family === "worker") {
          authority.assertWorkerCurrent();
          authority.expectedProfileBinding?.assertCurrent();
        } else {
          authority.assertCurrent();
        }
        assertOwner?.();
      },
    };
  } catch (error) {
    options.respond(false, undefined, localStateOwnerChangedError(error));
    return null;
  }
}

function isMacAppNode(session: NodeSession | undefined): boolean {
  const platform = session?.platform?.trim().toLowerCase();
  return (
    session?.clientId === GATEWAY_CLIENT_IDS.MACOS_APP &&
    session.clientMode === GATEWAY_CLIENT_MODES.NODE &&
    (platform === "macos" || platform?.startsWith("macos ") === true)
  );
}

function execApprovalsNodeHandler<TParams extends { nodeId: string }>(definition: {
  method: string;
  validate: Validator<TParams>;
  command: "system.execApprovals.get" | "system.execApprovals.set";
  commandParams: (
    parsedParams: TParams,
    nodeSession: NodeSession | undefined,
  ) => Record<string, unknown>;
  validatePayload?: (payload: unknown) => boolean;
}) {
  return defineValidatedGatewayHandler(
    definition.method,
    definition.validate,
    async ({ params, context, respond }) => {
      const nodeId = params.nodeId.trim();
      if (!nodeId) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"));
        return;
      }
      const nodeSession = context.nodeRegistry.get(nodeId);
      if (nodeSession) {
        const allowed = isNodeCommandAllowed({
          command: definition.command,
          declaredCommands: nodeSession.commands,
          allowlist: resolveNodeCommandAllowlist(context.getRuntimeConfig(), {
            ...nodeSession,
            approvedCommands: nodeSession.commands,
          }),
        });
        if (!allowed.ok) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `node command not allowed: ${definition.command} (${allowed.reason})`,
              { details: { command: definition.command, reason: allowed.reason } },
            ),
          );
          return;
        }
      }
      await respondUnavailableOnThrow(respond, async () => {
        let nodeCommandDispatched = false;
        const res = await context.nodeRegistry.invoke({
          nodeId,
          ...(nodeSession
            ? {
                expectedConnId: nodeSession.connId,
                ...(nodeSession.pairingGeneration
                  ? { expectedPairingGeneration: nodeSession.pairingGeneration }
                  : {}),
              }
            : {}),
          command: definition.command,
          params: definition.commandParams(params, nodeSession),
          onDispatchReady: () => {
            nodeCommandDispatched = true;
          },
        });
        if (
          !respondUnavailableOnNodeInvokeErrorWithProvenance(respond, res, {
            nodeCommandDispatched,
          })
        ) {
          return;
        }
        const payload = res.payloadJSON ? parseGatewayPayload(res.payloadJSON) : res.payload;
        if (definition.validatePayload && !definition.validatePayload(payload)) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, "node returned invalid exec approvals payload"),
          );
          return;
        }
        respond(true, payload, undefined);
      });
    },
  );
}

export const execApprovalsHandlers: GatewayRequestHandlers = {
  "exec.approvals.get": async (options) => {
    const { params, respond } = options;
    if (!assertValidParams(params, validateExecApprovalsGetParams, "exec.approvals.get", respond)) {
      return;
    }
    const guard = captureExecApprovalsOwnerGuard(params.expectedOwnerId, options);
    if (guard === null) {
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      guard.assertPreparationCurrent();
      const snapshot = params.expectedOwnerId
        ? await readExecApprovalsSnapshotAsync()
        : await ensureExecApprovalsSnapshot(guard.assertCurrent, guard.assertPreparationCurrent);
      guard.assertCurrent();
      respond(true, toExecApprovalsPayload(snapshot), undefined);
    });
  },
  "exec.approvals.set": async (options) => {
    const { params, respond } = options;
    if (!assertValidParams(params, validateExecApprovalsSetParams, "exec.approvals.set", respond)) {
      return;
    }
    const guard = captureExecApprovalsOwnerGuard(params.expectedOwnerId, options);
    if (guard === null) {
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      // Do not ensure/create state before checking freshness: a rejected stale
      // save must not recreate a file that an operator deleted.
      guard.assertPreparationCurrent();
      const context = captureOpenClawStateWorkerContext();
      const snapshot = await readExecApprovalsSnapshotAsync(context);
      guard.assertPreparationCurrent();
      if (!requireApprovalsBaseHash(params, snapshot, respond)) {
        return;
      }
      const normalized = normalizeExecApprovals(params.file as ExecApprovalsFile);
      const nextSnapshot = await updateExecApprovals(
        {
          baseHash: snapshot.hash,
          ...guard,
          update: { kind: "replace", file: normalized, preserveSocket: true },
        },
        context,
      );
      if (!nextSnapshot) {
        // The locked CAS already proved this write lost a race. A later read can
        // observe bytes restored to the old hash and must not suppress the reply.
        respondApprovalsChanged(respond);
        return;
      }
      context.admission.assertCurrent();
      guard.assertCurrent();
      respond(true, toExecApprovalsPayload(nextSnapshot), undefined);
    });
  },
  "exec.approvals.node.get": execApprovalsNodeHandler({
    method: "exec.approvals.node.get",
    validate: validateExecApprovalsNodeGetParams,
    command: "system.execApprovals.get",
    // New Mac nodes expand this response only when asked, so older Gateways
    // continue receiving the strict legacy snapshot shape.
    commandParams: (_parsedParams, nodeSession) =>
      isMacAppNode(nodeSession) ? { includeResolvedDefaults: true } : {},
    validatePayload: validateExecApprovalsNodeSnapshot,
  }),
  "exec.approvals.node.set": execApprovalsNodeHandler({
    method: "exec.approvals.node.set",
    validate: validateExecApprovalsNodeSetParams,
    command: "system.execApprovals.set",
    // Host-native nodes own a different policy model. Preserve that model at
    // the node boundary instead of pretending it is an OpenClaw approvals file.
    commandParams: (parsedParams) =>
      "native" in parsedParams
        ? { ...parsedParams.native, baseHash: parsedParams.baseHash }
        : { file: parsedParams.file, baseHash: parsedParams.baseHash },
  }),
};
