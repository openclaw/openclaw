import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
import {
  loadSessionStore,
  resolveMainSessionKey,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  type SessionEntry,
  updateSessionStore,
} from "../../config/sessions.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { GATEWAY_CLIENT_IDS } from "../protocol/client-info.js";
import {
  ErrorCodes,
  errorShape,
  validateSessionsAbortParams,
  validateSessionsCompactParams,
  validateSessionsCreateParams,
  validateSessionsDeleteParams,
  validateSessionsListParams,
  validateSessionsMessagesSubscribeParams,
  validateSessionsMessagesUnsubscribeParams,
  validateSessionsPatchParams,
  validateSessionsPreviewParams,
  validateSessionsResetParams,
  validateSessionsResolveParams,
  validateSessionsSendParams,
} from "../protocol/index.js";
import {
  archiveSessionTranscriptsForSession,
  cleanupSessionBeforeMutation,
  emitSessionUnboundLifecycleEvent,
  performGatewaySessionReset,
} from "../session-reset-service.js";
import {
  archiveFileOnDisk,
  listSessionsFromStore,
  loadCombinedSessionStoreForGateway,
  loadGatewaySessionRow,
  loadSessionEntry,
  pruneLegacyStoreKeys,
  readSessionPreviewItemsFromTranscript,
  resolveGatewaySessionStoreTarget,
  resolveSessionModelRef,
  resolveSessionTranscriptCandidates,
  type SessionsPatchResult,
  type SessionsPreviewEntry,
  type SessionsPreviewResult,
  readSessionMessages,
} from "../session-utils.js";
import { applySessionsPatchToStore } from "../sessions-patch.js";
import { resolveSessionKeyFromResolveParams } from "../sessions-resolve.js";
import { chatHandlers } from "./chat.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlers,
  RespondFn,
} from "./types.js";
import { assertValidParams } from "./validation.js";

function requireSessionKey(key: unknown, respond: RespondFn): string | null {
  const raw =
    typeof key === "string"
      ? key
      : typeof key === "number"
        ? String(key)
        : typeof key === "bigint"
          ? String(key)
          : "";
  const normalized = raw.trim();
  if (!normalized) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "key required"));
    return null;
  }
  return normalized;
}

function resolveGatewaySessionTargetFromKey(key: string) {
  const cfg = loadConfig();
  const target = resolveGatewaySessionStoreTarget({ cfg, key });
  return { cfg, target, storePath: target.storePath };
}

function resolveOptionalInitialSessionMessage(params: {
  task?: unknown;
  message?: unknown;
}): string | undefined {
  if (typeof params.task === "string" && params.task.trim()) {
    return params.task;
  }
  if (typeof params.message === "string" && params.message.trim()) {
    return params.message;
  }
  return undefined;
}

function shouldAttachPendingMessageSeq(params: { payload: unknown; cached?: boolean }): boolean {
  if (params.cached) {
    return false;
  }
  const status =
    params.payload && typeof params.payload === "object"
      ? (params.payload as { status?: unknown }).status
      : undefined;
  return status === "started";
}

function emitSessionsChanged(
  context: Pick<GatewayRequestContext, "broadcastToConnIds" | "getSessionEventSubscriberConnIds">,
  payload: { sessionKey?: string; reason: string; compacted?: boolean },
) {
  const connIds = context.getSessionEventSubscriberConnIds();
  if (connIds.size === 0) {
    return;
  }
  const sessionRow = payload.sessionKey ? loadGatewaySessionRow(payload.sessionKey) : null;
  context.broadcastToConnIds(
    "sessions.changed",
    {
      ...payload,
      ts: Date.now(),
      ...(sessionRow
        ? {
            totalTokens: sessionRow.totalTokens,
            totalTokensFresh: sessionRow.totalTokensFresh,
            contextTokens: sessionRow.contextTokens,
            estimatedCostUsd: sessionRow.estimatedCostUsd,
            modelProvider: sessionRow.modelProvider,
            model: sessionRow.model,
            status: sessionRow.status,
            startedAt: sessionRow.startedAt,
            endedAt: sessionRow.endedAt,
            runtimeMs: sessionRow.runtimeMs,
          }
        : {}),
    },
    connIds,
    { dropIfSlow: true },
  );
}

