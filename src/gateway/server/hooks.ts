import { randomUUID } from "node:crypto";
import type { CliDeps } from "../../cli/deps.js";
import { loadConfig, type OpenClawConfig } from "../../config/config.js";
import { resolveMainSessionKeyFromConfig } from "../../config/sessions.js";
import { runCronIsolatedAgentTurn } from "../../cron/isolated-agent.js";
import type { CronJob } from "../../cron/types.js";
import { requestHeartbeatNow } from "../../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import {
  getHookSessionKeyPrefixError,
  type HookAgentDispatchPayload,
  type HookMessageDispatchPayload,
  type HooksConfigResolved,
  isSessionKeyAllowedByPrefix,
} from "../hooks.js";
import { ErrorCodes, type RequestFrame } from "../protocol/index.js";
import { createHooksRequestHandler, type HookClientIpConfig } from "../server-http.js";
import { agentHandlers } from "../server-methods/agent.js";
import { chatHandlers } from "../server-methods/chat.js";
import { sessionsHandlers } from "../server-methods/sessions.js";
import type { GatewayRequestContext } from "../server-methods/types.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

type HookMessageLifecycleFields = {
  requestId: string;
  sessionKey: string;
  kind: "message" | "event";
  source: string;
  senderId: string;
  conversationId: string;
  groupId: string;
  status: string;
};

type HookHandlerCallResult = {
  ok: boolean;
  payload?: unknown;
  error?: unknown;
};

const HOOK_MESSAGE_WAIT_TIMEOUT_MS = 2_000;

function toOptionalString(raw: unknown): string | undefined {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed ? trimmed : undefined;
  }
  if (typeof raw === "number" || typeof raw === "bigint") {
    return String(raw);
  }
  return undefined;
}

function toRecord(raw: unknown): Record<string, unknown> | undefined {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : undefined;
}

