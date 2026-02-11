/**
 * Heimdall Streaming Filter — wraps onBlockReply to redact secrets.
 *
 * For streaming, we apply redaction on each chunk's text.
 * Conservative approach: redact each chunk independently.
 * This may miss cross-chunk secrets but avoids buffering complexity.
 */

import type { HeimdallConfig } from "./types.js";
import { getHeimdallAuditLogger } from "./audit.js";
import { redactOutput } from "./output-filter.js";

export interface StreamingPayload {
  text?: string;
  [key: string]: unknown;
}

type BlockReplyFn<T, C> = (payload: T, context?: C) => Promise<void> | void;

/**
 * Wraps an onBlockReply callback to apply output redaction before delivery.
 * Returns the original callback unchanged when Heimdall is disabled.
 */
export function wrapBlockReplyWithFilter<T extends StreamingPayload, C = unknown>(
  onBlockReply: BlockReplyFn<T, C>,
  config?: HeimdallConfig,
): BlockReplyFn<T, C> {
  if (!config?.enabled || config.outputFilter?.enabled === false) {
    return onBlockReply;
  }

  const auditLogger = getHeimdallAuditLogger(config.audit);

  return (payload: T, context?: C) => {
    if (!payload.text) {
      return onBlockReply(payload, context);
    }

    const { redacted, matches } = redactOutput(payload.text, config.outputFilter);

    if (matches.length > 0) {
      auditLogger.logRedaction({
        patterns: matches.map((m) => m.pattern),
        totalMatches: matches.reduce((sum, m) => sum + m.count, 0),
      });
    }

    if (redacted === payload.text) {
      return onBlockReply(payload, context);
    }

    return onBlockReply({ ...payload, text: redacted }, context);
  };
}
