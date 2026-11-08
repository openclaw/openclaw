import { createHash } from "node:crypto";
import type { WorkerExecApprovalBinding } from "../../packages/gateway-protocol/src/schema/worker-exec-approval.js";

export function workerExecApprovalDigest(binding: WorkerExecApprovalBinding): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        binding.command,
        binding.execCommand,
        binding.cwd,
        binding.environment,
        binding.pty,
      ]),
    )
    .digest("hex");
}
