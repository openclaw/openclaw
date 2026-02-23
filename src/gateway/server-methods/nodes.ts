import { loadConfig } from "../../config/config.js";
import { listDevicePairing } from "../../infra/device-pairing.js";
import {
  approveNodePairing,
  listNodePairing,
  rejectNodePairing,
  renamePairedNode,
  requestNodePairing,
  verifyNodeToken,
} from "../../infra/node-pairing.js";
import {
  loadApnsRegistration,
  resolveApnsAuthConfigFromEnv,
  sendApnsAlert,
  sendApnsBackgroundWake,
} from "../../infra/push-apns.js";
import { isNodeCommandAllowed, resolveNodeCommandAllowlist } from "../node-command-policy.js";
import { sanitizeNodeInvokeParamsForForwarding } from "../node-invoke-sanitize.js";
import {
  ErrorCodes,
  errorShape,
  validateNodeDescribeParams,
  validateNodeEventParams,
  validateNodeInvokeParams,
  validateNodeListParams,
  validateNodePairApproveParams,
  validateNodePairListParams,
  validateNodePairRejectParams,
  validateNodePairRequestParams,
  validateNodePairVerifyParams,
  validateNodeRenameParams,
} from "../protocol/index.js";
import { handleNodeInvokeResult } from "./nodes.handlers.invoke-result.js";
import {
  respondInvalidParams,
  respondUnavailableOnNodeInvokeError,
  respondUnavailableOnThrow,
  safeParseJson,
  uniqueSortedStrings,
} from "./nodes.helpers.js";
import type { GatewayRequestHandlers } from "./types.js";

const NODE_WAKE_RECONNECT_WAIT_MS = 3_000;
const NODE_WAKE_RECONNECT_RETRY_WAIT_MS = 12_000;
const NODE_WAKE_RECONNECT_POLL_MS = 150;
const NODE_WAKE_THROTTLE_MS = 15_000;
const NODE_WAKE_NUDGE_THROTTLE_MS = 10 * 60_000;

type NodeWakeState = {
  lastWakeAtMs: number;
  inFlight?: Promise<NodeWakeAttempt>;
};

const nodeWakeById = new Map<string, NodeWakeState>();
const nodeWakeNudgeById = new Map<string, number>();

type NodeWakeAttempt = {
  available: boolean;
  throttled: boolean;
  path: "throttled" | "no-registration" | "no-auth" | "sent" | "send-error";
  durationMs: number;
  apnsStatus?: number;
  apnsReason?: string;
};

type NodeWakeNudgeAttempt = {
  sent: boolean;
  throttled: boolean;
  reason: "throttled" | "no-registration" | "no-auth" | "send-error" | "apns-not-ok" | "sent";
  durationMs: number;
  apnsStatus?: number;
  apnsReason?: string;
};

function isNodeEntry(entry: { role?: string; roles?: string[] }) {
  if (entry.role === "node") {
    return true;
  }
  if (Array.isArray(entry.roles) && entry.roles.includes("node")) {
    return true;
  }
  return false;
}

