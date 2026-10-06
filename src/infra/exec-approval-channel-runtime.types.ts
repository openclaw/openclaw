import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  ApprovalRequestInput,
  ApprovalResolved as ApprovalResolvedEvent,
  ChannelApprovalKind,
  NormalizedApprovalRequest,
} from "./approval-types.js";
import type { ExecApprovalRequest, ExecApprovalResolved } from "./exec-approvals.js";

export type ExecApprovalChannelRuntimeAdapter<
  TPending,
  TRequest extends ApprovalRequestInput = ExecApprovalRequest,
  TResolved extends ApprovalResolvedEvent = ExecApprovalResolved,
> = {
  label: string;
  clientDisplayName: string;
  cfg: OpenClawConfig;
  gatewayUrl?: string;
  /** Defaults to exec-only; include plugin when the adapter can handle plugin approvals. */
  eventKinds?: readonly ChannelApprovalKind[];
  isConfigured: () => boolean;
  shouldHandle: (request: NormalizedApprovalRequest<TRequest>) => boolean;
  deliverRequested: (request: NormalizedApprovalRequest<TRequest>) => Promise<TPending[]>;
  beforeGatewayClientStart?: () => Promise<void> | void;
  finalizeResolved: (params: {
    request: NormalizedApprovalRequest<TRequest>;
    resolved: TResolved;
    entries: TPending[];
  }) => Promise<void>;
  finalizeExpired?: (params: {
    request: NormalizedApprovalRequest<TRequest>;
    entries: TPending[];
  }) => Promise<void>;
  onStopped?: () => Promise<void> | void;
  nowMs?: () => number;
};

export type ExecApprovalChannelRuntime<
  TRequest extends ApprovalRequestInput = ExecApprovalRequest,
  TResolved extends ApprovalResolvedEvent = ExecApprovalResolved,
> = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  handleRequested: (request: TRequest) => Promise<void>;
  handleResolved: (resolved: TResolved) => Promise<void>;
  handleExpired: (approvalId: string) => Promise<void>;
  request: <T = unknown>(method: string, params: Record<string, unknown>) => Promise<T>;
};
