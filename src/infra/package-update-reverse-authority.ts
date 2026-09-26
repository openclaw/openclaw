import {
  captureUpdateCommandExecutorAuthority,
  captureUpdateCommandRecoveryGenerationAuthority,
} from "../cli/update-cli/update-command-executor.js";
import type { UpdateRecoveryFence } from "./update-run-recovery.js";

const admitted = new WeakSet<object>();
type Authority = Readonly<{
  runId: string;
  resuming: boolean;
  identity: ReturnType<typeof captureUpdateCommandExecutorAuthority>;
  assertCurrent: () => void;
}>;

/** Capture while ordinary admission is ready. Only the executor's own native
 * registry can issue this capability; a caller callback or copied object cannot. */
export function capturePackageReverseExecutor(
  fence: UpdateRecoveryFence,
  runId: string,
  resuming = false,
): Authority {
  const identity = Object.freeze({ ...captureUpdateCommandExecutorAuthority(fence, runId) });
  const assertOrdinary = fence.assertCurrent.bind(fence);
  const assertCurrent = resuming
    ? assertOrdinary
    : captureUpdateCommandRecoveryGenerationAuthority(fence, runId);
  const authority = Object.freeze({ runId, resuming, identity, assertCurrent });
  admitted.add(authority);
  return authority;
}

export function assertPackageReverseExecutor(
  authority: Authority,
  runId: string,
  resuming: boolean,
) {
  if (!admitted.has(authority) || authority.runId !== runId || authority.resuming !== resuming) {
    throw new Error("Reverse publication requires its captured native executor.");
  }
  authority.assertCurrent();
  return authority.identity;
}
