import { callGatewayScoped } from "./call.js";
import { READ_SCOPE } from "./method-scopes.js";
import { PROTOCOL_VERSION, type ToolsCatalogResult } from "./protocol/index.js";
import { loadConfig, type OpenClawConfig } from "../config/config.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../utils/message-channel.js";
import type { CronJob } from "../cron/types.js";
import type { CronListPageResult } from "../cron/service/list-page-types.js";
import type { GatewaySessionRow, SessionsListResult } from "./session-utils.types.js";

export type FetchHomeDashboardOptions = {
  agentId?: string;
  url?: string;
  timeoutMs?: number;
  token?: string;
  password?: string;
  configPath?: string;
};

export type HomeDashboardSectionStatus = "ready" | "empty" | "unavailable";

export type HomeDashboardActivityItem = {
  id: string;
  label: string;
  kind: string;
  channel: string | null;
  updatedAt: string | null;
  lastMessagePreview: string | null;
};

export type HomeDashboardScheduledItem = {
  id: string;
  name: string;
  mode: string;
  enabled: boolean;
  nextRunAt: string | null;
  updatedAt: string | null;
};

export type HomeDashboardSuggestedTool = {
  id: string;
  label: string;
  description: string;
  source: "core" | "plugin";
  pluginId: string | null;
  defaultProfiles: string[];
};

export type HomeDashboardSection<TItem> = {
  status: HomeDashboardSectionStatus;
  warning: string | null;
  items: TItem[];
};

export type HomeDashboardSnapshot = {
  agentId: string;
  gatewayUrl: string;
  source: string;
  activity: HomeDashboardSection<HomeDashboardActivityItem>;
  scheduled: HomeDashboardSection<HomeDashboardScheduledItem>;
  suggestedTools: HomeDashboardSection<HomeDashboardSuggestedTool>;
};

const DEFAULT_AGENT_ID = "jarvis-desktop";
const DEFAULT_ACTIVITY_LIMIT = 6;
const DEFAULT_SCHEDULED_LIMIT = 6;
const CURATED_SUGGESTED_TOOL_IDS = [
  "memory_search",
  "sessions_list",
  "session_status",
  "cron",
  "message",
] as const;

function trimToUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function resolveGatewayTarget(url: string | undefined) {
  const config = loadConfig();
  const normalizedUrl = trimToUndefined(url);

  if (!normalizedUrl) {
    return {
      config,
      url: undefined,
      gatewayUrl: `ws${Boolean(config.gateway?.tls?.enabled) ? "s" : ""}://127.0.0.1:${
        config.gateway?.port ?? 19001
      }`,
    };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(normalizedUrl);
  } catch {
    return {
      config,
      url: normalizedUrl,
      gatewayUrl: normalizedUrl,
    };
  }

  if (
    (parsedUrl.protocol === "ws:" || parsedUrl.protocol === "wss:") &&
    isLoopbackHostname(parsedUrl.hostname)
  ) {
    const resolvedPort = Number.parseInt(parsedUrl.port, 10);
    const port = Number.isFinite(resolvedPort)
      ? resolvedPort
      : parsedUrl.protocol === "wss:"
        ? 443
        : 80;

    const localConfig: OpenClawConfig = {
        ...config,
        gateway: {
          ...config.gateway,
          mode: "local",
          port,
          tls: {
            ...config.gateway?.tls,
            enabled: parsedUrl.protocol === "wss:",
          },
        },
      };

    return {
      config: localConfig,
      url: undefined,
      gatewayUrl: normalizedUrl,
    };
  }

  return {
    config,
    url: normalizedUrl,
    gatewayUrl: normalizedUrl,
  };
}

function getStructuredErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }

  const code = Reflect.get(error, "code");
  return typeof code === "string" && code.trim() ? code.trim() : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isFatalGatewayError(error: unknown): boolean {
  const code = getStructuredErrorCode(error);
  if (
    code === "auth_failed" ||
    code === "gateway_unavailable" ||
    code === "timeout" ||
    code === "command_unavailable"
  ) {
    return true;
  }

  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes("gateway") ||
    message.includes("websocket") ||
    message.includes("econnrefused") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("auth") ||
    message.includes("401") ||
    message.includes("403") ||
    message.includes("operator.read")
  );
}

function toIsoString(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return new Date(value).toISOString();
}

function normalizeToolId(value: string): string {
  return value.trim().toLowerCase().replace(/[.\s-]+/g, "_");
}

function createSection<TItem>(items: TItem[]): HomeDashboardSection<TItem> {
  return {
    status: items.length > 0 ? "ready" : "empty",
    warning: null,
    items,
  };
}

function createUnavailableSection<TItem>(warning: string): HomeDashboardSection<TItem> {
  return {
    status: "unavailable",
    warning,
    items: [],
  };
}

async function callReadOnlyGateway<TPayload>(params: {
  method: string;
  payload?: Record<string, unknown>;
  options: FetchHomeDashboardOptions;
}) {
  const gatewayTarget = resolveGatewayTarget(params.options.url);

  return await callGatewayScoped<TPayload>({
    method: params.method,
    params: params.payload,
    scopes: [READ_SCOPE],
    config: gatewayTarget.config,
    url: gatewayTarget.url,
    timeoutMs: params.options.timeoutMs,
    token: trimToUndefined(params.options.token),
    password: trimToUndefined(params.options.password),
    configPath: trimToUndefined(params.options.configPath),
    clientName: GATEWAY_CLIENT_NAMES.CLI,
    clientDisplayName: "Jarvis Desktop",
    clientVersion: "dev",
    platform: process.platform,
    mode: GATEWAY_CLIENT_MODES.CLI,
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
  });
}

async function fetchSessionsList(
  agentId: string,
  options: FetchHomeDashboardOptions,
): Promise<SessionsListResult> {
  return await callReadOnlyGateway({
    method: "sessions.list",
    payload: {
      agentId,
      limit: DEFAULT_ACTIVITY_LIMIT,
      includeDerivedTitles: true,
      includeLastMessage: true,
    },
    options,
  });
}

async function fetchCronList(
  options: FetchHomeDashboardOptions,
): Promise<CronListPageResult<CronJob[]>> {
  return await callReadOnlyGateway({
    method: "cron.list",
    payload: {
      enabled: "enabled",
      limit: DEFAULT_SCHEDULED_LIMIT,
      sortBy: "nextRunAtMs",
      sortDir: "asc",
    },
    options,
  });
}

async function fetchCatalog(
  agentId: string,
  options: FetchHomeDashboardOptions,
): Promise<ToolsCatalogResult> {
  return await callReadOnlyGateway<ToolsCatalogResult>({
    method: "tools.catalog",
    payload: {
      agentId,
      includePlugins: true,
    },
    options,
  });
}

function normalizeActivityItem(entry: GatewaySessionRow): HomeDashboardActivityItem {
  return {
    id: trimToUndefined(entry.sessionId) ?? entry.key,
    label:
      trimToUndefined(entry.derivedTitle) ??
      trimToUndefined(entry.displayName) ??
      trimToUndefined(entry.label) ??
      entry.key,
    kind: trimToUndefined(entry.kind) ?? "unknown",
    channel:
      trimToUndefined(entry.channel) ??
      trimToUndefined(entry.lastChannel) ??
      trimToUndefined(entry.deliveryContext?.channel) ??
      null,
    updatedAt: toIsoString(entry.updatedAt),
    lastMessagePreview: trimToUndefined(entry.lastMessagePreview) ?? null,
  };
}

