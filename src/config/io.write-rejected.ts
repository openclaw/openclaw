import { err, ok } from "@openclaw/normalization-core/result";
import { formatErrorMessage } from "../infra/errors.js";
import type { ConfigWriteAuditResult } from "./io.audit.js";
import type { NormalizedConfigIoDeps } from "./io.read.types.js";
import { createConfigWriteSafetyRejectionError } from "./io.write-errors.js";
import { formatConfigArtifactTimestamp } from "./io.write-safety.js";

/**
 * Reject a blocked write: persist the rejected payload, audit, and throw.
 *
 * The rejected payload is saved with an exclusive create next to the config so
 * operators can inspect the exact bytes that were refused; the write audit
 * records the rejection before the caller-visible error propagates.
 */
export async function rejectConfigWriteForBlockingReasons(params: {
  deps: NormalizedConfigIoDeps;
  configPath: string;
  json: string;
  blockingReasons: string[];
  allowDestructiveWrite: boolean | undefined;
  assertConfigPathForWrite: (() => void) | undefined;
  appendWriteAudit: (result: ConfigWriteAuditResult, error?: unknown) => Promise<void>;
}): Promise<void> {
  const { deps, configPath, json, blockingReasons } = params;
  if (blockingReasons.length === 0 || params.allowDestructiveWrite === true) {
    return;
  }
  const rejectedPath = `${configPath}.rejected.${formatConfigArtifactTimestamp(new Date().toISOString())}`;
  // Only the completed exclusive create proves this payload is available for inspection.
  params.assertConfigPathForWrite?.();
  const rejectedSave = await deps.fs.promises
    .writeFile(rejectedPath, json, { encoding: "utf-8", mode: 0o600, flag: "wx" })
    .then(ok, err);
  const saveDetail = rejectedSave.ok
    ? `Rejected payload saved to ${rejectedPath}.`
    : `Rejected payload could not be saved to ${rejectedPath}: ${formatErrorMessage(rejectedSave.error)}.`;
  const diagnosticMessage = `Config write rejected: ${configPath} (${blockingReasons.join(", ")}). ${saveDetail}`;
  const diagnosticError = Object.assign(new Error(diagnosticMessage), {
    code: "CONFIG_WRITE_REJECTED",
    ...(rejectedSave.ok ? { rejectedPath } : {}),
    reasons: blockingReasons,
  });
  const userFacingError = createConfigWriteSafetyRejectionError({
    reasons: blockingReasons,
    ...(rejectedSave.ok ? { rejectedPath } : {}),
  });
  deps.logger.warn(diagnosticMessage);
  await params.appendWriteAudit("rejected", diagnosticError);
  throw userFacingError;
}
