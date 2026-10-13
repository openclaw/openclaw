import { startGatewayClientWhenEventLoopReady } from "../../packages/gateway-client/src/readiness.js";
import { readConnectErrorDetailCode } from "../../packages/gateway-protocol/src/connect-error-details.js";
import type { EventFrame } from "../../packages/gateway-protocol/src/schema/frames.js";
import type { GatewayClient, GatewayReconnectPausedInfo } from "../gateway/client.js";
import { isApprovalMethod } from "../gateway/method-scopes.js";
import { createOperatorApprovalsGatewayClient } from "../gateway/operator-approvals-client.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createPendingApprovalRegistry } from "../shared/pending-approval-registry.js";
import { getGatewayNativeApprovalRuntime } from "./approval-gateway-runtime-context.js";
import {
  isGatewayNativeApprovalMethod,
  type GatewayNativeApprovalMethod,
} from "./approval-gateway-runtime-methods.js";
import {
  normalizeApprovalRequest,
  type ApprovalRequestInput,
  type ApprovalResolved as ApprovalResolvedEvent,
  type ChannelApprovalKind,
  type NormalizedApprovalRequest,
} from "./approval-types.js";
import { formatErrorMessage } from "./errors.js";
import type {
  ExecApprovalChannelRuntime,
  ExecApprovalChannelRuntimeAdapterAsync,
} from "./exec-approval-channel-runtime.types.js";
import type { ExecApprovalRequest, ExecApprovalResolved } from "./exec-approvals.js";
export type {
  ExecApprovalChannelRuntime,
  ExecApprovalChannelRuntimeAdapter,
  ExecApprovalChannelRuntimeAdapterAsync,
} from "./exec-approval-channel-runtime.types.js";

type ApprovalRequestEvent = ApprovalRequestInput;
type ApprovalReplayMethod = Extract<
  GatewayNativeApprovalMethod,
  "exec.approval.list" | "plugin.approval.list" | "openclaw.approval.list"
>;

type ApprovalReplayClient = {
  request: <T = unknown>(
    method: ApprovalReplayMethod,
    params: Record<string, unknown>,
  ) => Promise<T>;
};

/** Error raised when the gateway pauses approval reconnects after a terminal startup failure. */
export class ExecApprovalChannelRuntimeTerminalStartError extends Error {
  readonly detailCode: string | null;