function normalizeScheduledItem(job: Record<string, unknown>): HomeDashboardScheduledItem {
  const schedule =
    job.schedule && typeof job.schedule === "object" && !Array.isArray(job.schedule)
      ? (job.schedule as Record<string, unknown>)
      : {};
  const state =
    job.state && typeof job.state === "object" && !Array.isArray(job.state)
      ? (job.state as Record<string, unknown>)
      : {};

  return {
    id: trimToUndefined(job.id) ?? "unknown-job",
    name: trimToUndefined(job.name) ?? "Unnamed job",
    mode: trimToUndefined(schedule.kind) ?? "unknown",
    enabled: Boolean(job.enabled),
    nextRunAt:
      typeof state.nextRunAtMs === "number" ? toIsoString(state.nextRunAtMs) : null,
    updatedAt:
      typeof job.updatedAtMs === "number" ? toIsoString(job.updatedAtMs) : null,
  };
}

function collectSuggestedTools(catalog: ToolsCatalogResult): HomeDashboardSuggestedTool[] {
  const toolByCuratedId = new Map<string, HomeDashboardSuggestedTool>();

  for (const group of catalog.groups ?? []) {
    for (const tool of group.tools ?? []) {
      const normalizedId = normalizeToolId(tool.id);

      if (!CURATED_SUGGESTED_TOOL_IDS.includes(normalizedId as (typeof CURATED_SUGGESTED_TOOL_IDS)[number])) {
        continue;
      }

      if (toolByCuratedId.has(normalizedId)) {
        continue;
      }

      toolByCuratedId.set(normalizedId, {
        id: tool.id,
        label: tool.label,
        description: trimToUndefined(tool.description) ?? "",
        source: tool.source,
        pluginId: trimToUndefined(tool.pluginId) ?? null,
        defaultProfiles: Array.isArray(tool.defaultProfiles)
          ? tool.defaultProfiles
              .map((profileId) => trimToUndefined(profileId))
              .filter((profileId): profileId is string => Boolean(profileId))
          : [],
      });
    }
  }

  return CURATED_SUGGESTED_TOOL_IDS.map((toolId) => toolByCuratedId.get(toolId)).filter(
    (tool): tool is HomeDashboardSuggestedTool => Boolean(tool),
  );
}

export async function fetchHomeDashboard(
  options: FetchHomeDashboardOptions = {},
): Promise<HomeDashboardSnapshot> {
  const agentId = trimToUndefined(options.agentId) ?? DEFAULT_AGENT_ID;
  const gatewayTarget = resolveGatewayTarget(options.url);
  const [activityResult, scheduledResult, catalogResult] = await Promise.allSettled([
    fetchSessionsList(agentId, options),
    fetchCronList(options),
    fetchCatalog(agentId, options),
  ]);

  const fatalError = [activityResult, scheduledResult, catalogResult]
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason)
    .find((error) => isFatalGatewayError(error));

  if (fatalError) {
    throw fatalError;
  }

  const activity =
    activityResult.status === "fulfilled"
      ? createSection((activityResult.value.sessions ?? []).map(normalizeActivityItem))
      : createUnavailableSection<HomeDashboardActivityItem>(getErrorMessage(activityResult.reason));

  const scheduled =
    scheduledResult.status === "fulfilled"
      ? createSection<HomeDashboardScheduledItem>(
          (scheduledResult.value.jobs ?? []).map((job: CronJob) =>
            normalizeScheduledItem(job as unknown as Record<string, unknown>),
          ),
        )
      : createUnavailableSection<HomeDashboardScheduledItem>(
          getErrorMessage(scheduledResult.reason),
        );

  const suggestedTools =
    catalogResult.status === "fulfilled"
      ? createSection(collectSuggestedTools(catalogResult.value))
      : createUnavailableSection<HomeDashboardSuggestedTool>(
          getErrorMessage(catalogResult.reason),
        );

  return {
    agentId,
    gatewayUrl: gatewayTarget.gatewayUrl,
    source: "openclaw-home-dashboard",
    activity,
    scheduled,
    suggestedTools,
  };
}
