import type { RouteLocation } from "@openclaw/uirouter";
import type {
  ModelsSnapshotEvent,
  SessionsResolveResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { SessionPathTarget } from "../../app-session-route-paths.ts";
import { waitForGatewayClient } from "../../app/gateway-readiness.ts";
import { normalizeAgentId, parseAgentSessionKey } from "../../lib/sessions/session-key.ts";
import type { SessionRouteContext as ApplicationContext } from "./route-loader-context.ts";
import { sessionKeyUuid } from "./route-loader-short-cache.ts";
export type SessionRoutePresentation = Pick<
  GatewaySessionRow,
  "key" | "agentId" | "displayName" | "boardFace"
>;

export type SessionReferenceResolution =
  | { kind: "not-found" }
  | { kind: "unique"; session: SessionRoutePresentation }
  | { kind: "ambiguous"; sessions: SessionRoutePresentation[]; truncated: boolean };

type PreparedShortSessionReference = {
  kind: "prepared";
  session: { key: string; agentId: string };
  resolution: Promise<SessionReferenceResolution>;
  isCurrent: () => boolean;
};

type ResolvedShortSessionReference = SessionReferenceResolution & {
  isCurrent: () => boolean;
};

export async function resolveShortSessionReference(
  context: ApplicationContext,
  target: Extract<SessionPathTarget, { kind: "short" }>,
  location: RouteLocation,
  signal: AbortSignal,
): Promise<ResolvedShortSessionReference | PreparedShortSessionReference> {
  const client = await waitForGatewayClient(context.gateway, signal);
  signal.throwIfAborted();
  const { gateway, sessions } = context;
  const { hello } = gateway.snapshot;
  const profileId = gateway.snapshot.selfUser?.id;
  const connectionRevision = gateway.connectionRevision;
  const lifecycleSignal = context.lifecycleAbortSignal;
  let retired = false;
  const isCurrent = () =>
    !retired &&
    !signal.aborted &&
    !lifecycleSignal?.aborted &&
    context.sessions === sessions &&
    gateway.connectionRevision === connectionRevision &&
    gateway.snapshot.phase === "connected" &&
    gateway.snapshot.client === client &&
    gateway.snapshot.hello === hello &&
    gateway.snapshot.selfUser?.id === profileId;
  // Subscribe before sending: an accepted connect publication can resolve the same short URL.
  const resolution = Promise.resolve().then(async () => {
    signal.throwIfAborted();
    const result = await client.request<SessionsResolveResult>("sessions.resolve", {
      shortId: target.shortId,
      ...(target.slugHint ? { slugHint: target.slugHint } : {}),
      agentId: target.agentId,
      allowMissing: true,
    });
    signal.throwIfAborted();
    return { ...sessionReferenceResolution(result), isCurrent };
  });
  if (target.namespace !== "chat" || location.search || location.hash || !hello) {
    return resolution;
  }
  const prepared = createDeferredCore<PreparedShortSessionReference>();
  let canonicalizationPending = false;
  let stopEvents = () => {};
  let stopGateway = () => {};
  const stop = () => {
    stopEvents();
    stopGateway();
    signal.removeEventListener("abort", abort);
    lifecycleSignal?.removeEventListener("abort", abort);
  };
  const retire = () => {
    retired = true;
    stop();
  };
  const abort = () => {
    retire();
    prepared.reject(signal.aborted ? signal.reason : lifecycleSignal?.reason);
  };
  stopEvents = gateway.subscribeEvents((event) => {
    if (event.event !== "models.snapshot" || !isCurrent()) {
      return;
    }
    // SAFETY: The Gateway observer already accepted this authenticated connect publication.
    const publication = event.payload as ModelsSnapshotEvent;
    const supplied = publication.target;
    const scope = publication.scope;
    if (
      !("shortId" in supplied) ||
      supplied.agentId !== target.agentId ||
      supplied.shortId !== target.shortId ||
      supplied.slugHint !== target.slugHint ||
      !scope.sessionKey ||
      !scope.agentId ||
      normalizeAgentId(scope.agentId) !== normalizeAgentId(target.agentId) ||
      parseAgentSessionKey(scope.sessionKey)?.agentId !== normalizeAgentId(target.agentId) ||
      !sessionKeyUuid(scope.sessionKey)?.startsWith(target.shortId.toLowerCase())
    ) {
      return;
    }
    prepared.resolve({
      kind: "prepared",
      session: { key: scope.sessionKey, agentId: scope.agentId },
      resolution,
      isCurrent,
    });
  });
  stopGateway = gateway.subscribe(() => {
    if (!isCurrent()) {
      retire();
    }
  });
  signal.addEventListener("abort", abort, { once: true });
  lifecycleSignal?.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    lifecycleSignal?.throwIfAborted();
    if (!isCurrent()) {
      retire();
    }
    const result = await Promise.race([resolution, prepared.promise]);
    if (result.kind === "prepared") {
      if (!isCurrent()) {
        return await resolution;
      }
      // Keep retirement observable until the compatible resolver can canonicalize.
      canonicalizationPending = true;
      void resolution.then(stop, stop);
    }
    return result;
  } finally {
    stopEvents();
    if (!canonicalizationPending) {
      stop();
    }
  }
}

export function sessionReferenceResolution(
  result: SessionsResolveResult,
): SessionReferenceResolution {
  if (result.ok) {
    return { kind: "unique", session: result };
  }
  return result.candidates?.length
    ? { kind: "ambiguous", sessions: result.candidates, truncated: result.candidates.length === 10 }
    : { kind: "not-found" };
}
