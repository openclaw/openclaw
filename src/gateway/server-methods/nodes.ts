import {
  approveNodePairing,
  listNodePairing,
  rejectNodePairing,
  renamePairedNode,
  requestNodePairing,
  verifyNodeToken,
} from "../../infra/node-pairing.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateNodeDescribeParams,
  validateNodeInvokeParams,
  validateNodeListParams,
  validateNodePairApproveParams,
  validateNodePairListParams,
  validateNodePairRejectParams,
  validateNodePairRequestParams,
  validateNodePairVerifyParams,
  validateNodeRenameParams,
} from "../protocol/index.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandlers } from "./types.js";

export const nodeHandlers: GatewayRequestHandlers = {
  "node.pair.request": async ({ params, respond, context }) => {
    if (!validateNodePairRequestParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid node.pair.request params: ${formatValidationErrors(validateNodePairRequestParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      nodeId: string;
      displayName?: string;
      platform?: string;
      version?: string;
      deviceFamily?: string;
      modelIdentifier?: string;
      caps?: string[];
      commands?: string[];
      remoteIp?: string;
      silent?: boolean;
    };
    try {
      const result = await requestNodePairing({
        nodeId: p.nodeId,
        displayName: p.displayName,
        platform: p.platform,
        version: p.version,
        deviceFamily: p.deviceFamily,
        modelIdentifier: p.modelIdentifier,
        caps: p.caps,
        commands: p.commands,
        remoteIp: p.remoteIp,
        silent: p.silent,
      });
      if (result.status === "pending" && result.created) {
        context.broadcast("node.pair.requested", result.request, {
          dropIfSlow: true,
        });
      }
      respond(true, result, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
      );
    }
  },
  "node.pair.list": async ({ params, respond }) => {
    if (!validateNodePairListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid node.pair.list params: ${formatValidationErrors(validateNodePairListParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const list = await listNodePairing();
      respond(true, list, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
      );
    }
  },
  "node.pair.approve": async ({ params, respond, context }) => {
    if (!validateNodePairApproveParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid node.pair.approve params: ${formatValidationErrors(validateNodePairApproveParams.errors)}`,
        ),
      );
      return;
    }
    const { requestId } = params as { requestId: string };
    try {
      const approved = await approveNodePairing(requestId);
      if (!approved) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "unknown requestId"),
        );
        return;
      }
      context.broadcast(
        "node.pair.resolved",
        {
          requestId,
          nodeId: approved.node.nodeId,
          decision: "approved",
          ts: Date.now(),
        },
        { dropIfSlow: true },
      );
      respond(true, approved, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
      );
    }
  },
  "node.pair.reject": async ({ params, respond, context }) => {
    if (!validateNodePairRejectParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid node.pair.reject params: ${formatValidationErrors(validateNodePairRejectParams.errors)}`,
        ),
      );
      return;
    }
    const { requestId } = params as { requestId: string };
    try {
      const rejected = await rejectNodePairing(requestId);
      if (!rejected) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "unknown requestId"),
        );
        return;
      }
      context.broadcast(
        "node.pair.resolved",
        {
          requestId,
          nodeId: rejected.nodeId,
          decision: "rejected",
          ts: Date.now(),
        },
        { dropIfSlow: true },
      );
      respond(true, rejected, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
      );
    }
  },
  "node.pair.verify": async ({ params, respond }) => {
    if (!validateNodePairVerifyParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid node.pair.verify params: ${formatValidationErrors(validateNodePairVerifyParams.errors)}`,
        ),
      );
      return;
    }
    const { nodeId, token } = params as {
      nodeId: string;
      token: string;
    };
    try {
      const result = await verifyNodeToken(nodeId, token);
      respond(true, result, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
      );
    }
  },
  "node.rename": async ({ params, respond }) => {
    if (!validateNodeRenameParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid node.rename params: ${formatValidationErrors(validateNodeRenameParams.errors)}`,
        ),
      );
      return;
    }
    const { nodeId, displayName } = params as {
      nodeId: string;
      displayName: string;
    };
    try {
      const trimmed = displayName.trim();
      if (!trimmed) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "displayName required"),
        );
        return;
      }
      const updated = await renamePairedNode(nodeId, trimmed);
      if (!updated) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "unknown nodeId"),
        );
        return;
      }
      respond(
        true,
        { nodeId: updated.nodeId, displayName: updated.displayName },
        undefined,
      );
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
      );
    }
  },
  "node.list": async ({ params, respond, context }) => {
    if (!validateNodeListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid node.list params: ${formatValidationErrors(validateNodeListParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const list = await listNodePairing();
      const pairedById = new Map(list.paired.map((n) => [n.nodeId, n]));
      const connected = context.bridge?.listConnected?.() ?? [];
      const connectedById = new Map(connected.map((n) => [n.nodeId, n]));
      const nodeIds = new Set<string>([
        ...pairedById.keys(),
        ...connectedById.keys(),
      ]);

      const nodes = [...nodeIds].map((nodeId) => {
        const paired = pairedById.get(nodeId);
        const live = connectedById.get(nodeId);

        const caps = [
          ...new Set(
            (live?.caps ?? paired?.caps ?? [])
              .map((c) => String(c).trim())
              .filter(Boolean),
          ),
        ].sort();

        const commands = [
          ...new Set(
            (live?.commands ?? paired?.commands ?? [])
              .map((c) => String(c).trim())
              .filter(Boolean),
          ),
        ].sort();

        return {
          nodeId,
          displayName: live?.displayName ?? paired?.displayName,
          platform: live?.platform ?? paired?.platform,
          version: live?.version ?? paired?.version,
          deviceFamily: live?.deviceFamily ?? paired?.deviceFamily,
          modelIdentifier: live?.modelIdentifier ?? paired?.modelIdentifier,
          remoteIp: live?.remoteIp ?? paired?.remoteIp,
          caps,
          commands,
          permissions: live?.permissions ?? paired?.permissions,
          paired: Boolean(paired),
          connected: Boolean(live),
        };
      });

      nodes.sort((a, b) => {
        if (a.connected !== b.connected) return a.connected ? -1 : 1;
        const an = (a.displayName ?? a.nodeId).toLowerCase();
        const bn = (b.displayName ?? b.nodeId).toLowerCase();
        if (an < bn) return -1;
        if (an > bn) return 1;
        return a.nodeId.localeCompare(b.nodeId);
      });

      respond(true, { ts: Date.now(), nodes }, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
      );
    }
  },
  "node.describe": async ({ params, respond, context }) => {
    if (!validateNodeDescribeParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid node.describe params: ${formatValidationErrors(validateNodeDescribeParams.errors)}`,
        ),
      );
      return;
    }
    const { nodeId } = params as { nodeId: string };
    const id = String(nodeId ?? "").trim();
    if (!id) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"),
      );
      return;
    }
    try {
      const list = await listNodePairing();
      const paired = list.paired.find((n) => n.nodeId === id);
      const connected = context.bridge?.listConnected?.() ?? [];
      const live = connected.find((n) => n.nodeId === id);

      if (!paired && !live) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "unknown nodeId"),
        );
        return;
      }

      const caps = [
        ...new Set(
          (live?.caps ?? paired?.caps ?? [])
            .map((c) => String(c).trim())
            .filter(Boolean),
        ),
      ].sort();

      const commands = [
        ...new Set(
          (live?.commands ?? paired?.commands ?? [])
            .map((c) => String(c).trim())
            .filter(Boolean),
        ),
      ].sort();

      respond(
        true,
        {
          ts: Date.now(),
          nodeId: id,
          displayName: live?.displayName ?? paired?.displayName,
          platform: live?.platform ?? paired?.platform,
          version: live?.version ?? paired?.version,
          deviceFamily: live?.deviceFamily ?? paired?.deviceFamily,
          modelIdentifier: live?.modelIdentifier ?? paired?.modelIdentifier,
          remoteIp: live?.remoteIp ?? paired?.remoteIp,
          caps,
          commands,
          permissions: live?.permissions ?? paired?.permissions,
          paired: Boolean(paired),
          connected: Boolean(live),
        },
        undefined,
      );
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
      );
    }
  },
  "node.invoke": async ({ params, respond, context }) => {
    if (!validateNodeInvokeParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid node.invoke params: ${formatValidationErrors(validateNodeInvokeParams.errors)}`,
        ),
      );
      return;
    }
    if (!context.bridge) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "bridge not running"),
      );
      return;
    }
    const p = params as {
      nodeId: string;
      command: string;
      params?: unknown;
      timeoutMs?: number;
      idempotencyKey: string;
    };
    const nodeId = String(p.nodeId ?? "").trim();
    const command = String(p.command ?? "").trim();
    if (!nodeId || !command) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "nodeId and command required"),
      );
      return;
    }

    try {
      const paramsJSON =
        "params" in p && p.params !== undefined
          ? JSON.stringify(p.params)
          : null;
      const res = await context.bridge.invoke({
        nodeId,
        command,
        paramsJSON,
        timeoutMs: p.timeoutMs,
      });
      if (!res.ok) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            res.error?.message ?? "node invoke failed",
            { details: { nodeError: res.error ?? null } },
          ),
        );
        return;
      }
      const payload =
        typeof res.payloadJSON === "string" && res.payloadJSON.trim()
          ? (() => {
              try {
                return JSON.parse(res.payloadJSON) as unknown;
              } catch {
                return { payloadJSON: res.payloadJSON };
              }
            })()
          : undefined;
      respond(
        true,
        {
          ok: true,
          nodeId,
          command,
          payload,
          payloadJSON: res.payloadJSON ?? null,
        },
        undefined,
      );
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)),
      );
    }
  },
};
