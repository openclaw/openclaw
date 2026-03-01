import type { AcpSessionUpdateTag } from "../acp/runtime/types.js";

export type AcpDispatchConfig = {
  /** Master switch for ACP turn dispatch in the reply pipeline. */
  enabled?: boolean;
};

export type AcpStreamConfig = {
  /** Coalescer idle flush window in milliseconds for ACP streamed text. */
  coalesceIdleMs?: number;
  /** Maximum text size per streamed chunk. */
  maxChunkChars?: number;
  /** Suppresses repeated ACP status/tool projection lines within a turn. */
  repeatSuppression?: boolean;
  /** Live streams chunks or waits for terminal event before delivery. */
  deliveryMode?: "live" | "final_only";
  /** Maximum assistant text characters forwarded per turn. */
  maxTurnChars?: number;
  /** Maximum visible characters for tool summary/meta lines. */
  maxToolSummaryChars?: number;
  /** Maximum visible characters for status lines. */
  maxStatusChars?: number;
  /** Maximum number of meta events projected per turn. */
  maxMetaEventsPerTurn?: number;
  /**
   * Per-sessionUpdate visibility overrides.
   * Keys not listed here fall back to OpenClaw defaults.
   */
  tagVisibility?: Partial<Record<AcpSessionUpdateTag, boolean>>;
};

export type AcpRuntimeConfig = {
  /** Idle runtime TTL in minutes for ACP session workers. */
  ttlMinutes?: number;
  /** Optional operator install/setup command shown by `/acp install` and `/acp doctor`. */
  installCommand?: string;
};

export type AcpConfig = {
  /** Global ACP runtime gate. */
  enabled?: boolean;
  dispatch?: AcpDispatchConfig;
  /** Backend id registered by ACP runtime plugin (for example: acpx). */
  backend?: string;
  defaultAgent?: string;
  allowedAgents?: string[];
  maxConcurrentSessions?: number;
  stream?: AcpStreamConfig;
  runtime?: AcpRuntimeConfig;
};
