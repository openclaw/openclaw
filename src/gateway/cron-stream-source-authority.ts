import { ownsStreamSource } from "../cron/stream-schedule.js";
import type { CronStoredJob } from "../cron/types.js";
import type { RestoredGatewayOperatorAuthority } from "./operator-run-recovery.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

export const CRON_STREAM_SOURCE_CHANGED =
  "The operator authority that authorized this stream is no longer current; re-enable it from an authenticated turn.";

/** Restores the native process's original full grant, never the mutable payload's source. */
export async function prepareCronStreamSourceAuthority(params: {
  job: CronStoredJob;
  scheduleKey: string;
  sourceIdentity: string;
  resolveGatewayContext?: () => GatewayRequestContext | undefined;
  assertCurrent: () => void;
  revoked: () => void;
}): Promise<{ isCurrent: () => boolean; release: () => void } | undefined> {
  const { job } = params;
  // Sandbox execution already retains its original operator through the sandbox target owner.
  const snapshot = job.streamSandbox ? undefined : job.streamOperatorSource;
  if (
    !snapshot &&
    (job.streamSandbox || !job.operatorSource?.source.snapshot.openclawIdPrincipal)
  ) {
    return { isCurrent: () => true, release: () => {} };
  }
  let active = true;
  let restored: RestoredGatewayOperatorAuthority | undefined;
  const onRevoked = () => {
    try {
      params.assertCurrent();
    } catch {
      // A normal stop/replacement already owns teardown; it is not a grant failure.
      return;
    }
    params.revoked();
  };
  const release = () => {
    active = false;
    restored?.authority.signal?.removeEventListener("abort", onRevoked);
    restored?.release();
    restored = undefined;
  };
  try {
    const context = params.resolveGatewayContext?.();
    if (!snapshot || !context) {
      throw new Error("Native stream source is missing; re-enable it from an authenticated turn.");
    }
    const assertCurrent = () => {
      params.assertCurrent();
      const current = context.cron.getJob(job.id);
      if (
        !active ||
        params.resolveGatewayContext?.() !== context ||
        !current?.enabled ||
        current.state.streamRestartExhausted ||
        !ownsStreamSource(current, params.scheduleKey, params.sourceIdentity)
      ) {
        throw new Error("Native stream source identity is no longer current.");
      }
    };
    const { restoreGatewayOperatorSource } = await import("./operator-run-recovery.js");
    restored = await restoreGatewayOperatorSource({ snapshot, context, assertCurrent });
    // The recovery owner publishes profile, app-grant, credential and device revocation here.
    restored.authority.signal?.addEventListener("abort", onRevoked, { once: true });
    restored.authority.assertCurrent();
    return {
      isCurrent: () => {
        try {
          if (!restored) {
            return false;
          }
          restored.authority.assertCurrent();
          return true;
        } catch {
          onRevoked();
          return false;
        }
      },
      release,
    };
  } catch {
    release();
    onRevoked();
    return undefined;
  }
}
