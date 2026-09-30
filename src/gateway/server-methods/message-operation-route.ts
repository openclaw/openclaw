// Owns route binding, replay, and in-flight lifetime for Gateway message operations.
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { ConversationReadInvocationOrigin } from "../../channels/plugins/conversation-read-origin.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { normalizeOptionalAccountId } from "../../routing/session-key.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import { DEDUPE_MAX, DEDUPE_TTL_MS } from "../server-constants.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { formatForLog } from "../ws-log.js";
import {
  resolveGatewayInflightRequest as resolveIdempotentGatewayRequest,
  runGatewayInflightWork,
  type GatewayInflightResult as InflightResult,
} from "./inflight.js";
import { resolveMessageOperationAccountRoute } from "./send-account-route.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

type MessageOperationPrefix = "message.action" | "poll" | "send";

type MessageOperationRoute = {
  channel: string;
  accountId: string;
  requestScope: string;
};

type MessageOperationRouteBinding = {
  key: string;
  reservedRoute?: MessageOperationRoute;
};

type MessageOperationRouteBindingEntry = {
  requestScope: string;
  retainUntilSettled: boolean;
  ts: number;
};

// Send and poll callers can spell one canonical route four ways by omitting or
// supplying channel/account defaults. Preserve every alias for the full result budget.
const MESSAGE_OPERATION_ROUTE_BINDING_MAX = DEDUPE_MAX * 4;
const messageOperationRouteBindings = new WeakMap<
  GatewayRequestContext,
  Map<string, MessageOperationRouteBindingEntry>
>();
const messageOperationRouteBindingQueues = new WeakMap<GatewayRequestContext, KeyedAsyncQueue>();

function pruneMessageOperationRouteBindings(
  bindings: Map<string, MessageOperationRouteBindingEntry>,
  now: number,
): void {
  for (const [key, entry] of bindings) {
    if (!entry.retainUntilSettled && now - entry.ts > DEDUPE_TTL_MS) {
      bindings.delete(key);
    }
  }
  const excess = bindings.size - MESSAGE_OPERATION_ROUTE_BINDING_MAX;
  if (excess <= 0) {
    return;
  }
  const oldestSettledKeys = [...bindings.entries()]
    .filter(([, entry]) => !entry.retainUntilSettled)
    .toSorted(([, left], [, right]) => left.ts - right.ts)
    .slice(0, excess)
    .map(([key]) => key);
  for (const key of oldestSettledKeys) {
    bindings.delete(key);
  }
}

function getMessageOperationRouteBindings(
  context: GatewayRequestContext,
): Map<string, MessageOperationRouteBindingEntry> {
  let bindings = messageOperationRouteBindings.get(context);
  if (!bindings) {
    bindings = new Map();
    messageOperationRouteBindings.set(context, bindings);
  }
  pruneMessageOperationRouteBindings(bindings, Date.now());
  return bindings;
}

function getMessageOperationRouteBindingQueue(context: GatewayRequestContext): KeyedAsyncQueue {
  let queue = messageOperationRouteBindingQueues.get(context);
  if (!queue) {
    queue = new KeyedAsyncQueue();
    messageOperationRouteBindingQueues.set(context, queue);
  }
  return queue;
}

async function acquireMessageOperationRouteBindingLock(params: {
  context: GatewayRequestContext;
  binding: MessageOperationRouteBinding | undefined;
}): Promise<() => void> {
  if (!params.binding) {
    return () => undefined;
  }

  const acquired = createDeferredCore();
  const held = createDeferredCore();
  // The lock covers mutable route selection through canonical in-flight registration.
  // Otherwise a later retry can bind newer defaults while the first request is resolving.
  void getMessageOperationRouteBindingQueue(params.context).enqueue(
    params.binding.key,
    async () => {
      acquired.resolve();
      await held.promise;
    },
  );
  await acquired.promise;
  return held.resolve;
}

function resolveMessageOperationAuthorityScope(params: {
  prefix: MessageOperationPrefix;
  conversationReadOrigin?: ConversationReadInvocationOrigin;
  operation?: string;
}): string {
  return params.prefix === "message.action"
    ? `:${params.conversationReadOrigin ?? "delegated"}:${params.operation ?? "unknown"}`
    : "";
}

function resolveGatewayInflightRequest(params: {
  context: GatewayRequestContext;
  prefix: MessageOperationPrefix;
  idempotencyKey: string;
  respond: RespondFn;
  conversationReadOrigin?: ConversationReadInvocationOrigin;
  operation?: string;
  requestScope?: string;
}) {
  const idem = params.idempotencyKey;
  const authorityScope = resolveMessageOperationAuthorityScope(params);
  const requestScope = params.requestScope ? `:${params.requestScope}` : "";
  const dedupeKey = `${params.prefix}${authorityScope}${requestScope}:${idem}`;
  return resolveIdempotentGatewayRequest({
    context: params.context,
    dedupeKey,
    idempotencyKey: idem,
    respond: params.respond,
  });
}

