import type { SessionEventTarget } from "../auto-reply/reply/session-event-contract.js";

/** Internal Hook adapter; the public Cron facade retains its existing wake contract. */
export type DeferredHookWake = (opts: {
  text: string;
  agentId: string;
  expectedTarget?: SessionEventTarget;
  createIfMissing?: true;
  commitGuard: () => void;
}) => Promise<{ ok: true; eventOutcome: "queued" | "coalesced" } | { ok: false; reason?: string }>;