async function delayMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function maybeWakeNodeWithApns(
  nodeId: string,
  opts?: { force?: boolean },
): Promise<NodeWakeAttempt> {
  const state = nodeWakeById.get(nodeId) ?? { lastWakeAtMs: 0 };
  nodeWakeById.set(nodeId, state);

  if (state.inFlight) {
    return await state.inFlight;
  }

  const now = Date.now();
  const force = opts?.force === true;
  if (!force && state.lastWakeAtMs > 0 && now - state.lastWakeAtMs < NODE_WAKE_THROTTLE_MS) {
    return { available: true, throttled: true, path: "throttled", durationMs: 0 };
  }

  state.inFlight = (async () => {
    const startedAtMs = Date.now();
    const withDuration = (attempt: Omit<NodeWakeAttempt, "durationMs">): NodeWakeAttempt => ({
      ...attempt,
      durationMs: Math.max(0, Date.now() - startedAtMs),
    });

    try {
      const registration = await loadApnsRegistration(nodeId);
      if (!registration) {
        return withDuration({ available: false, throttled: false, path: "no-registration" });
      }

      const auth = await resolveApnsAuthConfigFromEnv(process.env);
      if (!auth.ok) {
        return withDuration({
          available: false,
          throttled: false,
          path: "no-auth",
          apnsReason: auth.error,
        });
      }

      state.lastWakeAtMs = Date.now();
      const wakeResult = await sendApnsBackgroundWake({
        auth: auth.value,
        registration,
        nodeId,
        wakeReason: "node.invoke",
      });
      if (!wakeResult.ok) {
        return withDuration({
          available: true,
          throttled: false,
          path: "send-error",
          apnsStatus: wakeResult.status,
          apnsReason: wakeResult.reason,
        });
      }
      return withDuration({
        available: true,
        throttled: false,
        path: "sent",
        apnsStatus: wakeResult.status,
        apnsReason: wakeResult.reason,
      });
    } catch (err) {
      // Best-effort wake only.
      const message = err instanceof Error ? err.message : String(err);
      if (state.lastWakeAtMs === 0) {
        return withDuration({
          available: false,
          throttled: false,
          path: "send-error",
          apnsReason: message,
        });
      }
      return withDuration({
        available: true,
        throttled: false,
        path: "send-error",
        apnsReason: message,
      });
    }
  })();

  try {
    return await state.inFlight;
  } finally {
    state.inFlight = undefined;
  }
}