  constructor(info: GatewayReconnectPausedInfo, cause?: unknown) {
    super(
      `native approval gateway client paused reconnect after startup auth failure` +
        ` (${info.detailCode ?? "unknown"}): gateway closed (${info.code}): ${info.reason}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "ExecApprovalChannelRuntimeTerminalStartError";
    this.detailCode = info.detailCode;
  }
}

/** Narrows terminal approval runtime startup failures for bootstrap retry policy. */
export function isExecApprovalChannelRuntimeTerminalStartError(
  error: unknown,
): error is ExecApprovalChannelRuntimeTerminalStartError {
  return error instanceof ExecApprovalChannelRuntimeTerminalStartError;
}

type PendingApprovalValue<TPending, TRequest extends ApprovalRequestEvent> = {
  request: NormalizedApprovalRequest<TRequest>;
  entries: TPending[];
};

const APPROVAL_EVENT_PREFIXES = [
  ["exec", "exec"],
  ["plugin", "plugin"],
  ["system-agent", "openclaw"],
] as const;

function resolveApprovalReplayMethods(
  eventKinds: ReadonlySet<ChannelApprovalKind>,
): ApprovalReplayMethod[] {
  return APPROVAL_EVENT_PREFIXES.flatMap(([kind, prefix]) =>
    eventKinds.has(kind) ? [`${prefix}.approval.list` as const] : [],
  );
}

function readGatewayConnectErrorDetailCode(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  return readConnectErrorDetailCode((error as { details?: unknown }).details);
}

/** Creates the gateway-backed approval runtime that tracks pending requests and finalization. */
export function createExecApprovalChannelRuntime<
  TPending,
  TRequest extends ApprovalRequestEvent = ExecApprovalRequest,
  TResolved extends ApprovalResolvedEvent = ExecApprovalResolved,
>(
  adapter: ExecApprovalChannelRuntimeAdapterAsync<TPending, TRequest, TResolved>,
): ExecApprovalChannelRuntime<TRequest, TResolved> {
  const log = createSubsystemLogger(adapter.label);
  const nowMs = adapter.nowMs ?? Date.now;
  const eventKinds = new Set<ChannelApprovalKind>(adapter.eventKinds ?? ["exec"]);
  const configuredGatewayRuntime = getGatewayNativeApprovalRuntime();
  const pending = createPendingApprovalRegistry<PendingApprovalValue<TPending, TRequest>>();
  let gatewayClient: GatewayClient | null = null;
  let gatewayRuntime: typeof configuredGatewayRuntime;
  let unsubscribeGatewayRuntime: (() => void) | null = null;
  let started = false;
  let shouldRun = false;
  let startPromise: Promise<void> | null = null;
  let replayPromise: Promise<void> | null = null;
  let lifecycleRevision = 0;

  const spawn = (label: string, promise: Promise<void>): void => {
    void promise.catch((err: unknown) => {
      const message = formatErrorMessage(err);
      log.error(`${label}: ${message}`);
    });
  };

  const stopClientIfInactive = (client: GatewayClient): boolean => {
    if (shouldRun) {
      return false;
    }
    gatewayClient = null;
    client.stop();
    return true;
  };

  const finalizeExpiredEntry = async (entry: ReturnType<typeof pending.begin>): Promise<void> => {
    log.debug(`expired ${entry.id}`);
    await adapter.finalizeExpired?.(entry.value);
  };

  const handleExpired = async (approvalId: string): Promise<void> => {
    const entry = pending.remove(approvalId);
    if (!entry) {
      return;
    }
    await finalizeExpiredEntry(entry);
  };

  const handleRequested = async (
    requestInput: TRequest,
    opts?: { ignoreIfInactive?: boolean; alreadyAccepted?: boolean },
  ): Promise<void> => {
    if (opts?.ignoreIfInactive && !shouldRun) {
      return;
    }
    const request = normalizeApprovalRequest(requestInput);
    if (pending.has(request.id)) {
      log.debug(`ignored duplicate request ${request.id}`);
      return;
    }
    const entry = pending.begin(request.id, { request, entries: [] });
    const requestRevision = lifecycleRevision;
    let entries: TPending[];
    try {
      const eligibility = opts?.alreadyAccepted === true ? true : adapter.shouldHandle(request);
      const eligible = typeof eligibility === "boolean" ? eligibility : await eligibility;
      if (
        !eligible ||
        (opts?.ignoreIfInactive && !shouldRun) ||
        requestRevision !== lifecycleRevision ||
        !pending.isCurrent(entry) ||
        entry.queued
      ) {
        pending.remove(request.id, entry);
        return;
      }
      log.debug(`received request ${request.id}`);
      entries = await adapter.deliverRequested(request);
    } catch (err) {
      pending.remove(request.id, entry);
      throw err;
    }
    if (!pending.isCurrent(entry)) {
      return;
    }
    if (!entries.length) {
      pending.remove(request.id, entry);
      return;
    }
    await pending.completeDelivery(entry, { request, entries });
    if (!pending.isCurrent(entry)) {
      return;
    }

    const timeoutMs = Math.max(0, request.expiresAtMs - nowMs());
    pending.scheduleExpiry(entry, timeoutMs, (expired) => {
      spawn("error handling approval expiration", finalizeExpiredEntry(expired));
    });
  };

  const handleResolved = async (resolved: TResolved): Promise<void> => {
    if ("terminalStatus" in resolved && resolved.terminalStatus === "expired") {
      await handleExpired(resolved.id);
      return;
    }
    const settled = pending.settle(resolved.id, async (entry) => {
      log.debug(`resolved ${resolved.id} with ${resolved.decision}`);
      await adapter.finalizeResolved({
        request: entry.value.request,
        resolved,
        entries: entry.value.entries,
      });
    });
    if (settled.status === "taken") {
      await settled.terminal(settled.entry);
    }
  };

  const handleGatewayEvent = (evt: EventFrame): void => {
    if (
      APPROVAL_EVENT_PREFIXES.some(
        ([kind, prefix]) => evt.event === `${prefix}.approval.requested` && eventKinds.has(kind),
      )
    ) {
      spawn(
        "error handling approval request",
        // SAFETY: The event name and handled kind select the canonical approval request union.
        handleRequested(evt.payload as TRequest, { ignoreIfInactive: true }),
      );
      return;
    }
    if (
      APPROVAL_EVENT_PREFIXES.some(
        ([kind, prefix]) => evt.event === `${prefix}.approval.resolved` && eventKinds.has(kind),
      )
    ) {
      // SAFETY: The event name and handled kind select the canonical approval resolution union.
      spawn("error handling approval resolved", handleResolved(evt.payload as TResolved));
    }
  };

  const replayPendingApprovals = async (
    client: ApprovalReplayClient,
    externalClient?: GatewayClient,
  ): Promise<void> => {
    try {
      for (const method of resolveApprovalReplayMethods(eventKinds)) {
        if (externalClient && stopClientIfInactive(externalClient)) {
          return;
        }
        const pendingRequests = await client.request<Array<TRequest>>(method, {});
        if (externalClient && stopClientIfInactive(externalClient)) {
          return;
        }
        for (const request of pendingRequests) {
          if (externalClient && stopClientIfInactive(externalClient)) {
            return;
          }
          await handleRequested(request, { ignoreIfInactive: true });
        }
      }
    } catch (error) {
      if (!shouldRun) {
        return;
      }
      throw error;
    }
  };

  const startPendingApprovalReplay = (
    client: ApprovalReplayClient,
    externalClient?: GatewayClient,
  ): void => {
    const promise = replayPendingApprovals(client, externalClient)
      .catch((err: unknown) => {
        const message = formatErrorMessage(err);
        log.error(`error replaying pending approvals: ${message}`);
      })
      .finally(() => {
        if (replayPromise === promise) {
          replayPromise = null;
        }
      });
    replayPromise = promise;
  };

  return {
    async start(): Promise<void> {
      if (started) {
        return;
      }
      if (startPromise) {
        await startPromise;
        return;
      }

      shouldRun = true;
      startPromise = (async () => {
        if (!(await adapter.isConfigured())) {
          log.debug("disabled");
          return;
        }
        if (!shouldRun) {
          return;
        }

        if (configuredGatewayRuntime) {
          await adapter.beforeGatewayClientStart?.();
          gatewayRuntime = configuredGatewayRuntime;
          // Subscribe before replay so a request created during the list calls is not lost.
          unsubscribeGatewayRuntime = gatewayRuntime.subscribe({
            eventKinds,
            shouldHandle: (request) => {
              if (!shouldRun) {
                return false;
              }
              // SAFETY: Gateway-owned subscribers publish the canonical normalized request union.
              const eligible = adapter.shouldHandle(request as NormalizedApprovalRequest<TRequest>);
              return typeof eligible === "boolean"
                ? eligible && shouldRun
                : eligible.then((accepted) => accepted && shouldRun);
            },
            onRequested: (request) => {
              spawn(
                "error handling approval request",
                handleRequested(request as TRequest, {
                  ignoreIfInactive: true,
                  alreadyAccepted: true,
                }),
              );
            },
            onResolved: (resolved) => {
              spawn("error handling approval resolved", handleResolved(resolved as TResolved));
            },
          });
          if (!shouldRun) {
            unsubscribeGatewayRuntime();
            unsubscribeGatewayRuntime = null;
            gatewayRuntime = undefined;
            return;
          }
          started = true;
          startPendingApprovalReplay({ request: gatewayRuntime.request });
          return;
        }

        const ready = createDeferredCore();
        let lastConnectError: unknown = null;

        const client = await createOperatorApprovalsGatewayClient({
          config: adapter.cfg,
          gatewayUrl: adapter.gatewayUrl,
          clientDisplayName: adapter.clientDisplayName,
          onEvent: handleGatewayEvent,
          onHelloOk: () => {
            log.debug("connected to gateway");
            ready.resolve();
          },
          onConnectError: (err) => {
            log.error(`connect error: ${err.message}`);
            lastConnectError = err;
            if (readGatewayConnectErrorDetailCode(err)) {
              return;
            }
            ready.reject(err);
          },
          onReconnectPaused: (info) => {
            ready.reject(new ExecApprovalChannelRuntimeTerminalStartError(info, lastConnectError));
          },
          onClose: (code, reason) => {
            log.debug(`gateway closed: ${code} ${reason}`);
            ready.reject(lastConnectError ?? new Error(`gateway closed: ${code} ${reason}`));
          },
        });

        if (!shouldRun) {
          client.stop();
          return;
        }
        await adapter.beforeGatewayClientStart?.();
        gatewayClient = client;
        try {
          const readiness = await startGatewayClientWhenEventLoopReady(client, {
            clientOptions: {},
          });
          if (!readiness.ready) {
            throw new Error(
              readiness.aborted
                ? "gateway approval runtime start aborted before readiness"
                : "gateway readiness unavailable before exec approval runtime start",
            );
          }
          await ready.promise;
          if (stopClientIfInactive(client)) {
            return;
          }
          started = true;
          startPendingApprovalReplay(client, client);
        } catch (error) {
          gatewayClient = null;
          started = false;
          client.stop();
          throw error;
        }
      })().finally(() => {
        startPromise = null;
      });

      await startPromise;
    },

    async stop(): Promise<void> {
      lifecycleRevision += 1;
      shouldRun = false;
      if (startPromise) {
        await startPromise.catch(() => {});
      }
      const wasActive = started || gatewayClient !== null || replayPromise !== null;
      started = false;
      unsubscribeGatewayRuntime?.();
      unsubscribeGatewayRuntime = null;
      gatewayRuntime = undefined;
      gatewayClient?.stop();
      gatewayClient = null;
      await replayPromise?.catch(() => {});
      if (wasActive) {
        pending.clear();
      }
      await adapter.onStopped?.();
      if (wasActive) {
        log.debug("stopped");
      }
    },

    handleRequested,
    handleResolved,
    handleExpired,

    async request<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
      if (!isApprovalMethod(method)) {
        throw new Error(
          `${adapter.label}: operator approvals runtime cannot dispatch ${method}; use a write-capable gateway client`,
        );
      }
      if (gatewayRuntime) {
        if (!isGatewayNativeApprovalMethod(method)) {
          throw new Error(
            `${adapter.label}: Gateway-owned approval runtime cannot dispatch ${method}`,
          );
        }
        return await gatewayRuntime.request<T>(method, params, {
          clientDisplayName: adapter.clientDisplayName,
        });
      }
      if (!gatewayClient) {
        throw new Error(`${adapter.label}: gateway client not connected`);
      }
      return (await gatewayClient.request(method, params)) as T;
    },
  };
}
