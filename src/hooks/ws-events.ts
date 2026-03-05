import { type OpenClawConfig, DEFAULT_GATEWAY_PORT, resolveGatewayPort } from "../config/config.js";
import { normalizeHooksPath } from "./gmail.js";

export const DEFAULT_WS_EVENTS_POLL_INTERVAL = 5;
export const DEFAULT_WS_EVENTS_MAX_MESSAGES = 10;

export type WsEventsHookRuntimeConfig = {
  project: string;
  target: string;
  eventTypes: string[];
  subscription?: string;
  hookToken: string;
  hookUrl: string;
  pollInterval: number;
  maxMessages: number;
  cleanup: boolean;
};

export type WsEventsHookOverrides = {
  project?: string;
  target?: string;
  eventTypes?: string[];
  subscription?: string;
  hookToken?: string;
  hookUrl?: string;
  pollInterval?: number;
  maxMessages?: number;
  cleanup?: boolean;
};

export function buildDefaultWsEventsHookUrl(
  hooksPath?: string,
  port: number = DEFAULT_GATEWAY_PORT,
): string {
  const basePath = normalizeHooksPath(hooksPath);
  return `http://127.0.0.1:${port}${basePath}/workspace-events`;
}

export function resolveWsEventsHookRuntimeConfig(
  cfg: OpenClawConfig,
  overrides: WsEventsHookOverrides,
): { ok: true; value: WsEventsHookRuntimeConfig } | { ok: false; error: string } {
  const hooks = cfg.hooks;
  const wsEvents = hooks?.workspaceEvents;

  const hookToken = overrides.hookToken ?? hooks?.token ?? "";
  if (!hookToken) {
    return { ok: false, error: "hooks.token missing (needed for workspace events hook)" };
  }

  const project = overrides.project ?? wsEvents?.project ?? "";
  if (!project) {
    return { ok: false, error: "workspace events project required" };
  }

  const target = overrides.target ?? wsEvents?.target ?? "";
  if (!target) {
    return { ok: false, error: "workspace events target required" };
  }

  const eventTypes = overrides.eventTypes ?? wsEvents?.eventTypes ?? [];
  if (eventTypes.length === 0) {
    return { ok: false, error: "workspace events eventTypes required (at least one)" };
  }

  const subscription = overrides.subscription ?? wsEvents?.subscription;

  const hookUrl =
    overrides.hookUrl ??
    wsEvents?.hookUrl ??
    buildDefaultWsEventsHookUrl(hooks?.path, resolveGatewayPort(cfg));

  const pollIntervalRaw = overrides.pollInterval ?? wsEvents?.pollInterval;
  const pollInterval =
    typeof pollIntervalRaw === "number" && Number.isFinite(pollIntervalRaw) && pollIntervalRaw > 0
      ? Math.floor(pollIntervalRaw)
      : DEFAULT_WS_EVENTS_POLL_INTERVAL;

  const maxMessagesRaw = overrides.maxMessages ?? wsEvents?.maxMessages;
  const maxMessages =
    typeof maxMessagesRaw === "number" && Number.isFinite(maxMessagesRaw) && maxMessagesRaw > 0
      ? Math.floor(maxMessagesRaw)
      : DEFAULT_WS_EVENTS_MAX_MESSAGES;

  const cleanup = overrides.cleanup ?? wsEvents?.cleanup ?? false;

  return {
    ok: true,
    value: {
      project,
      target,
      eventTypes,
      subscription,
      hookToken,
      hookUrl,
      pollInterval,
      maxMessages,
      cleanup,
    },
  };
}

export function buildGwsEventsSubscribeArgs(
  cfg: Pick<
    WsEventsHookRuntimeConfig,
    | "target"
    | "eventTypes"
    | "project"
    | "subscription"
    | "pollInterval"
    | "maxMessages"
    | "cleanup"
  >,
): string[] {
  const args = ["events", "+subscribe", "--target", cfg.target];

  args.push("--event-types", cfg.eventTypes.join(","));
  args.push("--project", cfg.project);

  if (cfg.subscription) {
    args.push("--subscription", cfg.subscription);
  }
  if (cfg.pollInterval !== DEFAULT_WS_EVENTS_POLL_INTERVAL) {
    args.push("--poll-interval", String(cfg.pollInterval));
  }
  if (cfg.maxMessages !== DEFAULT_WS_EVENTS_MAX_MESSAGES) {
    args.push("--max-messages", String(cfg.maxMessages));
  }
  if (cfg.cleanup) {
    args.push("--cleanup");
  }

  return args;
}