async function maybeSendNodeWakeNudge(nodeId: string): Promise<NodeWakeNudgeAttempt> {
  const startedAtMs = Date.now();
  const withDuration = (
    attempt: Omit<NodeWakeNudgeAttempt, "durationMs">,
  ): NodeWakeNudgeAttempt => ({
    ...attempt,
    durationMs: Math.max(0, Date.now() - startedAtMs),
  });

  const lastNudgeAtMs = nodeWakeNudgeById.get(nodeId) ?? 0;
  if (lastNudgeAtMs > 0 && Date.now() - lastNudgeAtMs < NODE_WAKE_NUDGE_THROTTLE_MS) {
    return withDuration({ sent: false, throttled: true, reason: "throttled" });
  }

  const registration = await loadApnsRegistration(nodeId);
  if (!registration) {
    return withDuration({ sent: false, throttled: false, reason: "no-registration" });
  }
  const auth = await resolveApnsAuthConfigFromEnv(process.env);
  if (!auth.ok) {
    return withDuration({
      sent: false,
      throttled: false,
      reason: "no-auth",
      apnsReason: auth.error,
    });
  }

  try {
    const result = await sendApnsAlert({
      auth: auth.value,
      registration,
      nodeId,
      title: "OpenClaw needs a quick reopen",
      body: "Tap to reopen OpenClaw and restore the node connection.",
    });
    if (!result.ok) {
      return withDuration({
        sent: false,
        throttled: false,
        reason: "apns-not-ok",
        apnsStatus: result.status,
        apnsReason: result.reason,
      });
    }
    nodeWakeNudgeById.set(nodeId, Date.now());
    return withDuration({
      sent: true,
      throttled: false,
      reason: "sent",
      apnsStatus: result.status,
      apnsReason: result.reason,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return withDuration({
      sent: false,
      throttled: false,
      reason: "send-error",
      apnsReason: message,
    });
  }
}

async function waitForNodeReconnect(params: {
  nodeId: string;
  context: { nodeRegistry: { get: (nodeId: string) => unknown } };
  timeoutMs?: number;
  pollMs?: number;
}): Promise<boolean> {
  const timeoutMs = Math.max(250, params.timeoutMs ?? NODE_WAKE_RECONNECT_WAIT_MS);
  const pollMs = Math.max(50, params.pollMs ?? NODE_WAKE_RECONNECT_POLL_MS);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (params.context.nodeRegistry.get(params.nodeId)) {
      return true;
    }
    await delayMs(pollMs);
  }
  return Boolean(params.context.nodeRegistry.get(params.nodeId));
}

export const nodeHandlers: GatewayRequestHandlers = {
  "node.pair.request": async ({ params, respond, context }) => {
    if (!validateNodePairRequestParams(params)) {
      respondInvalidParams({
        respond,
        method: "node.pair.request",
        validator: validateNodePairRequestParams,
      });
      return;
    }
    const p = params as {
      nodeId: string;
      displayName?: string;
      platform?: string;
      version?: string;
      coreVersion?: string;
      uiVersion?: string;
      deviceFamily?: string;
      modelIdentifier?: string;
      caps?: string[];
      commands?: string[];
      remoteIp?: string;
      silent?: boolean;
    };
    await respondUnavailableOnThrow(respond, async () => {
      const result = await requestNodePairing({
        nodeId: p.nodeId,
        displayName: p.displayName,
        platform: p.platform,
        version: p.version,
        coreVersion: p.coreVersion,
        uiVersion: p.uiVersion,
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
    });
  },
  "node.pair.list": async ({ params, respond }) => {
    if (!validateNodePairListParams(params)) {
      respondInvalidParams({
        respond,
        method: "node.pair.list",
        validator: validateNodePairListParams,
      });
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      const list = await listNodePairing();
      respond(true, list, undefined);
    });
  },
  "node.pair.approve": async ({ params, respond, context }) => {
    if (!validateNodePairApproveParams(params)) {
      respondInvalidParams({
        respond,
        method: "node.pair.approve",
        validator: validateNodePairApproveParams,
      });
      return;
    }
    const { requestId } = params as { requestId: string };
    await respondUnavailableOnThrow(respond, async () => {
      const approved = await approveNodePairing(requestId);
      if (!approved) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown requestId"));
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
    });
  },
  "node.pair.reject": async ({ params, respond, context }) => {
    if (!validateNodePairRejectParams(params)) {
      respondInvalidParams({
        respond,
        method: "node.pair.reject",
        validator: validateNodePairRejectParams,
      });
      return;
    }
    const { requestId } = params as { requestId: string };
    await respondUnavailableOnThrow(respond, async () => {
      const rejected = await rejectNodePairing(requestId);
      if (!rejected) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown requestId"));
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
    });
  },
  "node.pair.verify": async ({ params, respond }) => {
    if (!validateNodePairVerifyParams(params)) {
      respondInvalidParams({
        respond,
        method: "node.pair.verify",
        validator: validateNodePairVerifyParams,
      });
      return;
    }
    const { nodeId, token } = params as {
      nodeId: string;
      token: string;
    };
    await respondUnavailableOnThrow(respond, async () => {
      const result = await verifyNodeToken(nodeId, token);
      respond(true, result, undefined);
    });
  },
  "node.rename": async ({ params, respond }) => {
    if (!validateNodeRenameParams(params)) {
      respondInvalidParams({
        respond,
        method: "node.rename",
        validator: validateNodeRenameParams,
      });
      return;
    }
    const { nodeId, displayName } = params as {
      nodeId: string;
      displayName: string;
    };
    await respondUnavailableOnThrow(respond, async () => {
      const trimmed = displayName.trim();
      if (!trimmed) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "displayName required"));
        return;
      }
      const updated = await renamePairedNode(nodeId, trimmed);
      if (!updated) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown nodeId"));
        return;
      }
      respond(true, { nodeId: updated.nodeId, displayName: updated.displayName }, undefined);
    });
  },
  "node.list": async ({ params, respond, context }) => {
    if (!validateNodeListParams(params)) {
      respondInvalidParams({
        respond,
        method: "node.list",
        validator: validateNodeListParams,
      });
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      const list = await listDevicePairing();
      const pairedById = new Map(
        list.paired
          .filter((entry) => isNodeEntry(entry))
          .map((entry) => [
            entry.deviceId,
            {
              nodeId: entry.deviceId,
              displayName: entry.displayName,
              platform: entry.platform,
              version: undefined,
              coreVersion: undefined,
              uiVersion: undefined,
              deviceFamily: undefined,
              modelIdentifier: undefined,
              remoteIp: entry.remoteIp,
              caps: [],
              commands: [],
              permissions: undefined,
            },
          ]),
      );
      const connected = context.nodeRegistry.listConnected();
      const connectedById = new Map(connected.map((n) => [n.nodeId, n]));
      const nodeIds = new Set<string>([...pairedById.keys(), ...connectedById.keys()]);

      const nodes = [...nodeIds].map((nodeId) => {
        const paired = pairedById.get(nodeId);
        const live = connectedById.get(nodeId);

        const caps = uniqueSortedStrings([...(live?.caps ?? paired?.caps ?? [])]);
        const commands = uniqueSortedStrings([...(live?.commands ?? paired?.commands ?? [])]);

        return {
          nodeId,
          displayName: live?.displayName ?? paired?.displayName,
          platform: live?.platform ?? paired?.platform,
          version: live?.version ?? paired?.version,
          coreVersion: live?.coreVersion ?? paired?.coreVersion,
          uiVersion: live?.uiVersion ?? paired?.uiVersion,
          deviceFamily: live?.deviceFamily ?? paired?.deviceFamily,
          modelIdentifier: live?.modelIdentifier ?? paired?.modelIdentifier,
          remoteIp: live?.remoteIp ?? paired?.remoteIp,
          caps,
          commands,
          pathEnv: live?.pathEnv,
          permissions: live?.permissions ?? paired?.permissions,
          connectedAtMs: live?.connectedAtMs,
          paired: Boolean(paired),
          connected: Boolean(live),
        };
      });

      nodes.sort((a, b) => {
        if (a.connected !== b.connected) {
          return a.connected ? -1 : 1;
        }
        const an = (a.displayName ?? a.nodeId).toLowerCase();
        const bn = (b.displayName ?? b.nodeId).toLowerCase();
        if (an < bn) {
          return -1;
        }
        if (an > bn) {
          return 1;
        }
        return a.nodeId.localeCompare(b.nodeId);
      });

      respond(true, { ts: Date.now(), nodes }, undefined);
    });
  },
  "node.describe": async ({ params, respond, context }) => {
    if (!validateNodeDescribeParams(params)) {
      respondInvalidParams({
        respond,
        method: "node.describe",
        validator: validateNodeDescribeParams,
      });
      return;
    }
    const { nodeId } = params as { nodeId: string };
    const id = String(nodeId ?? "").trim();
    if (!id) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"));
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      const list = await listDevicePairing();
      const paired = list.paired.find((n) => n.deviceId === id && isNodeEntry(n));
      const connected = context.nodeRegistry.listConnected();
      const live = connected.find((n) => n.nodeId === id);

      if (!paired && !live) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown nodeId"));
        return;
      }

      const caps = uniqueSortedStrings([...(live?.caps ?? [])]);
      const commands = uniqueSortedStrings([...(live?.commands ?? [])]);

      respond(
        true,
        {
          ts: Date.now(),
          nodeId: id,
          displayName: live?.displayName ?? paired?.displayName,
          platform: live?.platform ?? paired?.platform,
          version: live?.version,
          coreVersion: live?.coreVersion,
          uiVersion: live?.uiVersion,
          deviceFamily: live?.deviceFamily,
          modelIdentifier: live?.modelIdentifier,
          remoteIp: live?.remoteIp ?? paired?.remoteIp,
          caps,
          commands,
          pathEnv: live?.pathEnv,
          permissions: live?.permissions,
          connectedAtMs: live?.connectedAtMs,
          paired: Boolean(paired),
          connected: Boolean(live),
        },
        undefined,
      );
    });
  },
  "node.invoke": async ({ params, respond, context, client, req }) => {
    if (!validateNodeInvokeParams(params)) {
      respondInvalidParams({
        respond,
        method: "node.invoke",
        validator: validateNodeInvokeParams,
      });
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
    if (command === "system.execApprovals.get" || command === "system.execApprovals.set") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "node.invoke does not allow system.execApprovals.*; use exec.approvals.node.*",
          { details: { command } },
        ),
      );
      return;
    }

    await respondUnavailableOnThrow(respond, async () => {
      let nodeSession = context.nodeRegistry.get(nodeId);
      if (!nodeSession) {
        const wakeReqId = req.id;
        const wakeFlowStartedAtMs = Date.now();
        context.logGateway.info(
          `node wake start node=${nodeId} req=${wakeReqId} command=${command}`,
        );

        const wake = await maybeWakeNodeWithApns(nodeId);
        context.logGateway.info(
          `node wake stage=wake1 node=${nodeId} req=${wakeReqId} ` +
            `available=${wake.available} throttled=${wake.throttled} ` +
            `path=${wake.path} durationMs=${wake.durationMs} ` +
            `apnsStatus=${wake.apnsStatus ?? -1} apnsReason=${wake.apnsReason ?? "-"}`,
        );
        if (wake.available) {
          const waitStartedAtMs = Date.now();
          const waitTimeoutMs = NODE_WAKE_RECONNECT_WAIT_MS;
          const reconnected = await waitForNodeReconnect({
            nodeId,
            context,
            timeoutMs: waitTimeoutMs,
          });
          const waitDurationMs = Math.max(0, Date.now() - waitStartedAtMs);
          context.logGateway.info(
            `node wake stage=wait1 node=${nodeId} req=${wakeReqId} ` +
              `reconnected=${reconnected} timeoutMs=${waitTimeoutMs} durationMs=${waitDurationMs}`,
          );
        }
        nodeSession = context.nodeRegistry.get(nodeId);
        if (!nodeSession && wake.available) {
          const retryWake = await maybeWakeNodeWithApns(nodeId, { force: true });
          context.logGateway.info(
            `node wake stage=wake2 node=${nodeId} req=${wakeReqId} force=true ` +
              `available=${retryWake.available} throttled=${retryWake.throttled} ` +
              `path=${retryWake.path} durationMs=${retryWake.durationMs} ` +
              `apnsStatus=${retryWake.apnsStatus ?? -1} apnsReason=${retryWake.apnsReason ?? "-"}`,
          );
          if (retryWake.available) {
            const waitStartedAtMs = Date.now();
            const waitTimeoutMs = NODE_WAKE_RECONNECT_RETRY_WAIT_MS;
            const reconnected = await waitForNodeReconnect({
              nodeId,
              context,
              timeoutMs: waitTimeoutMs,
            });
            const waitDurationMs = Math.max(0, Date.now() - waitStartedAtMs);
            context.logGateway.info(
              `node wake stage=wait2 node=${nodeId} req=${wakeReqId} ` +
                `reconnected=${reconnected} timeoutMs=${waitTimeoutMs} durationMs=${waitDurationMs}`,
            );
          }
          nodeSession = context.nodeRegistry.get(nodeId);
        }
        if (!nodeSession) {
          const totalDurationMs = Math.max(0, Date.now() - wakeFlowStartedAtMs);
          const nudge = await maybeSendNodeWakeNudge(nodeId);
          context.logGateway.info(
            `node wake nudge node=${nodeId} req=${wakeReqId} sent=${nudge.sent} ` +
              `throttled=${nudge.throttled} reason=${nudge.reason} durationMs=${nudge.durationMs} ` +
              `apnsStatus=${nudge.apnsStatus ?? -1} apnsReason=${nudge.apnsReason ?? "-"}`,
          );
          context.logGateway.warn(
            `node wake done node=${nodeId} req=${wakeReqId} connected=false ` +
              `reason=not_connected totalMs=${totalDurationMs}`,
          );
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.UNAVAILABLE, "node not connected", {
              details: { code: "NOT_CONNECTED" },
            }),
          );
          return;
        }

        const totalDurationMs = Math.max(0, Date.now() - wakeFlowStartedAtMs);
        context.logGateway.info(
          `node wake done node=${nodeId} req=${wakeReqId} connected=true totalMs=${totalDurationMs}`,
        );
      }
      const cfg = loadConfig();
      const allowlist = resolveNodeCommandAllowlist(cfg, nodeSession);
      const allowed = isNodeCommandAllowed({
        command,
        declaredCommands: nodeSession.commands,
        allowlist,
      });
      if (!allowed.ok) {
        const hint = buildNodeCommandRejectionHint(allowed.reason, command, nodeSession);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, hint, {
            details: { reason: allowed.reason, command },
          }),
        );
        return;
      }
      const forwardedParams = sanitizeNodeInvokeParamsForForwarding({
        command,
        rawParams: p.params,
        client,
        execApprovalManager: context.execApprovalManager,
      });
      if (!forwardedParams.ok) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, forwardedParams.message, {
            details: forwardedParams.details ?? null,
          }),
        );
        return;
      }
      const res = await context.nodeRegistry.invoke({
        nodeId,
        command,
        params: forwardedParams.params,
        timeoutMs: p.timeoutMs,
        idempotencyKey: p.idempotencyKey,
      });
      if (!respondUnavailableOnNodeInvokeError(respond, res)) {
        return;
      }
      const payload = res.payloadJSON ? safeParseJson(res.payloadJSON) : res.payload;
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
    });
  },
  "node.invoke.result": handleNodeInvokeResult,
  "node.event": async ({ params, respond, context, client }) => {
    if (!validateNodeEventParams(params)) {
      respondInvalidParams({
        respond,
        method: "node.event",
        validator: validateNodeEventParams,
      });
      return;
    }
    const p = params as { event: string; payload?: unknown; payloadJSON?: string | null };
    const payloadJSON =
      typeof p.payloadJSON === "string"
        ? p.payloadJSON
        : p.payload !== undefined
          ? JSON.stringify(p.payload)
          : null;
    await respondUnavailableOnThrow(respond, async () => {
      const { handleNodeEvent } = await import("../server-node-events.js");
      const nodeId = client?.connect?.device?.id ?? client?.connect?.client?.id ?? "node";
      const nodeContext = {
        deps: context.deps,
        broadcast: context.broadcast,
        nodeSendToSession: context.nodeSendToSession,
        nodeSubscribe: context.nodeSubscribe,
        nodeUnsubscribe: context.nodeUnsubscribe,
        broadcastVoiceWakeChanged: context.broadcastVoiceWakeChanged,
        addChatRun: context.addChatRun,
        removeChatRun: context.removeChatRun,
        chatAbortControllers: context.chatAbortControllers,
        chatAbortedRuns: context.chatAbortedRuns,
        chatRunBuffers: context.chatRunBuffers,
        chatDeltaSentAt: context.chatDeltaSentAt,
        dedupe: context.dedupe,
        agentRunSeq: context.agentRunSeq,
        getHealthCache: context.getHealthCache,
        refreshHealthSnapshot: context.refreshHealthSnapshot,
        loadGatewayModelCatalog: context.loadGatewayModelCatalog,
        logGateway: { warn: context.logGateway.warn },
      };
      await handleNodeEvent(nodeContext, nodeId, {
        event: p.event,
        payloadJSON,
      });
      respond(true, { ok: true }, undefined);
    });
  },
};

function buildNodeCommandRejectionHint(
  reason: string,
  command: string,
  node: { platform?: string } | undefined,
): string {
  const platform = node?.platform ?? "unknown";
  if (reason === "command not declared by node") {
    return `node command not allowed: the node (platform: ${platform}) does not support "${command}"`;
  }
  if (reason === "command not allowlisted") {
    return `node command not allowed: "${command}" is not in the allowlist for platform "${platform}"`;
  }
  if (reason === "node did not declare commands") {
    return `node command not allowed: the node did not declare any supported commands`;
  }
  return `node command not allowed: ${reason}`;
}
