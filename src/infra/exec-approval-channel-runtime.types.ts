import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ExecApprovalRequest, ExecApprovalResolved } from "./exec-approvals.js";
import type { PluginApprovalRequest, PluginApprovalResolved } from "./plugin-approvals.js";

type ApprovalRequestEvent = ExecApprovalRequest | PluginApprovalRequest;
type ApprovalResolvedEvent = ExecApprovalResolved | PluginApprovalResolved;

/** Approval event families a native channel runtime subscribes to and replays. */
export type ExecApprovalChannelRuntimeEventKind = "exec" | "plugin";

/** Channel-specific hooks used by the shared approval gateway runtime. */
export type ExecApprovalChannelRuntimeAdapter<
  TPending,
  TRequest extends ApprovalRequestEvent = ExecApprovalRequest,
  TResolved extends ApprovalResolvedEvent = ExecApprovalResolved,
> = {
  /** Logger/subsystem label used in runtime errors and diagnostics. */
  label: string;
  /** Human-readable client name sent to the gateway for connection identity. */
  clientDisplayName: string;
  /** Runtime config used for gateway connection and channel-specific hooks. */
  cfg: OpenClawConfig;
  /** Optional gateway URL override for tests or alternate runtime hosts. */
  gatewayUrl?: string;
  /** Approval event families this runtime subscribes to; defaults to exec approvals. */
  eventKinds?: readonly ExecApprovalChannelRuntimeEventKind[];
  /** Return false to keep the runtime disabled without opening a gateway connection. */
  isConfigured: () => boolean;
  /** Per-request filter that decides whether this channel runtime owns delivery. */
  shouldHandle: (request: TRequest) => boolean;
  /** Deliver the approval request and return pending entries used for later cleanup/finalization. */
  deliverRequested: (request: TRequest) => Promise<TPending[]>;
  /** Hook that runs after gateway client creation but before the client starts. */
  beforeGatewayClientStart?: () => Promise<void> | void;
  /** Finalize pending channel entries after the approval resolves. */
  finalizeResolved: (params: {
    request: TRequest;
    resolved: TResolved;
    entries: TPending[];
  }) => Promise<void>;
  /** Finalize pending channel entries when the approval expires without a resolution. */
  finalizeExpired?: (params: { request: TRequest; entries: TPending[] }) => Promise<void>;
  /** Hook that runs after stop, even if the runtime never fully connected. */
  onStopped?: () => Promise<void> | void;
  /** Clock injection used for expiration timers and tests. */
  nowMs?: () => number;
};

/** Gateway-backed native approval runtime exposed to channel adapters. */
export type ExecApprovalChannelRuntime<
  TRequest extends ApprovalRequestEvent = ExecApprovalRequest,
  TResolved extends ApprovalResolvedEvent = ExecApprovalResolved,
> = {
  /** Start the gateway client, await initial readiness, then replay pending approvals. */
  start: () => Promise<void>;
  /** Stop the gateway client, clear pending timers, and run adapter stop cleanup. */
  stop: () => Promise<void>;
  /** Handle a requested approval directly, used by gateway events and tests. */
  handleRequested: (request: TRequest) => Promise<void>;
  /** Handle a resolved approval directly, used by gateway events and tests. */
  handleResolved: (resolved: TResolved) => Promise<void>;
  /** Expire one pending approval by id and run expiration finalization. */
  handleExpired: (approvalId: string) => Promise<void>;
  /** Send an arbitrary request through the connected gateway client. */
  request: <T = unknown>(method: string, params: Record<string, unknown>) => Promise<T>;
};
