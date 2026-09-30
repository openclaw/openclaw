import type { AgentMessage } from "../../packages/agent-core/src/types.js";
import type { DiagnosticTraceContext } from "../infra/diagnostic-trace-context.js";
import type { PluginJsonValue } from "./host-hook-json.js";

export type PluginHookToolKind = "code_mode_exec";
export type PluginHookToolInputKind = "javascript" | "typescript";

/** Host-derived identity for the message requester that initiated a tool call. */
export type PluginHookToolRequesterContext = {
  /** Channel/plugin id, for example `discord` or `telegram`. */
  readonly channel?: string;
  /** Channel account used by the agent when multiple accounts are configured. */
  readonly accountId?: string;
  /** Channel-scoped sender id when the host received one. */
  readonly senderId?: string;
  /** True only when the host resolved the sender as an owner. */
  readonly senderIsOwner?: boolean;
  /** Provider-native role ids when the channel supplies them. */
  readonly roleIds?: readonly string[];
};

export type PluginHookToolContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  /** Aborts when the owning tool call is cancelled. Hook timeout expiry does not abort this signal. */
  abortSignal?: AbortSignal;
  trace?: DiagnosticTraceContext;
  toolName: string;
  /** Host-authoritative discriminator for tools that intentionally share names. */
  toolKind?: PluginHookToolKind;
  /** Host-authoritative input/runtime family for tools whose payloads need policy distinction. */
  toolInputKind?: PluginHookToolInputKind;
  toolCallId?: string;
  getSessionExtension?: (namespace: string) => PluginJsonValue | undefined;
  channelId?: string;
  /**
   * Message requester for this turn. Absent for non-message runs and harnesses
   * that cannot prove requester identity. Authorization hooks should fail
   * closed when a required field is absent.
   */
  requester?: PluginHookToolRequesterContext;
};

export type PluginHookBeforeToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
  /** Host-authoritative discriminator for tools that intentionally share names. */
  toolKind?: PluginHookToolKind;
  /** Host-authoritative input/runtime family for tools whose payloads need policy distinction. */
  toolInputKind?: PluginHookToolInputKind;
  runId?: string;
  toolCallId?: string;
  /**
   * Optional best-effort destination path hints the host derived from `params`
   * for well-known tool envelopes (e.g. `apply_patch`).
   *
   * This is a convenience hint, not an authoritative parse result: the host's
   * extractor may be intentionally lenient and can return paths for malformed
   * or partial envelopes. Plugins may use `derivedPaths` as a fast path, but
   * should parse and validate `params` themselves when correctness or policy
   * decisions depend on the exact set of affected paths. Absent for tools the
   * host does not know how to derive paths for.
   */
  derivedPaths?: readonly string[];
};

export type PluginHookAfterToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
  result?: unknown;
  error?: string;
  durationMs?: number;
};

export type PluginHookToolResultPersistContext = {
  agentId?: string;
  sessionKey?: string;
  toolName?: string;
  toolCallId?: string;
};

export type PluginHookToolResultPersistEvent = {
  toolName?: string;
  toolCallId?: string;
  message: AgentMessage;
  isSynthetic?: boolean;
};

export type PluginHookToolResultPersistResult = {
  message?: AgentMessage;
};
