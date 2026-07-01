// Plugin-provided node.invoke policy adapter.
// Lets plugin policies gate dangerous node commands before transport dispatch.
import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { PluginApprovalRequestPayload } from "../infra/plugin-approvals.js";
import { resolvePluginApprovalTimeoutMs } from "../infra/plugin-approvals.js";
import { getActiveRuntimePluginRegistry } from "../plugins/active-runtime-registry.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import type {
  OpenClawPluginNodeInvokeApprovalDecision,
  OpenClawPluginNodeInvokePolicyContext,
  OpenClawPluginNodeInvokePolicyResult,
  OpenClawPluginNodeInvokeTransportResult,
} from "../plugins/types.js";
import type { NodeSession } from "./node-registry.js";
import {
  bindApprovalRequesterMetadata,
  buildRequestedApprovalEvent,
  handlePendingApprovalRequest,
  registerPendingApprovalRecord,
} from "./server-methods/approval-shared.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./server-methods/types.js";

// Plugin node.invoke policies are the last gateway-side guard before a
// plugin-declared dangerous node command reaches the node transport.
function parseScopes(client: GatewayClient | null): string[] {
  return Array.isArray(client?.connect?.scopes)
    ? client.connect.scopes.filter((scope): scope is string => typeof scope === "string")
    : [];
}

function parsePayload(payloadJSON: string | null | undefined, payload: unknown): unknown {
  if (!payloadJSON) {
    return payload;
  }
  try {
    return JSON.parse(payloadJSON) as unknown;
  } catch {
    return payload;
  }
}

function readObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeRouteString(value: unknown): string | null {
  return normalizeOptionalString(value) ?? null;
}

function normalizeRouteThreadId(value: unknown): string | number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return normalizeOptionalString(value) ?? null;
}

function resolveNodeInvokeTurnSourceFields(
  rawParams: unknown,
): Pick<
  PluginApprovalRequestPayload,
  "turnSourceChannel" | "turnSourceTo" | "turnSourceAccountId" | "turnSourceThreadId"
> {
  const params = readObject(rawParams);
  return {
    turnSourceChannel: normalizeRouteString(params?.turnSourceChannel),
    turnSourceTo: normalizeRouteString(params?.turnSourceTo),
    turnSourceAccountId: normalizeRouteString(params?.turnSourceAccountId),
    turnSourceThreadId: normalizeRouteThreadId(params?.turnSourceThreadId),
  };
}

function readApprovalResponse(
  recordId: string,
  response: { ok: boolean; payload?: unknown } | null,
): { id: string; decision: OpenClawPluginNodeInvokeApprovalDecision | null } {
  if (!response?.ok || !response.payload || typeof response.payload !== "object") {
    return { id: recordId, decision: null };
  }
  const payload = response.payload as {
    id?: unknown;
    decision?: OpenClawPluginNodeInvokeApprovalDecision | null;
  };
  return {
    id: normalizeOptionalString(payload.id) ?? recordId,
    decision: payload.decision ?? null,
  };
}

// Dangerous commands must have an explicit policy. Without this check, a plugin
// could mark a command dangerous but rely on the gateway default allow path.
function findDangerousPluginNodeCommand(registry: PluginRegistry | null, command: string) {
  const normalizedCommand = command.trim();
  if (!normalizedCommand) {
    return null;
  }
  return (
    registry?.nodeHostCommands?.find(
      (entry) =>
        entry.command.dangerous === true && entry.command.command.trim() === normalizedCommand,
    ) ?? null
  );
}