function rejectWebchatSessionMutation(params: {
  action: "patch" | "delete";
  client: GatewayClient | null;
  isWebchatConnect: (params: GatewayClient["connect"] | null | undefined) => boolean;
  respond: RespondFn;
}): boolean {
  if (!params.client?.connect || !params.isWebchatConnect(params.client.connect)) {
    return false;
  }
  if (params.client.connect.client.id === GATEWAY_CLIENT_IDS.CONTROL_UI) {
    return false;
  }
  params.respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `webchat clients cannot ${params.action} sessions; use chat.send for session-scoped updates`,
    ),
  );
  return true;
}

function migrateAndPruneSessionStoreKey(params: {
  cfg: ReturnType<typeof loadConfig>;
  key: string;
  store: Record<string, SessionEntry>;
}) {
  const target = resolveGatewaySessionStoreTarget({
    cfg: params.cfg,
    key: params.key,
    store: params.store,
  });
  const primaryKey = target.canonicalKey;
  if (!params.store[primaryKey]) {
    const existingKey = target.storeKeys.find((candidate) => Boolean(params.store[candidate]));
    if (existingKey) {
      params.store[primaryKey] = params.store[existingKey];
    }
  }
  pruneLegacyStoreKeys({
    store: params.store,
    canonicalKey: primaryKey,
    candidates: target.storeKeys,
  });
  return { target, primaryKey, entry: params.store[primaryKey] };
}

function buildDashboardSessionKey(agentId: string): string {
  return `agent:${agentId}:dashboard:${randomUUID()}`;
}

