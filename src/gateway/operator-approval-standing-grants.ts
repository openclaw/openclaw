import { stableStringify } from "@openclaw/normalization-core";
import { buildSystemRunApprovalEnvBinding } from "../infra/system-run-approval-binding.js";

/**
 * Exact gateway-exec operation binding: trimmed command text, cwd, and the
 * env-override hash. Both mint (approval creation) and use (allowlist
 * evaluation) derive it from the same raw inputs, so matching is byte-exact —
 * the same semantics as systemRunBinding digest matching.
 */
export function buildCronExecOperationBinding(params: {
  command: string;
  cwd: string | null | undefined;
  env: Record<string, string> | undefined;
}): string {
  return stableStringify({
    v: 1,
    command: params.command.trim(),
    cwd: params.cwd?.trim() || null,
    envHash: buildSystemRunApprovalEnvBinding(params.env).envHash,
  });
}

/** Parses a stored operation binding back into its display facts. */
export function parseCronExecOperationBinding(binding: string): {
  command: string;
  cwd: string | null;
} | null {
  try {
    // SAFETY: fields stay unknown; the guards below validate before use.
    const parsed = JSON.parse(binding) as { v?: unknown; command?: unknown; cwd?: unknown };
    if (parsed.v !== 1 || typeof parsed.command !== "string") {
      return null;
    }
    return { command: parsed.command, cwd: typeof parsed.cwd === "string" ? parsed.cwd : null };
  } catch {
    return null;
  }
}