function createApprovalRuntime(params: {
  context: GatewayRequestContext;
  client: GatewayClient | null;
  pluginId: string;
  rawParams: unknown;
}): OpenClawPluginNodeInvokePolicyContext["approvals"] | undefined {
  const manager = params.context.pluginApprovalManager;
  if (!manager) {
    return undefined;
  }
  return {
    async request(input) {
      const timeoutMs = resolvePluginApprovalTimeoutMs(input.timeoutMs);
      const turnSource = resolveNodeInvokeTurnSourceFields(params.rawParams);
      const request: PluginApprovalRequestPayload = {
        pluginId: params.pluginId,
        title: input.title.slice(0, 80),
        description: input.description.slice(0, 256),
        severity: input.severity ?? "warning",
        toolName: normalizeOptionalString(input.toolName) ?? null,
        toolCallId: normalizeOptionalString(input.toolCallId) ?? null,
        agentId: normalizeOptionalString(input.agentId) ?? null,
        sessionKey: normalizeOptionalString(input.sessionKey) ?? null,
        turnSourceChannel: turnSource.turnSourceChannel,
        turnSourceTo: turnSource.turnSourceTo,
        turnSourceAccountId: turnSource.turnSourceAccountId,
        turnSourceThreadId: turnSource.turnSourceThreadId,
      };
      const record = manager.create(request, timeoutMs, `plugin:${randomUUID()}`);
      bindApprovalRequesterMetadata({ record, client: params.client });
      let response: { ok: boolean; payload?: unknown } | null = null;
      const respond: RespondFn = (ok, payload) => {
        response = { ok, payload };
      };
      const decisionPromise = registerPendingApprovalRecord({
        manager,
        record,
        timeoutMs,
        respond,
      });
      if (!decisionPromise) {
        return { id: record.id, decision: null };
      }
      const requestEvent = buildRequestedApprovalEvent(record);
      await handlePendingApprovalRequest({
        manager,
        record,
        decisionPromise,
        respond,
        context: params.context,
        clientConnId: params.client?.connId,
        requestEventName: "plugin.approval.requested",
        requestEvent,
        twoPhase: false,
        approvalKind: "plugin",
        deliverRequest: () => false,
      });
      return readApprovalResponse(record.id, response);
    },
  };
}

/** Applies the registered plugin policy for a node.invoke command, if one exists. */
export async function applyPluginNodeInvokePolicy(params: {
  context: GatewayRequestContext;
  client: GatewayClient | null;
  nodeSession: NodeSession;
  command: string;
  params: unknown;
  rawParams?: unknown;
  timeoutMs?: number;
  idempotencyKey?: string;
}): Promise<OpenClawPluginNodeInvokePolicyResult | null> {
  const registry = getActiveRuntimePluginRegistry();
  const entry = registry?.nodeInvokePolicies?.find((candidate) =>
    candidate.policy.commands.includes(params.command),
  );
  if (!entry) {
    const dangerousCommand = findDangerousPluginNodeCommand(registry, params.command);
    if (dangerousCommand) {
      return {
        ok: false,
        code: "PLUGIN_POLICY_MISSING",
        message: `node.invoke ${params.command} is registered as dangerous by plugin ${dangerousCommand.pluginId} but has no plugin node.invoke policy`,
      };
    }
    return null;
  }

  const invokeNode: OpenClawPluginNodeInvokePolicyContext["invokeNode"] = async (
    override = {},
  ): Promise<OpenClawPluginNodeInvokeTransportResult> => {
    // Policies invoke the real node through this narrowed transport wrapper so
    // they can retry/override params without getting direct registry access.
    const res = await params.context.nodeRegistry.invoke({
      nodeId: params.nodeSession.nodeId,
      command: params.command,
      params: override.params ?? params.params,
      timeoutMs: override.timeoutMs ?? params.timeoutMs,
      idempotencyKey: override.idempotencyKey ?? params.idempotencyKey,
    });
    if (!res.ok) {
      return {
        ok: false,
        code: res.error?.code,
        message: res.error?.message ?? "node command failed",
        details: { nodeError: res.error ?? null },
      };
    }
    return {
      ok: true,
      payload: parsePayload(res.payloadJSON, res.payload),
      payloadJSON: res.payloadJSON ?? null,
    };
  };

  return await entry.policy.handle({
    nodeId: params.nodeSession.nodeId,
    command: params.command,
    params: params.params,
    timeoutMs: params.timeoutMs,
    idempotencyKey: params.idempotencyKey,
    config: params.context.getRuntimeConfig(),
    pluginConfig: entry.pluginConfig,
    node: {
      nodeId: params.nodeSession.nodeId,
      displayName: params.nodeSession.displayName,
      platform: params.nodeSession.platform,
      deviceFamily: params.nodeSession.deviceFamily,
      commands: params.nodeSession.commands,
    },
    client: params.client
      ? {
          connId: params.client.connId,
          scopes: parseScopes(params.client),
        }
      : null,
    approvals: createApprovalRuntime({
      context: params.context,
      client: params.client,
      pluginId: entry.pluginId,
      rawParams: params.rawParams ?? params.params,
    }),
    invokeNode,
  });
}
