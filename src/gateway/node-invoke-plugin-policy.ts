import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { PluginApprovalRequestPayload } from "../infra/plugin-approvals.js";
import { resolvePluginApprovalTimeoutMs } from "../infra/plugin-approvals.js";
import { getActiveRuntimePluginRegistry } from "../plugins/active-runtime-registry.js";
import type {
  PluginNodeHostCommandRegistration,
  PluginNodeInvokePolicyRegistration,
  PluginRegistry,
} from "../plugins/registry-types.js";
import type {
  OpenClawPluginNodeInvokePolicyContext,
  OpenClawPluginNodeInvokePolicy,
  OpenClawPluginNodeInvokePolicyResult,
  OpenClawPluginNodeInvokeTransportResult,
} from "../plugins/types.js";
import type { NodeSession } from "./node-registry.js";
import { resolveApprovalRequestRecipientConnIds } from "./server-methods/approval-shared.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";

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

type ReadResult<T> = { ok: true; value: T } | { ok: false };

type MatchedNodeInvokePolicy = {
  commandList: string[];
  handle: OpenClawPluginNodeInvokePolicy["handle"];
  pluginId: string;
  pluginConfig?: Record<string, unknown>;
  policy: OpenClawPluginNodeInvokePolicy;
};

type PolicyReadResult =
  | { ok: true; entry: MatchedNodeInvokePolicy }
  | { ok: false; pluginId?: string };

type PolicyLookupResult =
  | { kind: "matched"; entry: MatchedNodeInvokePolicy }
  | { kind: "blocked"; pluginId?: string }
  | { kind: "none" };

type DangerousCommandLookupResult =
  | { kind: "matched"; pluginId: string }
  | { kind: "blocked"; pluginId?: string }
  | { kind: "none" };

