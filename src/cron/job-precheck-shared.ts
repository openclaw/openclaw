import { isRuntimeToolAllowed } from "../agents/tool-policy-match.js";
import { sanitizeHostExecEnv } from "../infra/host-env-security.js";
import { resolveTrustedWindowsCmdExe } from "../process/windows-command.js";

/** Fixed POSIX transport shell — never honor inherited SHELL (dangerous env). */
const TRUSTED_POSIX_SHELL = "/bin/sh";

/**
 * Resolve a trusted shell executable for unattended precheck.
 * Do not select from raw SHELL/ComSpec after authorization — poisoned Gateway
 * env must not replace the authorized transport.
 */
export function resolveTrustedPrecheckShellCommand(
  command: string,
  _env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { shell: string; args: string[] } {
  if (platform === "win32") {
    // Fixed System32 cmd.exe (or cmd.exe off-Windows); ignore ComSpec.
    const shell = resolveTrustedWindowsCmdExe(platform);
    return { shell, args: ["/d", "/s", "/c", command] };
  }
  return { shell: TRUSTED_POSIX_SHELL, args: ["-c", command] };
}

/** Canonical host-exec env for precheck analysis + spawn (same as system.run). */
export function resolvePrecheckExecEnv(env?: NodeJS.ProcessEnv): Record<string, string> {
  return sanitizeHostExecEnv({ baseEnv: env ?? process.env });
}

/** Stable skip / error reason codes for run logs and operators. */
export const PRECHECK_NO_WORK_REASON = "precheck-no-work";
/** onError=skip for unexpected probe failures — distinct from quiet no-work. */
export const PRECHECK_SKIPPED_ERROR_REASON = "precheck-skipped-error";
export const PRECHECK_POLICY_DENIED_REASON = "precheck-policy-denied";
export const PRECHECK_ERROR_REASON = "precheck-error";
export const PRECHECK_TIMEOUT_REASON = "precheck-timeout";
export const PRECHECK_INVALID_REASON = "precheck-invalid";
export const PRECHECK_TRIGGERS_DISABLED =
  "cron precheck is a host-shell command and is disabled because the operator set cron.triggers.enabled: false; remove it or set it to true to allow unattended precheck scripts";

/**
 * Job-scoped toolsAllow must permit core `exec` for precheck.
 * Undefined allowlist = unrestricted. Empty or non-matching cap denies.
 * Uses the canonical runtime tool-cap matcher (exact / group / glob) so
 * unrelated plugin-style names like `vendor.exec` do not authorize host shell.
 */
export function cronToolsAllowPermitsPrecheckExec(
  toolsAllow: readonly string[] | undefined | null,
): boolean {
  // Fail closed: absent toolsAllow must not mean unrestricted host shell.
  // Create/update paths stamp ["*"] via applyDefaultCronToolsAllow when precheck
  // is present; runtime still denies if a job somehow reaches exec without a cap.
  if (toolsAllow === undefined || toolsAllow === null) {
    return false;
  }
  // Core host-shell authority only — not every `*.exec` plugin tool name.
  return isRuntimeToolAllowed("exec", [...toolsAllow]);
}