function readRecordString(
  record: Record<string, unknown> | undefined,
  keys: string[],
): string | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = toOptionalString(record[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function resolveHookMessageLifecycleFields(params: {
  value: HookMessageDispatchPayload;
  sessionKey: string;
  status: string;
}): HookMessageLifecycleFields {
  const senderId = readRecordString(params.value.sender, ["id", "senderId", "userId"]);
  const conversationId = readRecordString(params.value.conversation, [
    "id",
    "conversationId",
    "threadId",
  ]);
  const nestedGroup = toRecord(params.value.conversation?.group);
  const groupId =
    readRecordString(params.value.conversation, ["groupId"]) ??
    readRecordString(nestedGroup, ["id", "groupId"]) ??
    readRecordString(params.value.sender, ["groupId"]);

  return {
    requestId: params.value.requestId,
    sessionKey: params.sessionKey,
    kind: params.value.kind,
    source: params.value.source ?? "-",
    senderId: senderId ?? "-",
    conversationId: conversationId ?? "-",
    groupId: groupId ?? "-",
    status: params.status,
  };
}

function formatHookMessageLifecycleFields(fields: HookMessageLifecycleFields): string {
  return [
    `requestId=${fields.requestId}`,
    `sessionKey=${fields.sessionKey}`,
    `kind=${fields.kind}`,
    `source=${fields.source}`,
    `senderId=${fields.senderId}`,
    `conversationId=${fields.conversationId}`,
    `groupId=${fields.groupId}`,
    `status=${fields.status}`,
  ].join(" ");
}

function isHookMessageSessionKeyAllowed(
  sessionKey: string,
  allowedPrefixes: string[] | undefined,
): boolean {
  if (!allowedPrefixes) {
    return true;
  }
  if (isSessionKeyAllowedByPrefix(sessionKey, allowedPrefixes)) {
    return true;
  }
  const parsed = parseAgentSessionKey(sessionKey);
  return Boolean(parsed && isSessionKeyAllowedByPrefix(parsed.rest, allowedPrefixes));
}

function logHookMessageLifecycle(
  logHooks: SubsystemLogger,
  event: string,
  fields: HookMessageLifecycleFields,
): void {
  logHooks.info(`${event} ${formatHookMessageLifecycleFields(fields)}`);
}

async function callGatewayMethodHandler(params: {
  handler: (options: {
    req: RequestFrame;
    params: Record<string, unknown>;
    respond: (
      ok: boolean,
      payload?: unknown,
      error?: unknown,
      meta?: Record<string, unknown>,
    ) => void;
    context: GatewayRequestContext;
    client: null;
    isWebchatConnect: () => false;
  }) => Promise<void> | void;
  req: RequestFrame;
  requestParams: Record<string, unknown>;
  context: GatewayRequestContext;
}): Promise<HookHandlerCallResult> {
  let result: HookHandlerCallResult = { ok: false };
  await params.handler({
    req: params.req,
    params: params.requestParams,
    respond: (ok, payload, error) => {
      result = { ok, payload, error };
    },
    context: params.context,
    client: null,
    isWebchatConnect: () => false,
  });
  return result;
}

function buildHookRequestFrame(
  method: string,
  requestId: string,
  params: Record<string, unknown>,
): RequestFrame {
  return {
    type: "req",
    id: `hook-message:${method}:${requestId}`,
    method,
    params,
  };
}

function resolveHookMethodError(error: unknown, fallback: string): string {
  const message =
    (toRecord(error) && toOptionalString((error as Record<string, unknown>).message)) ||
    toOptionalString(error);
  return message ?? fallback;
}

function resolveHookMethodStatusCode(error: unknown): number | undefined {
  const record = toRecord(error);
  if (!record) {
    return undefined;
  }
  const statusCode = record.statusCode;
  if (typeof statusCode === "number" && Number.isFinite(statusCode)) {
    return statusCode;
  }
  const code = toOptionalString(record.code);
  if (!code) {
    return undefined;
  }
  if (code === ErrorCodes.INVALID_REQUEST) {
    return 400;
  }
  if (code === ErrorCodes.UNAVAILABLE) {
    return 503;
  }
  return undefined;
}

async function monitorHookMessageReply(params: {
  logHooks: SubsystemLogger;
  context: GatewayRequestContext;
  fields: HookMessageLifecycleFields;
  runId: string;
}): Promise<void> {
  const waitReq = buildHookRequestFrame("agent.wait", params.fields.requestId, {
    runId: params.runId,
    timeoutMs: HOOK_MESSAGE_WAIT_TIMEOUT_MS,
  });
  try {
    const waitResult = await callGatewayMethodHandler({
      handler: agentHandlers["agent.wait"],
      req: waitReq,
      requestParams: {
        runId: params.runId,
        timeoutMs: HOOK_MESSAGE_WAIT_TIMEOUT_MS,
      },
      context: params.context,
    });
    const waitPayload = toRecord(waitResult.payload);
    const waitStatus = toOptionalString(waitPayload?.status) ?? (waitResult.ok ? "ok" : "failed");
    if (waitResult.ok) {
      logHookMessageLifecycle(params.logHooks, "hook.message.reply.completed", {
        ...params.fields,
        status: waitStatus,
      });
      return;
    }
    logHookMessageLifecycle(params.logHooks, "hook.message.failed", {
      ...params.fields,
      status: waitStatus,
    });
  } catch (err) {
    logHookMessageLifecycle(params.logHooks, "hook.message.failed", {
      ...params.fields,
      status: resolveHookMethodError(err, "agent.wait failed"),
    });
  }
}

export function resolveHookClientIpConfig(cfg: OpenClawConfig): HookClientIpConfig {
  return {
    trustedProxies: cfg.gateway?.trustedProxies,
    allowRealIpFallback: cfg.gateway?.allowRealIpFallback === true,
  };
}

export function createGatewayHooksRequestHandler(params: {
  deps: CliDeps;
  getHooksConfig: () => HooksConfigResolved | null;
  getClientIpConfig: () => HookClientIpConfig;
  getGatewayRequestContext?: () => GatewayRequestContext | undefined;
  bindHost: string;
  port: number;
  logHooks: SubsystemLogger;
}) {
  const {
    deps,
    getHooksConfig,
    getClientIpConfig,
    getGatewayRequestContext,
    bindHost,
    port,
    logHooks,
  } = params;

  const dispatchWakeHook = (value: { text: string; mode: "now" | "next-heartbeat" }) => {
    const sessionKey = resolveMainSessionKeyFromConfig();
    enqueueSystemEvent(value.text, { sessionKey, trusted: false });
    if (value.mode === "now") {
      requestHeartbeatNow({ reason: "hook:wake" });
    }
  };

  const dispatchAgentHook = (value: HookAgentDispatchPayload) => {
    const sessionKey = value.sessionKey;
    const jobId = randomUUID();
    const now = Date.now();
    const delivery = value.deliver
      ? {
          mode: "announce" as const,
          channel: value.channel,
          to: value.to,
        }
      : { mode: "none" as const };
    const job: CronJob = {
      id: jobId,
      agentId: value.agentId,
      name: value.name,
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "at", at: new Date(now).toISOString() },
      sessionTarget: "isolated",
      wakeMode: value.wakeMode,
      payload: {
        kind: "agentTurn",
        message: value.message,
        model: value.model,
        thinking: value.thinking,
        timeoutSeconds: value.timeoutSeconds,
        allowUnsafeExternalContent: value.allowUnsafeExternalContent,
        externalContentSource: value.externalContentSource,
      },
      delivery,
      state: { nextRunAtMs: now },
    };

    const runId = randomUUID();
    void (async () => {
      try {
        const cfg = loadConfig();
        const deliveryContract = value.deliver ? "shared" : "cron-owned";
        const result = await runCronIsolatedAgentTurn({
          cfg,
          deps,
          job,
          message: value.message,
          sessionKey,
          lane: "cron",
          deliveryContract,
        });
        logHooks.info(
          `hook.agent.completed runId=${runId} jobId=${jobId} status=${result.status} delivered=${result.delivered === true} deliveryAttempted=${result.deliveryAttempted === true} deliveryContract=${deliveryContract}`,
        );
      } catch (err) {
        logHooks.warn(`hook.agent.failed runId=${runId} jobId=${jobId} error=${String(err)}`);
      }
    })();

    return runId;
  };

  const dispatchMessageHook = async (value: HookMessageDispatchPayload) => {
    // HTTP ingress resolves hook session policy before invoking this dispatcher.
    // Keep a main-session fallback for non-HTTP call sites/tests that may bypass
    // that normalization.
    const requestedSessionKey = value.sessionKey ?? resolveMainSessionKeyFromConfig();
    const receivedFields = resolveHookMessageLifecycleFields({
      value,
      sessionKey: requestedSessionKey,
      status: "received",
    });
    logHookMessageLifecycle(logHooks, "hook.message.received", receivedFields);

    const context = getGatewayRequestContext?.();
    if (!context) {
      logHookMessageLifecycle(logHooks, "hook.message.failed", {
        ...receivedFields,
        status: "gateway context unavailable",
      });
      throw Object.assign(new Error("gateway request context unavailable"), {
        statusCode: 503,
      });
    }

    let targetSessionKey = requestedSessionKey;
    const createParams = { key: requestedSessionKey };
    const createResult = await callGatewayMethodHandler({
      handler: sessionsHandlers["sessions.create"],
      req: buildHookRequestFrame("sessions.create", value.requestId, createParams),
      requestParams: createParams,
      context,
    });
    if (!createResult.ok) {
      const createError = resolveHookMethodError(createResult.error, "sessions.create failed");
      logHookMessageLifecycle(logHooks, "hook.message.failed", {
        ...receivedFields,
        status: createError,
      });
      throw new Error(createError);
    }
    const createdPayload = toRecord(createResult.payload);
    const createdKey = toOptionalString(createdPayload?.key);
    targetSessionKey = createdKey ?? targetSessionKey;
    if (!isHookMessageSessionKeyAllowed(targetSessionKey, value.allowedSessionKeyPrefixes)) {
      const prefixError = getHookSessionKeyPrefixError(value.allowedSessionKeyPrefixes ?? []);
      logHookMessageLifecycle(logHooks, "hook.message.failed", {
        ...receivedFields,
        sessionKey: targetSessionKey,
        status: prefixError,
      });
      throw Object.assign(new Error(prefixError), { statusCode: 400 });
    }

    if (value.kind === "event") {
      enqueueSystemEvent(value.message, {
        sessionKey: targetSessionKey,
        trusted: false,
      });
      logHookMessageLifecycle(logHooks, "hook.message.persisted", {
        ...receivedFields,
        sessionKey: targetSessionKey,
        status: "event",
      });
      return {
        status: "event" as const,
        sessionKey: targetSessionKey,
      };
    }

    const sendParams = {
      sessionKey: targetSessionKey,
      message: value.message,
      idempotencyKey: value.chatIdempotencyKey ?? value.idempotencyKey,
    };
    const sendResult = await callGatewayMethodHandler({
      handler: chatHandlers["chat.send"],
      req: buildHookRequestFrame("chat.send", value.requestId, sendParams),
      requestParams: sendParams,
      context,
    });
    if (!sendResult.ok) {
      const sendError = resolveHookMethodError(sendResult.error, "chat.send failed");
      logHookMessageLifecycle(logHooks, "hook.message.failed", {
        ...receivedFields,
        sessionKey: targetSessionKey,
        status: sendError,
      });
      const sendStatusCode = resolveHookMethodStatusCode(sendResult.error);
      if (sendStatusCode !== undefined) {
        throw Object.assign(new Error(sendError), { statusCode: sendStatusCode });
      }
      throw new Error(sendError);
    }

    const sendPayload = toRecord(sendResult.payload);
    const runId = toOptionalString(sendPayload?.runId);
    const sendStatus = toOptionalString(sendPayload?.status) ?? "started";
    const lifecycleFields = resolveHookMessageLifecycleFields({
      value,
      sessionKey: targetSessionKey,
      status: sendStatus,
    });

    logHookMessageLifecycle(logHooks, "hook.message.persisted", lifecycleFields);
    if (runId) {
      logHookMessageLifecycle(logHooks, "hook.message.reply.started", lifecycleFields);
      void monitorHookMessageReply({
        logHooks,
        context,
        fields: lifecycleFields,
        runId,
      });
    } else {
      logHooks.warn(
        `hook.message.reply.runid_missing requestId=${value.requestId} sessionKey=${targetSessionKey} status=${sendStatus}`,
      );
      logHookMessageLifecycle(logHooks, "hook.message.reply.completed", {
        ...lifecycleFields,
        status: "runId-unavailable",
      });
    }

    return {
      status: "accepted" as const,
      sessionKey: targetSessionKey,
      ...(runId ? { runId } : {}),
    };
  };

  return createHooksRequestHandler({
    getHooksConfig,
    bindHost,
    port,
    logHooks,
    getClientIpConfig,
    dispatchAgentHook,
    dispatchMessageHook,
    dispatchWakeHook,
  });
}