function ensureSessionTranscriptFile(params: {
  sessionId: string;
  storePath: string;
  sessionFile?: string;
  agentId: string;
}): { ok: true; transcriptPath: string } | { ok: false; error: string } {
  try {
    const transcriptPath = resolveSessionFilePath(
      params.sessionId,
      params.sessionFile ? { sessionFile: params.sessionFile } : undefined,
      resolveSessionFilePathOptions({
        storePath: params.storePath,
        agentId: params.agentId,
      }),
    );
    if (!fs.existsSync(transcriptPath)) {
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      const header = {
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: params.sessionId,
        timestamp: new Date().toISOString(),
        cwd: process.cwd(),
      };
      fs.writeFileSync(transcriptPath, `${JSON.stringify(header)}\n`, {
        encoding: "utf-8",
        mode: 0o600,
      });
    }
    return { ok: true, transcriptPath };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function resolveAbortSessionKey(params: {
  context: Pick<GatewayRequestContext, "chatAbortControllers">;
  requestedKey: string;
  canonicalKey: string;
  runId?: string;
}): string {
  const activeRunKey =
    typeof params.runId === "string"
      ? params.context.chatAbortControllers.get(params.runId)?.sessionKey
      : undefined;
  if (activeRunKey) {
    return activeRunKey;
  }
  for (const active of params.context.chatAbortControllers.values()) {
    if (active.sessionKey === params.canonicalKey) {
      return params.canonicalKey;
    }
    if (active.sessionKey === params.requestedKey) {
      return params.requestedKey;
    }
  }
  return params.requestedKey;
}

export const sessionsHandlers: GatewayRequestHandlers = {
  "sessions.list": ({ params, respond }) => {
    if (!assertValidParams(params, validateSessionsListParams, "sessions.list", respond)) {
      return;
    }
    const p = params;
    const cfg = loadConfig();
    const { storePath, store } = loadCombinedSessionStoreForGateway(cfg);
    const result = listSessionsFromStore({
      cfg,
      storePath,
      store,
      opts: p,
    });
    respond(true, result, undefined);
  },
  "sessions.subscribe": ({ client, context, respond }) => {
    const connId = client?.connId?.trim();
    if (connId) {
      context.subscribeSessionEvents(connId);
    }
    respond(true, { subscribed: Boolean(connId) }, undefined);
  },
  "sessions.unsubscribe": ({ client, context, respond }) => {
    const connId = client?.connId?.trim();
    if (connId) {
      context.unsubscribeSessionEvents(connId);
    }
    respond(true, { subscribed: false }, undefined);
  },
  "sessions.messages.subscribe": ({ params, client, context, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsMessagesSubscribeParams,
        "sessions.messages.subscribe",
        respond,
      )
    ) {
      return;
    }
    const connId = client?.connId?.trim();
    const key = requireSessionKey((params as { key?: unknown }).key, respond);
    if (!key) {
      return;
    }
    const { canonicalKey } = loadSessionEntry(key);
    if (connId) {
      context.subscribeSessionMessageEvents(connId, canonicalKey);
      respond(true, { subscribed: true, key: canonicalKey }, undefined);
      return;
    }
    respond(true, { subscribed: false, key: canonicalKey }, undefined);
  },
  "sessions.messages.unsubscribe": ({ params, client, context, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsMessagesUnsubscribeParams,
        "sessions.messages.unsubscribe",
        respond,
      )
    ) {
      return;
    }
    const connId = client?.connId?.trim();
    const key = requireSessionKey((params as { key?: unknown }).key, respond);
    if (!key) {
      return;
    }
    const { canonicalKey } = loadSessionEntry(key);
    if (connId) {
      context.unsubscribeSessionMessageEvents(connId, canonicalKey);
    }
    respond(true, { subscribed: false, key: canonicalKey }, undefined);
  },
  "sessions.preview": ({ params, respond }) => {
    if (!assertValidParams(params, validateSessionsPreviewParams, "sessions.preview", respond)) {
      return;
    }
    const p = params;
    const keysRaw = Array.isArray(p.keys) ? p.keys : [];
    const keys = keysRaw
      .map((key) => String(key ?? "").trim())
      .filter(Boolean)
      .slice(0, 64);
    const limit =
      typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.max(1, p.limit) : 12;
    const maxChars =
      typeof p.maxChars === "number" && Number.isFinite(p.maxChars)
        ? Math.max(20, p.maxChars)
        : 240;

    if (keys.length === 0) {
      respond(true, { ts: Date.now(), previews: [] } satisfies SessionsPreviewResult, undefined);
      return;
    }

    const cfg = loadConfig();
    const storeCache = new Map<string, Record<string, SessionEntry>>();
    const previews: SessionsPreviewEntry[] = [];

    for (const key of keys) {
      try {
        const storeTarget = resolveGatewaySessionStoreTarget({ cfg, key, scanLegacyKeys: false });
        const store =
          storeCache.get(storeTarget.storePath) ?? loadSessionStore(storeTarget.storePath);
        storeCache.set(storeTarget.storePath, store);
        const target = resolveGatewaySessionStoreTarget({
          cfg,
          key,
          store,
        });
        const entry = target.storeKeys.map((candidate) => store[candidate]).find(Boolean);
        if (!entry?.sessionId) {
          previews.push({ key, status: "missing", items: [] });
          continue;
        }
        const items = readSessionPreviewItemsFromTranscript(
          entry.sessionId,
          target.storePath,
          entry.sessionFile,
          target.agentId,
          limit,
          maxChars,
        );
        previews.push({
          key,
          status: items.length > 0 ? "ok" : "empty",
          items,
        });
      } catch {
        previews.push({ key, status: "error", items: [] });
      }
    }

    respond(true, { ts: Date.now(), previews } satisfies SessionsPreviewResult, undefined);
  },
  "sessions.resolve": async ({ params, respond }) => {
    if (!assertValidParams(params, validateSessionsResolveParams, "sessions.resolve", respond)) {
      return;
    }
    const p = params;
    const cfg = loadConfig();

    const resolved = await resolveSessionKeyFromResolveParams({ cfg, p });
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    respond(true, { ok: true, key: resolved.key }, undefined);
  },
  "sessions.create": async ({ req, params, respond, context, client, isWebchatConnect }) => {
    if (!assertValidParams(params, validateSessionsCreateParams, "sessions.create", respond)) {
      return;
    }
    const p = params;
    const cfg = loadConfig();
    const agentId = normalizeAgentId(
      typeof p.agentId === "string" && p.agentId.trim() ? p.agentId : resolveDefaultAgentId(cfg),
    );
    const parentSessionKey =
      typeof p.parentSessionKey === "string" && p.parentSessionKey.trim()
        ? p.parentSessionKey.trim()
        : undefined;
    let canonicalParentSessionKey: string | undefined;
    if (parentSessionKey) {
      const parent = loadSessionEntry(parentSessionKey);
      if (!parent.entry?.sessionId) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unknown parent session: ${parentSessionKey}`),
        );
        return;
      }
      canonicalParentSessionKey = parent.canonicalKey;
    }
    const key = buildDashboardSessionKey(agentId);
    const target = resolveGatewaySessionStoreTarget({ cfg, key });
    const created = await updateSessionStore(target.storePath, async (store) => {
      const patched = await applySessionsPatchToStore({
        cfg,
        store,
        storeKey: target.canonicalKey,
        patch: {
          key: target.canonicalKey,
          label: typeof p.label === "string" ? p.label.trim() : undefined,
          model: typeof p.model === "string" ? p.model.trim() : undefined,
        },
        loadGatewayModelCatalog: context.loadGatewayModelCatalog,
      });
      if (!patched.ok || !canonicalParentSessionKey) {
        return patched;
      }
      const nextEntry: SessionEntry = {
        ...patched.entry,
        parentSessionKey: canonicalParentSessionKey,
      };
      store[target.canonicalKey] = nextEntry;
      return {
        ...patched,
        entry: nextEntry,
      };
    });
    if (!created.ok) {
      respond(false, undefined, created.error);
      return;
    }
    const ensured = ensureSessionTranscriptFile({
      sessionId: created.entry.sessionId,
      storePath: target.storePath,
      sessionFile: created.entry.sessionFile,
      agentId,
    });
    if (!ensured.ok) {
      await updateSessionStore(target.storePath, (store) => {
        delete store[target.canonicalKey];
      });
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `failed to create session transcript: ${ensured.error}`),
      );
      return;
    }

    const initialMessage = resolveOptionalInitialSessionMessage(p);
    let runPayload: Record<string, unknown> | undefined;
    let runError: unknown;
    let runMeta: Record<string, unknown> | undefined;
    const messageSeq = initialMessage
      ? readSessionMessages(created.entry.sessionId, target.storePath, created.entry.sessionFile)
          .length + 1
      : undefined;

    if (initialMessage) {
      await chatHandlers["chat.send"]({
        req,
        params: {
          sessionKey: target.canonicalKey,
          message: initialMessage,
          idempotencyKey: randomUUID(),
        },
        respond: (ok, payload, error, meta) => {
          if (ok && payload && typeof payload === "object") {
            runPayload = payload as Record<string, unknown>;
          } else {
            runError = error;
          }
          runMeta = meta;
        },
        context,
        client,
        isWebchatConnect,
      });
    }

    const runStarted =
      runPayload !== undefined &&
      shouldAttachPendingMessageSeq({
        payload: runPayload,
        cached: runMeta?.cached === true,
      });

    respond(
      true,
      {
        ok: true,
        key: target.canonicalKey,
        sessionId: created.entry.sessionId,
        entry: created.entry,
        runStarted,
        ...(runPayload ? runPayload : {}),
        ...(runStarted && typeof messageSeq === "number" ? { messageSeq } : {}),
        ...(runError ? { runError } : {}),
      },
      undefined,
    );
    emitSessionsChanged(context, {
      sessionKey: target.canonicalKey,
      reason: "create",
    });
    if (runStarted) {
      emitSessionsChanged(context, {
        sessionKey: target.canonicalKey,
        reason: "send",
      });
    }
  },
  "sessions.send": async ({ req, params, respond, context, client, isWebchatConnect }) => {
    if (!assertValidParams(params, validateSessionsSendParams, "sessions.send", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    const { entry, canonicalKey, storePath } = loadSessionEntry(key);
    if (!entry?.sessionId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `session not found: ${key}`),
      );
      return;
    }
    const messageSeq =
      readSessionMessages(entry.sessionId, storePath, entry.sessionFile).length + 1;
    let sendAcked = false;
    await chatHandlers["chat.send"]({
      req,
      params: {
        sessionKey: canonicalKey,
        message: p.message,
        thinking: p.thinking,
        attachments: p.attachments,
        timeoutMs: p.timeoutMs,
        idempotencyKey:
          typeof p.idempotencyKey === "string" && p.idempotencyKey.trim()
            ? p.idempotencyKey.trim()
            : randomUUID(),
      },
      respond: (ok, payload, error, meta) => {
        sendAcked = ok;
        if (ok && shouldAttachPendingMessageSeq({ payload, cached: meta?.cached === true })) {
          respond(
            true,
            {
              ...(payload && typeof payload === "object" ? payload : {}),
              messageSeq,
            },
            undefined,
            meta,
          );
          return;
        }
        respond(ok, payload, error, meta);
      },
      context,
      client,
      isWebchatConnect,
    });
    if (sendAcked) {
      emitSessionsChanged(context, {
        sessionKey: canonicalKey,
        reason: "send",
      });
    }
  },
  "sessions.abort": async ({ req, params, respond, context, client, isWebchatConnect }) => {
    if (!assertValidParams(params, validateSessionsAbortParams, "sessions.abort", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    const { canonicalKey } = loadSessionEntry(key);
    const abortSessionKey = resolveAbortSessionKey({
      context,
      requestedKey: key,
      canonicalKey,
      runId: typeof p.runId === "string" ? p.runId : undefined,
    });
    let abortedRunId: string | null = null;
    await chatHandlers["chat.abort"]({
      req,
      params: {
        sessionKey: abortSessionKey,
        runId: typeof p.runId === "string" ? p.runId : undefined,
      },
      respond: (ok, payload, error, meta) => {
        if (!ok) {
          respond(ok, payload, error, meta);
          return;
        }
        const runIds =
          payload &&
          typeof payload === "object" &&
          Array.isArray((payload as { runIds?: unknown[] }).runIds)
            ? (payload as { runIds: unknown[] }).runIds.filter(
                (value): value is string => typeof value === "string" && value.trim().length > 0,
              )
            : [];
        abortedRunId = runIds[0] ?? null;
        respond(
          true,
          {
            ok: true,
            abortedRunId,
            status: abortedRunId ? "aborted" : "no-active-run",
          },
          undefined,
          meta,
        );
      },
      context,
      client,
      isWebchatConnect,
    });
    if (abortedRunId) {
      emitSessionsChanged(context, {
        sessionKey: canonicalKey,
        reason: "abort",
      });
    }
  },
  "sessions.patch": async ({ params, respond, context, client, isWebchatConnect }) => {
    if (!assertValidParams(params, validateSessionsPatchParams, "sessions.patch", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    if (rejectWebchatSessionMutation({ action: "patch", client, isWebchatConnect, respond })) {
      return;
    }

    const { cfg, target, storePath } = resolveGatewaySessionTargetFromKey(key);
    const applied = await updateSessionStore(storePath, async (store) => {
      const { primaryKey } = migrateAndPruneSessionStoreKey({ cfg, key, store });
      return await applySessionsPatchToStore({
        cfg,
        store,
        storeKey: primaryKey,
        patch: p,
        loadGatewayModelCatalog: context.loadGatewayModelCatalog,
      });
    });
    if (!applied.ok) {
      respond(false, undefined, applied.error);
      return;
    }
    const parsed = parseAgentSessionKey(target.canonicalKey ?? key);
    const agentId = normalizeAgentId(parsed?.agentId ?? resolveDefaultAgentId(cfg));
    const resolved = resolveSessionModelRef(cfg, applied.entry, agentId);
    const result: SessionsPatchResult = {
      ok: true,
      path: storePath,
      key: target.canonicalKey,
      entry: applied.entry,
      resolved: {
        modelProvider: resolved.provider,
        model: resolved.model,
      },
    };
    respond(true, result, undefined);
    emitSessionsChanged(context, {
      sessionKey: target.canonicalKey,
      reason: "patch",
    });
  },
  "sessions.reset": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSessionsResetParams, "sessions.reset", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }

    const reason = p.reason === "new" ? "new" : "reset";
    const result = await performGatewaySessionReset({
      key,
      reason,
      commandSource: "gateway:sessions.reset",
    });
    if (!result.ok) {
      respond(false, undefined, result.error);
      return;
    }
    respond(true, { ok: true, key: result.key, entry: result.entry }, undefined);
    emitSessionsChanged(context, {
      sessionKey: result.key,
      reason,
    });
  },
  "sessions.delete": async ({ params, respond, client, isWebchatConnect, context }) => {
    if (!assertValidParams(params, validateSessionsDeleteParams, "sessions.delete", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    if (rejectWebchatSessionMutation({ action: "delete", client, isWebchatConnect, respond })) {
      return;
    }

    const { cfg, target, storePath } = resolveGatewaySessionTargetFromKey(key);
    const mainKey = resolveMainSessionKey(cfg);
    if (target.canonicalKey === mainKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `Cannot delete the main session (${mainKey}).`),
      );
      return;
    }

    const deleteTranscript = typeof p.deleteTranscript === "boolean" ? p.deleteTranscript : true;

    const { entry, legacyKey, canonicalKey } = loadSessionEntry(key);
    const mutationCleanupError = await cleanupSessionBeforeMutation({
      cfg,
      key,
      target,
      entry,
      legacyKey,
      canonicalKey,
      reason: "session-delete",
    });
    if (mutationCleanupError) {
      respond(false, undefined, mutationCleanupError);
      return;
    }
    const sessionId = entry?.sessionId;
    const deleted = await updateSessionStore(storePath, (store) => {
      const { primaryKey } = migrateAndPruneSessionStoreKey({ cfg, key, store });
      const hadEntry = Boolean(store[primaryKey]);
      if (hadEntry) {
        delete store[primaryKey];
      }
      return hadEntry;
    });

    const archived =
      deleted && deleteTranscript
        ? archiveSessionTranscriptsForSession({
            sessionId,
            storePath,
            sessionFile: entry?.sessionFile,
            agentId: target.agentId,
            reason: "deleted",
          })
        : [];
    if (deleted) {
      const emitLifecycleHooks = p.emitLifecycleHooks !== false;
      await emitSessionUnboundLifecycleEvent({
        targetSessionKey: target.canonicalKey ?? key,
        reason: "session-delete",
        emitHooks: emitLifecycleHooks,
      });
    }

    respond(true, { ok: true, key: target.canonicalKey, deleted, archived }, undefined);
    if (deleted) {
      emitSessionsChanged(context, {
        sessionKey: target.canonicalKey,
        reason: "delete",
      });
    }
  },
  "sessions.get": ({ params, respond }) => {
    const p = params;
    const key = requireSessionKey(p.key ?? p.sessionKey, respond);
    if (!key) {
      return;
    }
    const limit =
      typeof p.limit === "number" && Number.isFinite(p.limit)
        ? Math.max(1, Math.floor(p.limit))
        : 200;

    const { target, storePath } = resolveGatewaySessionTargetFromKey(key);
    const store = loadSessionStore(storePath);
    const entry = target.storeKeys.map((k) => store[k]).find(Boolean);
    if (!entry?.sessionId) {
      respond(true, { messages: [] }, undefined);
      return;
    }
    const allMessages = readSessionMessages(entry.sessionId, storePath, entry.sessionFile);
    const messages = limit < allMessages.length ? allMessages.slice(-limit) : allMessages;
    respond(true, { messages }, undefined);
  },
  "sessions.compact": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSessionsCompactParams, "sessions.compact", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }

    const maxLines =
      typeof p.maxLines === "number" && Number.isFinite(p.maxLines)
        ? Math.max(1, Math.floor(p.maxLines))
        : 400;

    const { cfg, target, storePath } = resolveGatewaySessionTargetFromKey(key);
    // Lock + read in a short critical section; transcript work happens outside.
    const compactTarget = await updateSessionStore(storePath, (store) => {
      const { entry, primaryKey } = migrateAndPruneSessionStoreKey({ cfg, key, store });
      return { entry, primaryKey };
    });
    const entry = compactTarget.entry;
    const sessionId = entry?.sessionId;
    if (!sessionId) {
      respond(
        true,
        {
          ok: true,
          key: target.canonicalKey,
          compacted: false,
          reason: "no sessionId",
        },
        undefined,
      );
      return;
    }

    const filePath = resolveSessionTranscriptCandidates(
      sessionId,
      storePath,
      entry?.sessionFile,
      target.agentId,
    ).find((candidate) => fs.existsSync(candidate));
    if (!filePath) {
      respond(
        true,
        {
          ok: true,
          key: target.canonicalKey,
          compacted: false,
          reason: "no transcript",
        },
        undefined,
      );
      return;
    }

    const raw = fs.readFileSync(filePath, "utf-8");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length <= maxLines) {
      respond(
        true,
        {
          ok: true,
          key: target.canonicalKey,
          compacted: false,
          kept: lines.length,
        },
        undefined,
      );
      return;
    }

    const archived = archiveFileOnDisk(filePath, "bak");
    const keptLines = lines.slice(-maxLines);
    fs.writeFileSync(filePath, `${keptLines.join("\n")}\n`, "utf-8");

    await updateSessionStore(storePath, (store) => {
      const entryKey = compactTarget.primaryKey;
      const entryToUpdate = store[entryKey];
      if (!entryToUpdate) {
        return;
      }
      delete entryToUpdate.inputTokens;
      delete entryToUpdate.outputTokens;
      delete entryToUpdate.totalTokens;
      delete entryToUpdate.totalTokensFresh;
      entryToUpdate.updatedAt = Date.now();
    });

    respond(
      true,
      {
        ok: true,
        key: target.canonicalKey,
        compacted: true,
        archived,
        kept: keptLines.length,
      },
      undefined,
    );
    emitSessionsChanged(context, {
      sessionKey: target.canonicalKey,
      reason: "compact",
      compacted: true,
    });
  },
};
