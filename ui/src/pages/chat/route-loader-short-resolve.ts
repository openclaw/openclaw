import { racePromiseWithAbortSignal } from "@openclaw/retry";
import type { SessionsResolveResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { SessionPathTarget } from "../../app-session-route-paths.ts";
import { waitForGatewayClient } from "../../app/gateway-readiness.ts";
import type { SessionRouteContext as ApplicationContext } from "./route-loader-context.ts";
export type SessionRoutePresentation = Pick<
  GatewaySessionRow,
  "key" | "agentId" | "displayName" | "boardFace"
>;

export type SessionReferenceResolution =
  | { kind: "not-found" }
  | { kind: "unique"; session: SessionRoutePresentation }
  | { kind: "ambiguous"; sessions: SessionRoutePresentation[]; truncated: boolean };

type ResolvedShortSessionReference = SessionReferenceResolution & {
  isCurrent: () => boolean;
};

export async function resolveShortSessionReference(
  context: ApplicationContext,
  target: Extract<SessionPathTarget, { kind: "short" }>,
  signal: AbortSignal,
): Promise<ResolvedShortSessionReference> {
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
  const requestSignal = lifecycleSignal ? AbortSignal.any([signal, lifecycleSignal]) : signal;
  const stopGateway = gateway.subscribe(() => {
    if (!isCurrent()) {
      retired = true;
    }
  });
  try {
    requestSignal.throwIfAborted();
    const result = await racePromiseWithAbortSignal(
      () =>
        client.request<SessionsResolveResult>(
          "sessions.resolve",
          {
            shortId: target.shortId,
            ...(target.slugHint ? { slugHint: target.slugHint } : {}),
            agentId: target.agentId,
            allowMissing: true,
          },
          { signal: requestSignal },
        ),
      requestSignal,
    );
    return { ...sessionReferenceResolution(result), isCurrent };
  } finally {
    stopGateway();
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
