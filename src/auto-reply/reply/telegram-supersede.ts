import type { OpenClawConfig } from "../../config/config.js";
import type { QueueSettings } from "./queue/types.js";

type TelegramSupersedePolicy = "latest-wins" | "burst-coalesce";

type TelegramSupersedeResolved = {
  enabled: boolean;
  policy: TelegramSupersedePolicy;
  graceMs: number;
};

function resolveTelegramSupersedeConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): TelegramSupersedeResolved {
  const accountId = params.accountId?.trim();
  const telegram = params.cfg.channels?.telegram;
  const account = accountId ? telegram?.accounts?.[accountId] : undefined;
  const supersede = account?.supersede ?? telegram?.supersede;
  return {
    enabled: supersede?.enabled === true,
    policy: supersede?.policy === "burst-coalesce" ? "burst-coalesce" : "latest-wins",
    graceMs:
      typeof supersede?.graceMs === "number" && Number.isFinite(supersede.graceMs)
        ? Math.max(0, Math.floor(supersede.graceMs))
        : 0,
  };
}

export function resolveTelegramSupersedeQueueOverride(params: {
  cfg: OpenClawConfig;
  channel?: string;
  accountId?: string;
}): {
  inlineMode?: QueueSettings["mode"];
  inlineOptions?: Partial<QueueSettings>;
} {
  if (params.channel?.trim().toLowerCase() !== "telegram") {
    return {};
  }
  const supersede = resolveTelegramSupersedeConfig({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  if (!supersede.enabled) {
    return {};
  }
  if (supersede.policy === "burst-coalesce") {
    return {
      inlineMode: "interrupt",
      inlineOptions: {
        // Keep only the freshest queued follow-up when bursts race with cancellation.
        cap: 1,
        dropPolicy: "old",
        debounceMs: supersede.graceMs,
      },
    };
  }
  return {
    inlineMode: "interrupt",
    inlineOptions: {
      debounceMs: supersede.graceMs,
    },
  };
}

export function resolveTelegramSupersedeDebounceMs(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): number {
  const supersede = resolveTelegramSupersedeConfig(params);
  if (!supersede.enabled || supersede.policy !== "burst-coalesce") {
    return 0;
  }
  return supersede.graceMs;
}