function parseMessageOperationRoute(
  requestScope: string | undefined,
): MessageOperationRoute | undefined {
  if (!requestScope) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(requestScope);
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== "string" ||
      typeof parsed[1] !== "string"
    ) {
      return undefined;
    }
    const channel = normalizeMessageChannel(parsed[0]);
    const accountId = normalizeOptionalAccountId(parsed[1]);
    if (!channel || channel !== parsed[0] || !accountId || accountId !== parsed[1]) {
      return undefined;
    }
    return { channel, accountId, requestScope };
  } catch {
    return undefined;
  }
}

function resolveMessageOperationRouteBinding(params: {
  context: GatewayRequestContext;
  prefix: MessageOperationPrefix;
  idempotencyKey: string;
  conversationReadOrigin?: ConversationReadInvocationOrigin;
  operation?: string;
  requestChannel: unknown;
  accountIds: readonly unknown[];
}): MessageOperationRouteBinding | undefined {
  const rawChannel = readStringValue(params.requestChannel);
  const channel = rawChannel ? normalizeMessageChannel(rawChannel) : undefined;
  if (rawChannel && !channel) {
    return undefined;
  }
  const providedAccountIds = params.accountIds.filter(
    (value) => value !== undefined && value !== null && (typeof value !== "string" || value.trim()),
  );
  const normalizedAccountIds = providedAccountIds.map((value) =>
    typeof value === "string" ? normalizeOptionalAccountId(value) : undefined,
  );
  if (normalizedAccountIds.some((accountId) => !accountId)) {
    return undefined;
  }
  // SAFETY: the preceding guard returns if any normalized account is absent.
  const distinctAccountIds = [...new Set(normalizedAccountIds as string[])];
  if (distinctAccountIds.length > 1) {
    return undefined;
  }
  const accountId = distinctAccountIds[0];
  const authorityScope = resolveMessageOperationAuthorityScope(params);
  const explicitRouteScope = JSON.stringify([channel ?? null, accountId ?? null]);
  const key = `${params.prefix}${authorityScope}:route-binding:${explicitRouteScope}:${params.idempotencyKey}`;
  return {
    key,
    reservedRoute: parseMessageOperationRoute(
      getMessageOperationRouteBindings(params.context).get(key)?.requestScope,
    ),
  };
}

/** Validate under the route lock; publish only for accepted replay or newly admitted input. */
function prepareMessageOperationRouteBinding(params: {
  context: GatewayRequestContext;
  binding: MessageOperationRouteBinding | undefined;
  requestScope: string;
}): (() => void) | undefined {
  const binding = params.binding;
  if (!binding) {
    return () => undefined;
  }
  const bindings = getMessageOperationRouteBindings(params.context);
  const existing = bindings.get(binding.key);
  if (existing && existing.requestScope !== params.requestScope) {
    return undefined;
  }
  return () => {
    bindings.set(
      binding.key,
      existing
        ? { ...existing, ts: Date.now() }
        : { ts: Date.now(), requestScope: params.requestScope, retainUntilSettled: false },
    );
    pruneMessageOperationRouteBindings(bindings, Date.now());
  };
}

function updateMessageOperationRouteBinding(params: {
  context: GatewayRequestContext;
  binding: MessageOperationRouteBinding | undefined;
  requestScope: string;
  retainUntilSettled: boolean;
}): void {
  if (!params.binding) {
    return;
  }
  const bindings = getMessageOperationRouteBindings(params.context);
  const existing = bindings.get(params.binding.key);
  if (existing?.requestScope === params.requestScope) {
    // Active work retains its alias past TTL/capacity pressure; settlement restarts expiry.
    bindings.set(params.binding.key, {
      ...existing,
      ...(!params.retainUntilSettled ? { ts: Date.now() } : {}),
      retainUntilSettled: params.retainUntilSettled,
    });
    if (!params.retainUntilSettled) {
      pruneMessageOperationRouteBindings(bindings, Date.now());
    }
  }
}

export async function withMessageOperationRoute<
  T extends {
    cfg: OpenClawConfig;
    channel: string;
    plugin: ChannelPlugin;
  },
