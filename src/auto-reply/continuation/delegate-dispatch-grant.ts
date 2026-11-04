/**
 * The bounded operator grant a continuation delegate dispatches under (#1271).
 *
 * A delegate elected by a Gateway operator connection (k6, CLI `agent`, webchat) used to
 * dispatch under whatever request scope armed its timer: the electing connection, which an
 * ordinary disconnect closes, or none after a restart. Election now captures that operator's
 * durable source (principal and scope ceiling) with the record; dispatch restores it through
 * the shared operator-recovery owner, which still fails closed on device revocation, profile
 * or role change and narrowed scopes. Delegates elected without a Gateway operator (channel
 * and internal turns) carry no grant and dispatch as before.
 */

import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { withoutGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { captureAmbientGatewayOperatorAuthority } from "../../gateway/operator-invocation-authority.js";
import { captureQueuedOperatorRecoverySource } from "../../gateway/operator-run-recovery-source.js";
import { restoreGatewayQueuedOperatorRecovery } from "../../gateway/operator-run-recovery.js";
import { runOutsideOperatorToolGatewayAuthority } from "../../gateway/operator-tool-gateway-authority.js";
import type { GatewayContextResolver } from "../../gateway/server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "../../gateway/server-plugin-runtime-client.js";
import {
  getInProcessGatewayRequestContext,
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import type { ContinuationDelegateDispatchGrant } from "./types.js";

/**
 * A grant outlives its delegate's due time by this much: room for hedge retries, busy
 * re-arms and a Gateway restart, but an operator's hour-old authorization never fires.
 */
export const CONTINUATION_DELEGATE_GRANT_SLACK_MS = 60 * 60 * 1000;

function grantRefused(reason: string, cause?: unknown): Error {
  const detail = cause instanceof Error ? `: ${cause.message}` : "";
  return new Error(`Continuation delegate operator dispatch grant ${reason}${detail}.`, {
    cause,
  });
}

/**
 * The electing run's Gateway operator, or nothing when no operator elected. A run's admitted
 * authority outlives its request's connection, so callers outside a tool pass it explicitly.
 */
export async function captureContinuationDelegateDispatchGrant(params: {
  ownerSessionKey: string;
  dueAt: number;
  electingOperatorAuthority?: AdmittedRunOperatorAuthority;
}): Promise<ContinuationDelegateDispatchGrant | undefined> {
  const ambient = params.electingOperatorAuthority
    ? { authority: params.electingOperatorAuthority, release: undefined }
    : await captureAmbientGatewayOperatorAuthority({
        missingBindingError: () =>
          new Error("Continuation delegate election requires the operator's Gateway binding."),
      });
  try {
    const source = captureQueuedOperatorRecoverySource(ambient.authority);
    // Channel principals are bound to their channel turn, not to a Gateway connection.
    if (!source || source.kind === "channel") {
      return undefined;
    }
    if (source.kind === "unavailable") {
      throw new Error(
        "This operator connection's authority cannot be retained for a delegated dispatch; reconnect with a paired device or the Gateway token and try again.",
      );
    }
    return {
      source,
      ownerSessionKey: params.ownerSessionKey,
      expiresAt: params.dueAt + CONTINUATION_DELEGATE_GRANT_SLACK_MS,
    };
  } finally {
    ambient.release?.();
  }
}

/**
 * Run a delegate's spawn under its grant. The restored source replaces the arming request's
 * scope: neither the electing connection nor whoever armed the timer authorizes the child.
 */
export async function runUnderContinuationDelegateDispatchGrant<T>(
  params: {
    grant: ContinuationDelegateDispatchGrant | undefined;
    ownerSessionKey: string;
    resolveGatewayContext?: GatewayContextResolver;
  },
  run: () => Promise<T>,
): Promise<T> {
  const { grant } = params;
  if (!grant) {
    return await run();
  }
  if (grant.ownerSessionKey !== params.ownerSessionKey) {
    throw grantRefused("belongs to another session");
  }
  if (Date.now() > grant.expiresAt) {
    throw grantRefused("expired");
  }
  const resolveGatewayContext =
    getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext ?? params.resolveGatewayContext;
  const context = getInProcessGatewayRequestContext(resolveGatewayContext);
  if (!resolveGatewayContext || !context) {
    throw grantRefused("has no Gateway to restore it");
  }
  let restored: Awaited<ReturnType<typeof restoreGatewayQueuedOperatorRecovery>>;
  try {
    restored = await restoreGatewayQueuedOperatorRecovery({
      source: grant.source,
      context,
      assertCurrent: () => {
        if (resolveGatewayContext() !== context) {
          throw new Error("the Gateway instance changed");
        }
      },
    });
  } catch (error) {
    throw grantRefused("was revoked", error);
  }
  try {
    const { authority } = restored;
    const client = createSyntheticPluginRuntimeClient({
      operatorRoleActor: { kind: "operator", profileId: authority.profileId },
      operatorRunAuthority: authority,
      scopes: [...authority.scopes],
    });
    return await withoutGatewayToolCallerIdentity(() =>
      runOutsideOperatorToolGatewayAuthority(() =>
        withPluginRuntimeGatewayRequestScope(
          { context, resolveGatewayContext, client, isWebchatConnect: () => false },
          run,
        ),
      ),
    );
  } finally {
    restored.release();
  }
}
