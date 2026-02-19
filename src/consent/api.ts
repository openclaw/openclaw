/**
 * ConsentGate internal API and no-op adapter.
 * When ConsentGate is disabled or not configured, the no-op adapter returns allow and does not write WAL.
 */

import type {
  ConsentConsumeInput,
  ConsentConsumeResult,
  ConsentIssueInput,
  ConsentRevokeInput,
  ConsentStatusQuery,
  ConsentStatusSnapshot,
  ConsentToken,
} from "./types.js";

/** Consent decision engine + token store + WAL interface. */
export type ConsentGateApi = {
  issue(input: ConsentIssueInput): Promise<ConsentToken | null>;
  /** Evaluate only: compute allow/deny and write WAL without consuming (observe-only mode). */
  evaluate(input: ConsentConsumeInput): Promise<ConsentConsumeResult>;
  consume(input: ConsentConsumeInput): Promise<ConsentConsumeResult>;
  revoke(input: ConsentRevokeInput): Promise<{ revoked: number }>;
  bulkRevoke(input: ConsentRevokeInput): Promise<{ revoked: number }>;
  status(query: ConsentStatusQuery): Promise<ConsentStatusSnapshot>;
};

/**
 * No-op adapter: always allows, does not persist tokens or WAL.
 * Use when ConsentGate is disabled or for tests.
 */
export function createNoOpConsentGateApi(): ConsentGateApi {
  return {
    async issue(): Promise<ConsentToken | null> {
      return null;
    },
    async evaluate(): Promise<ConsentConsumeResult> {
      return { allowed: true };
    },
    async consume(): Promise<ConsentConsumeResult> {
      return { allowed: true };
    },
    async revoke(): Promise<{ revoked: number }> {
      return { revoked: 0 };
    },
    async bulkRevoke(): Promise<{ revoked: number }> {
      return { revoked: 0 };
    },
    async status(): Promise<ConsentStatusSnapshot> {
      return { tokens: [], recentEvents: [] };
    },
  };
}
