import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionOperationEvent,
  type SessionsPatchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveAgentMainSessionKey } from "../../config/sessions/main-session.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveWorkerPlacementCapabilities } from "../worker-environments/placement-capabilities.js";
import { prepareWorkerPlacementSessionRuntime } from "../worker-environments/placement-session-runtime-preparation.js";
import { resolveWorkerPlacementSessionRuntimeCapabilitiesAsync } from "../worker-environments/placement-session-runtime.js";
import {
  readSessionWorkerPlacementAsync,
  resolveWorkerPlacementArchiveRestoreError,
  type SessionWorkerPlacementContext,
} from "../worker-environments/session-placement-lifecycle.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

export { sessionLog } from "../session-log.js";

export async function prepareSessionWorkerPlacementPatchError(
  params: Parameters<typeof resolveSessionWorkerPlacementPatchError>[0],
) {
  const placement = await readSessionWorkerPlacementAsync({
    context: params.context,
    sessionId: params.entry?.sessionId,
  });
  const runtime =
    placement &&
    placement.state !== "local" &&
    params.entry?.sessionId &&
    params.validateModelRuntime &&
    (params.patch.model !== undefined ||
      params.patch.agentRuntime !== undefined ||
      params.patch.nativeRuntimeConsent !== undefined)
      ? await resolveWorkerPlacementSessionRuntimeCapabilitiesAsync({
          cfg: params.cfg,
          entry: params.entry,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
        })
      : undefined;
  return resolveSessionWorkerPlacementPatchError(params, { placement, runtime });
}

/** Prepare placement and inherited model facts; commit validation consumes their current owners. */
export async function prepareSessionWorkerPlacementPatchValidation(
  params: Parameters<typeof resolveSessionWorkerPlacementPatchError>[0],
) {
  const entry = params.entry;
  const placement = entry?.sessionId
    ? await params.context.workerSessionPlacementService?.prepareSessionPlacement?.(entry.sessionId)
    : undefined;
  try {
    const currentPlacement = placement?.current();
    const runtime =
      currentPlacement &&
      currentPlacement.state !== "local" &&
      entry?.sessionId &&
      params.validateModelRuntime &&
      (params.patch.model !== undefined ||
        params.patch.agentRuntime !== undefined ||
        params.patch.nativeRuntimeConsent !== undefined)
        ? await prepareWorkerPlacementSessionRuntime({
            cfg: params.cfg,
            entry,
            agentId: params.agentId,
            sessionKey: params.sessionKey,
          })
        : undefined;
    return {
      validate: () =>
        resolveSessionWorkerPlacementPatchError(params, {
          ...(placement ? { placement: placement.current() } : {}),
          readRuntime:
            runtime && entry
              ? () => resolveWorkerPlacementCapabilities(runtime.read(params.cfg, entry))
              : undefined,
        }),
      release: () => {
        runtime?.[Symbol.dispose]();
        placement?.release();
      },
    };
  } catch (error) {
    placement?.release();
    throw error;
  }
}

export function resolveSessionWorkerPlacementPatchError(
  params: {
    agentId: string;
    cfg: OpenClawConfig;
    context: SessionWorkerPlacementContext;
    entry: SessionEntry | undefined;
    key: string;
    patch: SessionsPatchParams;
    sessionKey: string;
    validateModelRuntime: boolean;
  },
  prepared?: {
    placement?: Awaited<ReturnType<typeof readSessionWorkerPlacementAsync>>;
    runtime?: Awaited<ReturnType<typeof resolveWorkerPlacementSessionRuntimeCapabilitiesAsync>>;
    readRuntime?: () => ReturnType<typeof resolveWorkerPlacementCapabilities>;
  },
): string | undefined {
  const placement =
    prepared && "placement" in prepared
      ? prepared.placement
      : params.entry?.sessionId
        ? params.context.workerSessionPlacementService
            ?.getMany([params.entry.sessionId])
            .get(params.entry.sessionId)
        : undefined;
  if (!placement || placement.state === "local") {
    return undefined;
  }
  if (
    "permissionMode" in params.patch &&
    placement.executionMode === "worker-turn" &&
    placement.turnClaim
  ) {
    return "This remote worker cannot apply permissions while active. Stop the worker run, then change permissions.";
  }
  if (params.patch.archived === false) {
    const restoreError = resolveWorkerPlacementArchiveRestoreError({
      context: params.context,
      key: params.key,
      placement,
    });
    if (restoreError) {
      return restoreError;
    }
  }
  if (
    !params.validateModelRuntime ||
    (params.patch.model === undefined &&
      params.patch.agentRuntime === undefined &&
      params.patch.nativeRuntimeConsent === undefined) ||
    !params.entry?.sessionId
  ) {
    return undefined;
  }
  const runtime = prepared?.readRuntime?.() ?? prepared?.runtime;
  if (!runtime) {
    throw new Error("Session worker placement runtime validation was not prepared");
  }
  const { executionMode } = runtime;
  if (executionMode === placement.executionMode) {
    return undefined;
  }
  return executionMode
    ? `Session ${params.key} cannot change cloud placement execution mode while placement is ${placement.state}.`
    : `Session ${params.key} cannot select a runtime without cloud placement support while cloud worker placement is ${placement.state}.`;
}

export function requireSessionKey(key: unknown, respond: RespondFn): string | null {
  const normalized = normalizeOptionalString(
    typeof key === "string" || typeof key === "number" || typeof key === "bigint"
      ? String(key)
      : undefined,
  );
  if (!normalized) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "key required"));
    return null;
  }
  return normalized;
}

export function emitSessionOperation(
  context: Pick<GatewayRequestContext, "broadcastToConnIds" | "getSessionEventSubscriberConnIds">,
  payload: Omit<SessionOperationEvent, "ts">,
) {
  const connIds = context.getSessionEventSubscriberConnIds();
  if (connIds.size === 0) {
    return;
  }
  context.broadcastToConnIds(
    "session.operation",
    {
      ...payload,
      ts: Date.now(),
    } satisfies SessionOperationEvent,
    connIds,
    { dropIfSlow: true },
  );
}

export function isWorkerDispatchInputError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = error.code;
  return code === "invalid_profile" || code === "profile_not_found" || code === "invalid_state";
}

export function isAgentMainSessionKey(cfg: OpenClawConfig, sessionKey: string): boolean {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return false;
  }
  return sessionKey === resolveAgentMainSessionKey({ cfg, agentId: parsed.agentId });
}

export function resolveProtectedSessionVisibilityError(
  cfg: OpenClawConfig,
  canonicalKey: string,
  action: "archive" | "snooze",
): ErrorShape | undefined {
  if (canonicalKey === "unknown") {
    return errorShape(ErrorCodes.INVALID_REQUEST, `Cannot ${action} the unknown session sentinel.`);
  }
  if (canonicalKey === "global" || isAgentMainSessionKey(cfg, canonicalKey)) {
    return errorShape(ErrorCodes.INVALID_REQUEST, `Cannot ${action} an agent's main session.`);
  }
  return undefined;
}
