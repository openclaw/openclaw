import type { ChannelId, ChannelAccountSnapshot } from "../channels/plugins/types.public.js";

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