>(params: {
  context: GatewayRequestContext;
  prefix: MessageOperationPrefix;
  idempotencyKey: string;
  respond: RespondFn;
  conversationReadOrigin?: ConversationReadInvocationOrigin;
  operation?: string;
  requestChannel: unknown;
  bindingAccountIds: readonly unknown[];
  routeAccountIds: (binding: MessageOperationRouteBinding | undefined) => readonly unknown[];
  conflictMessage: string;
  authorize?: () => boolean;
  /** Input-only policy never replaces an already accepted receipt. */
  assertNewInputAllowed?: () => void;
  /** Ephemeral scheduled reads must consult current provider policy on every invocation. */
  replayResults?: boolean;
  resolveChannel: (requestChannel: unknown) => Promise<T | undefined>;
  work: (
    route: T & {
      accountId: string | undefined;
      idem: string;
      dedupeKey: string | undefined;
      authorize: () => boolean;
    },
  ) => Promise<InflightResult>;
}): Promise<void> {
  if (params.replayResults === false) {
    const resolved = await params.resolveChannel(params.requestChannel);
    if (!resolved) {
      return;
    }
    try {
      const accountRoute = await resolveMessageOperationAccountRoute({
        ...resolved,
        accountIds: params.routeAccountIds(undefined),
        conflictMessage: params.conflictMessage,
      });
      const authorize = params.authorize ?? (() => true);
      const assertCurrent = () => {
        if (!authorize()) {
          throw new Error("agent runtime authority is no longer active");
        }
      };
      assertCurrent();
      params.assertNewInputAllowed?.();
      const result = await params.work({
        ...resolved,
        accountId: accountRoute.effectiveAccountId,
        idem: params.idempotencyKey,
        dedupeKey: undefined,
        authorize,
      });
      assertCurrent();
      params.respond(result.ok, result.payload, result.error, result.meta);
    } catch (error) {
      respondMessageOperationAdmissionError({
        respond: params.respond,
        channel: resolved.channel,
        error,
      });
    }
    return;
  }
  const bindingParams = {
    context: params.context,
    prefix: params.prefix,
    idempotencyKey: params.idempotencyKey,
    conversationReadOrigin: params.conversationReadOrigin,
    operation: params.operation,
    requestChannel: params.requestChannel,
    accountIds: params.bindingAccountIds,
  };
  let binding = resolveMessageOperationRouteBinding(bindingParams);
  const releaseLock = await acquireMessageOperationRouteBindingLock({
    context: params.context,
    binding,
  });
  try {
    // Re-resolve under the lock so route aliases bind against current state; replay
    // releases first because awaiting while locked would deadlock concurrent retries.
    binding = resolveMessageOperationRouteBinding(bindingParams);
    const reservedReplay = binding?.reservedRoute
      ? resolveGatewayInflightRequest({
          context: params.context,
          prefix: params.prefix,
          idempotencyKey: params.idempotencyKey,
          respond: params.respond,
          conversationReadOrigin: params.conversationReadOrigin,
          operation: params.operation,
          requestScope: binding.reservedRoute.requestScope,
        })
      : undefined;
    if (reservedReplay?.kind === "handled") {
      releaseLock();
      await reservedReplay.done;
      return;
    }
    const resolved = await params.resolveChannel(
      binding?.reservedRoute?.channel ?? params.requestChannel,
    );
    if (!resolved) {
      return;
    }
    let accountRoute: Awaited<ReturnType<typeof resolveMessageOperationAccountRoute>>;
    try {
      accountRoute = await resolveMessageOperationAccountRoute({
        ...resolved,
        accountIds: params.routeAccountIds(binding),
        conflictMessage: params.conflictMessage,
      });
    } catch (error) {
      respondMessageOperationAdmissionError({
        respond: params.respond,
        channel: resolved.channel,
        error,
      });
      return;
    }
    const publishBinding = prepareMessageOperationRouteBinding({
      context: params.context,
      binding,
      requestScope: accountRoute.requestScope,
    });
    if (!publishBinding) {
      respondMessageOperationAdmissionError({
        respond: params.respond,
        channel: resolved.channel,
        error: "idempotency key is already bound to a different message route",
      });
      return;
    }
    const inflight = resolveGatewayInflightRequest({
      context: params.context,
      prefix: params.prefix,
      idempotencyKey: params.idempotencyKey,
      respond: params.respond,
      conversationReadOrigin: params.conversationReadOrigin,
      operation: params.operation,
      requestScope: accountRoute.requestScope,
    });
    if (inflight.kind === "handled") {
      publishBinding();
      releaseLock();
      await inflight.done;
      return;
    }
    // Routing and attachment preparation may yield while the admitted run
    // closes. Revalidate before any provider-visible message side effect.
    if (params.authorize && !params.authorize()) {
      params.respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "agent runtime authority is no longer active"),
      );
      return;
    }
    try {
      params.assertNewInputAllowed?.();
    } catch (error) {
      respondMessageOperationAdmissionError({
        respond: params.respond,
        channel: resolved.channel,
        error,
      });
      return;
    }
    publishBinding();
    updateMessageOperationRouteBinding({
      context: params.context,
      binding,
      requestScope: accountRoute.requestScope,
      retainUntilSettled: true,
    });
    const work = params
      .work({
        ...resolved,
        accountId: accountRoute.accountId,
        idem: inflight.idem,
        dedupeKey: inflight.dedupeKey,
        authorize: params.authorize ?? (() => true),
      })
      .finally(() => {
        updateMessageOperationRouteBinding({
          context: params.context,
          binding,
          requestScope: accountRoute.requestScope,
          retainUntilSettled: false,
        });
      });
    const inflightWork = runGatewayInflightWork({ ...inflight, work, respond: params.respond });
    releaseLock();
    await inflightWork;
  } finally {
    releaseLock();
  }
}

function respondMessageOperationAdmissionError(params: {
  respond: RespondFn;
  channel: string;
  error: unknown;
}): void {
  const error =
    params.error instanceof SessionMutationAuthorizationChangedError
      ? params.error.error
      : errorShape(ErrorCodes.INVALID_REQUEST, String(params.error));
  params.respond(false, undefined, error, {
    channel: params.channel,
    error: formatForLog(params.error),
  });
}