function readField<T>(read: () => T): ReadResult<T> {
  try {
    return { ok: true, value: read() };
  } catch {
    return { ok: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readArrayLength(value: readonly unknown[]): number | null {
  const length = readField(() => value.length);
  if (
    !length.ok ||
    typeof length.value !== "number" ||
    !Number.isInteger(length.value) ||
    length.value < 0
  ) {
    return null;
  }
  return length.value;
}

function stringArrayIncludes(values: readonly unknown[], target: string): boolean {
  const length = readArrayLength(values);
  if (length === null) {
    return false;
  }
  let index = 0;
  while (index < length) {
    const value = readField(() => values[index]);
    if (value.ok && value.value === target) {
      return true;
    }
    index += 1;
  }
  return false;
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const length = readArrayLength(value);
  if (length === null) {
    return null;
  }
  const out: string[] = [];
  let index = 0;
  while (index < length) {
    const entry = readField(() => value[index]);
    if (!entry.ok || typeof entry.value !== "string") {
      return null;
    }
    out.push(entry.value);
    index += 1;
  }
  return out;
}

function listNodeInvokePolicies(registry: PluginRegistry | null): ReadResult<readonly unknown[]> {
  const policies = readField(() => registry?.nodeInvokePolicies);
  if (!policies.ok) {
    return { ok: false };
  }
  if (policies.value === undefined) {
    return { ok: true, value: [] };
  }
  return Array.isArray(policies.value) ? { ok: true, value: policies.value } : { ok: false };
}

function listNodeHostCommands(registry: PluginRegistry | null): ReadResult<readonly unknown[]> {
  const commands = readField(() => registry?.nodeHostCommands);
  if (!commands.ok) {
    return { ok: false };
  }
  if (commands.value === undefined) {
    return { ok: true, value: [] };
  }
  return Array.isArray(commands.value) ? { ok: true, value: commands.value } : { ok: false };
}

function readPolicyPluginId(registration: unknown): string | undefined {
  if (!isRecord(registration)) {
    return undefined;
  }
  const typedRegistration = registration as PluginNodeInvokePolicyRegistration;
  const pluginId = readField(() => typedRegistration.pluginId);
  return pluginId.ok && typeof pluginId.value === "string" && pluginId.value.trim()
    ? pluginId.value
    : undefined;
}

function readNodeInvokePolicy(registration: unknown): PolicyReadResult {
  if (!isRecord(registration)) {
    return { ok: false };
  }
  const typedRegistration = registration as PluginNodeInvokePolicyRegistration;
  const pluginId = readPolicyPluginId(registration);
  if (!pluginId) {
    return { ok: false };
  }
  const policy = readField(() => typedRegistration.policy);
  if (!policy.ok || !isRecord(policy.value)) {
    return { ok: false, pluginId };
  }
  const typedPolicy = policy.value as OpenClawPluginNodeInvokePolicy;
  const commands = readField(() => typedPolicy.commands);
  const commandList = commands.ok ? readStringArray(commands.value) : null;
  if (!commandList) {
    return { ok: false, pluginId };
  }
  const handle = readField(() => typedPolicy.handle);
  if (!handle.ok || typeof handle.value !== "function") {
    return { ok: false, pluginId };
  }
  const pluginConfig = readField(() => typedRegistration.pluginConfig);
  return {
    ok: true,
    entry: {
      commandList,
      handle: handle.value,
      pluginId,
      policy: typedPolicy,
      ...(pluginConfig.ok && isRecord(pluginConfig.value)
        ? { pluginConfig: pluginConfig.value }
        : {}),
    },
  };
}

function findMatchingPluginNodeInvokePolicy(
  registry: PluginRegistry | null,
  command: string,
): PolicyLookupResult {
  const policies = listNodeInvokePolicies(registry);
  if (!policies.ok) {
    return { kind: "blocked" };
  }
  const length = readArrayLength(policies.value);
  if (length === null) {
    return { kind: "blocked" };
  }
  let hasBlockedPolicy = false;
  let blockedPluginId: string | undefined;
  let index = 0;
  while (index < length) {
    const registration = readField(() => policies.value[index]);
    const policy: PolicyReadResult = registration.ok
      ? readNodeInvokePolicy(registration.value)
      : { ok: false };
    if (!policy.ok) {
      hasBlockedPolicy = true;
      blockedPluginId ??= policy.pluginId;
      index += 1;
      continue;
    }
    if (stringArrayIncludes(policy.entry.commandList, command)) {
      return { kind: "matched", entry: policy.entry };
    }
    index += 1;
  }
  return hasBlockedPolicy ? { kind: "blocked", pluginId: blockedPluginId } : { kind: "none" };
}

function findDangerousPluginNodeCommand(
  registry: PluginRegistry | null,
  command: string,
): DangerousCommandLookupResult {
  const normalizedCommand = command.trim();
  if (!normalizedCommand) {
    return { kind: "none" };
  }
  const commands = listNodeHostCommands(registry);
  if (!commands.ok) {
    return { kind: "blocked" };
  }
  const length = readArrayLength(commands.value);
  if (length === null) {
    return { kind: "blocked" };
  }
  let hasBlockedCommand = false;
  let blockedPluginId: string | undefined;
  let index = 0;
  while (index < length) {
    const entry = readField(() => commands.value[index]);
    if (!entry.ok || !isRecord(entry.value)) {
      hasBlockedCommand = true;
      index += 1;
      continue;
    }
    const typedEntry = entry.value as PluginNodeHostCommandRegistration;
    const pluginId = readField(() => typedEntry.pluginId);
    const hostCommand = readField(() => typedEntry.command);
    if (
      !pluginId.ok ||
      typeof pluginId.value !== "string" ||
      !hostCommand.ok ||
      !isRecord(hostCommand.value)
    ) {
      hasBlockedCommand = true;
      if (pluginId.ok && typeof pluginId.value === "string" && pluginId.value.trim()) {
        blockedPluginId ??= pluginId.value;
      }
      index += 1;
      continue;
    }
    const typedCommand = hostCommand.value as PluginNodeHostCommandRegistration["command"];
    const dangerous = readField(() => typedCommand.dangerous);
    const commandValue = readField(() => typedCommand.command);
    if (
      dangerous.ok &&
      dangerous.value === true &&
      commandValue.ok &&
      typeof commandValue.value === "string" &&
      commandValue.value.trim() === normalizedCommand
    ) {
      return { kind: "matched", pluginId: pluginId.value };
    }
    if (!dangerous.ok || !commandValue.ok || typeof commandValue.value !== "string") {
      hasBlockedCommand = true;
      blockedPluginId ??= pluginId.value;
    }
    index += 1;
  }
  return hasBlockedCommand ? { kind: "blocked", pluginId: blockedPluginId } : { kind: "none" };
}

function createApprovalRuntime(params: {
  context: GatewayRequestContext;
  client: GatewayClient | null;
  pluginId: string;
}): OpenClawPluginNodeInvokePolicyContext["approvals"] | undefined {
  const manager = params.context.pluginApprovalManager;
  if (!manager) {
    return undefined;
  }
  return {
    async request(input) {
      const timeoutMs = resolvePluginApprovalTimeoutMs(input.timeoutMs);
      const request: PluginApprovalRequestPayload = {
        pluginId: params.pluginId,
        title: input.title.slice(0, 80),
        description: input.description.slice(0, 256),
        severity: input.severity ?? "warning",
        toolName: normalizeOptionalString(input.toolName) ?? null,
        toolCallId: normalizeOptionalString(input.toolCallId) ?? null,
        agentId: normalizeOptionalString(input.agentId) ?? null,
        sessionKey: normalizeOptionalString(input.sessionKey) ?? null,
      };
      const record = manager.create(request, timeoutMs, `plugin:${randomUUID()}`);
      record.requestedByConnId = params.client?.connId ?? null;
      record.requestedByDeviceId = params.client?.connect?.device?.id ?? null;
      record.requestedByClientId = params.client?.connect?.client?.id ?? null;
      record.requestedByDeviceTokenAuth = params.client?.isDeviceTokenAuth === true;
      const decisionPromise = manager.register(record, timeoutMs);
      const requestEvent = {
        id: record.id,
        request: record.request,
        createdAtMs: record.createdAtMs,
        expiresAtMs: record.expiresAtMs,
      };
      const approvalClientConnIds = resolveApprovalRequestRecipientConnIds({
        context: params.context,
        record,
        excludeConnId: params.client?.connId,
      });
      if (approvalClientConnIds) {
        params.context.broadcastToConnIds(
          "plugin.approval.requested",
          requestEvent,
          approvalClientConnIds,
          {
            dropIfSlow: true,
          },
        );
      } else {
        params.context.broadcast("plugin.approval.requested", requestEvent, {
          dropIfSlow: true,
        });
      }
      const hasApprovalClients =
        approvalClientConnIds !== null
          ? approvalClientConnIds.size > 0
          : (params.context.hasExecApprovalClients?.(params.client?.connId) ?? false);
      if (!hasApprovalClients) {
        manager.expire(record.id, "no-approval-route");
        return { id: record.id, decision: null };
      }
      const decision = await decisionPromise;
      return { id: record.id, decision };
    },
  };
}

export async function applyPluginNodeInvokePolicy(params: {
  context: GatewayRequestContext;
  client: GatewayClient | null;
  nodeSession: NodeSession;
  command: string;
  params: unknown;
  timeoutMs?: number;
  idempotencyKey?: string;
}): Promise<OpenClawPluginNodeInvokePolicyResult | null> {
  const registry = getActiveRuntimePluginRegistry();
  const policyLookup = findMatchingPluginNodeInvokePolicy(registry, params.command);
  if (policyLookup.kind === "blocked") {
    return {
      ok: false,
      code: "PLUGIN_POLICY_UNREADABLE",
      message: `node.invoke ${params.command} cannot be checked because a plugin node.invoke policy registration is unreadable`,
      details: { pluginId: policyLookup.pluginId ?? null },
    };
  }
  if (policyLookup.kind === "none") {
    const dangerousCommand = findDangerousPluginNodeCommand(registry, params.command);
    if (dangerousCommand.kind === "blocked") {
      return {
        ok: false,
        code: "PLUGIN_COMMAND_UNREADABLE",
        message: `node.invoke ${params.command} cannot be checked because a plugin node command registration is unreadable`,
        details: { pluginId: dangerousCommand.pluginId ?? null },
      };
    }
    if (dangerousCommand.kind === "matched") {
      return {
        ok: false,
        code: "PLUGIN_POLICY_MISSING",
        message: `node.invoke ${params.command} is registered as dangerous by plugin ${dangerousCommand.pluginId} but has no plugin node.invoke policy`,
      };
    }
    return null;
  }
  const entry = policyLookup.entry;

  const invokeNode: OpenClawPluginNodeInvokePolicyContext["invokeNode"] = async (
    override = {},
  ): Promise<OpenClawPluginNodeInvokeTransportResult> => {
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

  return await entry.handle.call(entry.policy, {
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
    }),
    invokeNode,
  });
}
