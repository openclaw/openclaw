/**
 * macOS TCC permission error detector for exec output.
 *
 * When a command fails with a macOS permission-related error,
 * appends a hint pointing the agent to the permctl skill.
 * This runs at the tool layer so agents cannot bypass it.
 */

// Patterns that indicate macOS TCC permission denials
const TCC_ERROR_PATTERNS = [
  /not allowed to send keystrokes/i,
  /not authorized to send apple events/i,
  /(?:Library|TCC|Privacy).*operation not permitted|operation not permitted.*(?:Library|TCC|Privacy)/i,
  /tccd.*deny/i,
  /assistive access/i,
  /screen.?recording/i,
  /not allowed assistive access/i,
  /osascript is not allowed/i,
  /System Events got an error.*not allowed/i,
  /is not authorized to/i,
  /kTCCService/i,
  /user denied/i,
  /requires? the accessibility/i,
  /This app is not authorized/i,
  /AXError/i,
];

// Map error patterns to likely permission kinds
const PERMISSION_HINTS: Array<{ pattern: RegExp; permission: string }> = [
  {
    pattern: /screen.?recording|screencapture|kTCCServiceScreenCapture/i,
    permission: "screen-recording",
  },
  {
    pattern: /assistive access|accessibility|AXError|kTCCServiceAccessibility/i,
    permission: "accessibility",
  },
  {
    pattern: /apple events|not authorized to send|automation|kTCCServiceAppleEvents/i,
    permission: "automation",
  },
  {
    pattern: /operation not permitted.*Library|full.?disk|kTCCServiceSystemPolicyAllFiles/i,
    permission: "full-disk-access",
  },
  { pattern: /camera|kTCCServiceCamera/i, permission: "camera" },
  { pattern: /microphone|audio input|kTCCServiceMicrophone/i, permission: "microphone" },
];

/**
 * Detect if exec output contains macOS TCC permission errors.
 * Returns null if no permission error detected, or a hint string to append.
 */
export function detectTccError(output: string, exitCode: number | null): string | null {
  if (process.platform !== "darwin") {
    return null;
  }
  if (!output) {
    return null;
  }
  // Only check failed commands (non-zero exit or signal kill)
  if (exitCode === 0) {
    return null;
  }

  const matched = TCC_ERROR_PATTERNS.some((p) => p.test(output));
  if (!matched) {
    return null;
  }

  // Try to identify which permission
  const permissions: string[] = [];
  for (const { pattern, permission } of PERMISSION_HINTS) {
    if (pattern.test(output) && !permissions.includes(permission)) {
      permissions.push(permission);
    }
  }

  const permHint = permissions.length > 0 ? `Likely missing: ${permissions.join(", ")}\n` : "";

  return (
    `\n\n⚠️ macOS permission error detected.\n` +
    permHint +
    `Run: bash <permctl_skill_dir>/permctl.sh status\n` +
    `Then: bash <permctl_skill_dir>/permctl.sh request ${permissions[0] || "<permission>"}`
  );
}
