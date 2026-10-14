import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import { captureOperatorModelPolicySnapshot } from "../agents/operator-model-policy.js";
import { intersectOperatorScopes } from "../shared/operator-scope-compat.js";
import {
  decodeQueuedOperatorRecoverySource,
  MAX_RECOVERY_SOURCE_BYTES,
  type QueuedOperatorRecoverySource,
} from "./operator-run-recovery-source.codec.js";

/** An unrecoverable source still runs in memory under its retained live authority. */
export function captureQueuedOperatorRecoverySource(
  authority: AdmittedRunOperatorAuthority | undefined,
): QueuedOperatorRecoverySource | undefined {
  if (!authority) {
    return undefined;
  }
  assertAdmittedRunOperatorAuthority(authority);
  authority.assertCurrent();
  let captured: QueuedOperatorRecoverySource;
  if (authority.recoverySnapshot) {
    const snapshot = authority.recoverySnapshot;
    captured = {
      kind: "gateway",
      snapshot: { ...snapshot, scopes: intersectOperatorScopes(snapshot.scopes, authority.scopes) },
    };
  } else if (authority.channelRecoverySource) {
    const source = authority.channelRecoverySource;
    const modelPolicy = captureOperatorModelPolicySnapshot(source.modelPolicy);
    if (source.modelPolicy && !modelPolicy) {
      return { kind: "unavailable" };
    }
    captured = {
      kind: "channel",
      snapshot: {
        reference: source.reference,
        profileId: authority.profileId,
        scopes: [...authority.scopes],
        modelPolicy,
      },
    };
  } else {
    return { kind: "unavailable" };
  }
  return Buffer.byteLength(JSON.stringify(captured), "utf8") <= MAX_RECOVERY_SOURCE_BYTES
    ? decodeQueuedOperatorRecoverySource(captured)
    : { kind: "unavailable" };
}
