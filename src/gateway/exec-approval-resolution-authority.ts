import { ApprovalMutationRefusedError } from "./exec-approval-authority.js";
import type {
  ExecApprovalManagerOptions,
  ExecApprovalRecord,
  OperatorStandingGrantMintSpec,
} from "./exec-approval-manager.types.js";

/** A prepared standing grant is valid only while its request and tool owner still match. */
export function assertExecApprovalStandingGrantCurrent<TPayload>(
  options: ExecApprovalManagerOptions<TPayload>,
  record: ExecApprovalRecord<TPayload> | undefined,
  standingGrantSpec: OperatorStandingGrantMintSpec | null | undefined,
): void {
  if (
    standingGrantSpec &&
    record &&
    (JSON.stringify(options.resolveStandingGrantMint?.(record.request)) !==
      JSON.stringify(standingGrantSpec) ||
      (standingGrantSpec.kind === "mcp-tool" && record.mcpToolApprovalActive?.() !== true))
  ) {
    throw new ApprovalMutationRefusedError("approval standing grant authority is no longer active");
  }
}
