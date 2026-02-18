/**
 * Recovery handler for TUI - detects and displays recovery suggestions from failed runs
 */

export type RecoverySuggestion = {
  action: 'retry' | 'switch' | 'fail';
  newModel?: string;
  reason?: string;
  attempt?: number;
};

export type RecoveryMessageMeta = {
  recoverySuggestion?: RecoverySuggestion;
  [key: string]: unknown;
};

/**
 * Extract recovery suggestion from a message object
 */
export function extractRecoverySuggestion(
  message: unknown
): RecoverySuggestion | null {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return null;
  }

  const msg = message as Record<string, unknown>;
  const meta = msg.meta as RecoveryMessageMeta | undefined;

  if (!meta?.recoverySuggestion) {
    return null;
  }

  return meta.recoverySuggestion;
}

/**
 * Format recovery suggestion as a human-readable system message
 */
export function formatRecoverySuggestion(
  suggestion: RecoverySuggestion
): string {
  const lines: string[] = [];

  lines.push('🔄 Recoverable Error Detected');
  lines.push('');

  if (suggestion.reason) {
    lines.push(`Reason: ${suggestion.reason}`);
    lines.push('');
  }

  lines.push('Available actions:');

  if (suggestion.action === 'retry') {
    lines.push('  • Retry with the same model');
    if (suggestion.newModel) {
      lines.push(`  • Switch to: ${suggestion.newModel}`);
    }
  } else if (suggestion.action === 'switch' && suggestion.newModel) {
    lines.push(`  • Recommended: Switch to ${suggestion.newModel}`);
    lines.push('  • Or retry with the same model');
  }

  lines.push('  • Abort (keep error visible)');
  lines.push('');
  lines.push('To retry manually, use:');
  lines.push('  /retry          (same model)');
  
  if (suggestion.newModel) {
    lines.push(`  /retry model=${suggestion.newModel}  (switch model)`);
  }

  if (suggestion.attempt !== undefined && suggestion.attempt > 0) {
    lines.push('');
    lines.push(`Recovery attempt: ${suggestion.attempt + 1}`);
  }

  return lines.join('\n');
}

/**
 * Check if we should display a recovery suggestion
 * (avoid showing after too many attempts)
 */
export function shouldDisplayRecoverySuggestion(
  suggestion: RecoverySuggestion,
  maxAttempts: number = 3
): boolean {
  if (suggestion.action === 'fail') {
    return false; // Plugin explicitly said to fail
  }

  const attempt = suggestion.attempt ?? 0;
  return attempt < maxAttempts;
}
