/**
 * Heimdall Output Filter — Apply redaction to reply payloads.
 *
 * Used at two points:
 * 1. Batch: before final payload delivery in agent-runner
 * 2. Streaming: wrapping onBlockReply callback
 */

import type { HeimdallConfig } from "./types.js";
import { getHeimdallAuditLogger } from "./audit.js";
import { redactOutput } from "./output-filter.js";

export interface FilterablePayload {
  text?: string;
  [key: string]: unknown;
}

/**
 * Apply output filter to an array of reply payloads.
 * Only text payloads are redacted; media-only payloads pass through.
 */
export function applyOutputFilter<T extends FilterablePayload>(
  payloads: T[],
  config?: HeimdallConfig,
): T[] {
  if (!config?.enabled || config.outputFilter?.enabled === false) {
    return payloads;
  }

  const auditLogger = getHeimdallAuditLogger(config.audit);

  return payloads.map((payload) => {
    if (!payload.text) {
      return payload;
    }

    const { redacted, matches } = redactOutput(payload.text, config.outputFilter);

    if (matches.length > 0) {
      auditLogger.logRedaction({
        patterns: matches.map((m) => m.pattern),
        totalMatches: matches.reduce((sum, m) => sum + m.count, 0),
      });
    }

    if (redacted === payload.text) {
      return payload;
    }
    return { ...payload, text: redacted };
  });
}
