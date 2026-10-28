import type { ChannelGatewayContextV2 } from "../channels/plugins/types.adapters.js";
import type { AnyChannelPlugin as ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { ChannelId, ChannelAccountSnapshot } from "../channels/plugins/types.public.js";
import type { PluginRuntimeCapabilityLease } from "../plugins/capability-lease.js";
import type { PluginServiceSchedulerV1 } from "../plugins/service-scheduler.types.js";

export type ChannelAccountLifetime = {
  plugin: ChannelPlugin;
  abort: AbortController;
  capabilityLease: PluginRuntimeCapabilityLease;
  scheduler: PluginServiceSchedulerV1;
  teardown?: {
    context: Omit<ChannelGatewayContextV2, "setStatus">;
    run: (context: ChannelGatewayContextV2) => Promise<void>;
  };
};

export type ChannelAccountStopOutcome =
  | { status: "fulfilled" }
  | { status: "rejected"; error: unknown };

export type StopChannelOptions = {
  manual?: boolean;
  routeHandoff?: boolean;
  /** Report unfinished cleanup to the caller after the bounded stop attempt. */
  strict?: boolean;
};

export type ChannelAccountStopState = (
  | { status: "stopping"; attempt: Promise<ChannelAccountStopOutcome>; settled: boolean }
  | Extract<ChannelAccountStopOutcome, { status: "rejected" }>
) & {
  cleanup?: Promise<ChannelAccountStopOutcome>;
};

export type ChannelRuntimeSnapshotOptions = {
  channelId?: ChannelId;
  /** Controls read recorded state without invoking fallible diagnostic inspectors. */
  inspectAccounts?: boolean;
};

export type ChannelRuntimeSnapshot = {
  /** Host admission is paused; status must use captured facts without invoking plugin callbacks. */
  reloadingChannels?: ReadonlyMap<ChannelId, string | undefined>;
  channels: Partial<Record<ChannelId, ChannelAccountSnapshot>>;
  channelAccounts: Partial<Record<ChannelId, Record<string, ChannelAccountSnapshot>>>;
};

/** The lifecycle owner's decision for one requested account start, separate from connectivity. */
export type ChannelAccountStartOutcome =
  | { status: "handed-off" }
  | { status: "retry"; reason: "stop-in-flight" | "task-owned" }
  | {
      status: "skipped";
      reason:
        | "unsupported"
        | "autostart-suppressed"
        | "ambient-suppressed"
        | "disabled"
        | "unconfigured"
        | "secret-unavailable"
        | "unlinked"
        | "manual-stop";
    };

export type StartChannelOptions = {
  /** Lifecycle trigger, recorded once when an account is handed to its plugin. */
  reason?:
    | "startup"
    | "autostart-recovery"
    | "auto-restart"
    | "stop-recovery"
    | "health-monitor"
    | "config-reload"
    | "plugin-reload"
    | "secrets-reload"
    | "host-thaw";
  preserveRestartAttempts?: boolean;
  preserveManualStop?: boolean;
  /** Reload leaves snapshot-cold accounts stopped without bypassing credential-file reinspection. */
  skipUnavailableAccounts?: boolean;
  deferAccountStartUntil?: Promise<void>;
  manual?: boolean;
};

export type ChannelAccountLifecycle = {
  startChannel: (
    channel: ChannelId,
    accountId?: string,
    opts?: StartChannelOptions,
  ) => Promise<ReadonlyMap<string, ChannelAccountStartOutcome>>;
  stopChannel: (channel: ChannelId, accountId?: string, opts?: StopChannelOptions) => Promise<void>;
  captureAccountRestart: (
    channel: ChannelId,
    accountId: string,
    reason: StartChannelOptions["reason"],
    options?: { resetRestartAttempts?: boolean },
  ) => ((shouldContinue: () => boolean) => Promise<boolean>) | undefined;
  resetRestartAttempts: (channelId: ChannelId, accountId: string) => void;
  isManuallyStopped: (channelId: ChannelId, accountId: string) => boolean;
  isAccountListed: (channelId: ChannelId, accountId: string) => boolean;
};
