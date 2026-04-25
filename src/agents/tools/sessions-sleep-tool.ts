import { Type } from "typebox";
import { loadConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { SESSIONS_SLEEP_DESCRIPTION_PREFIX } from "../../cron/session-sleep.js";
import { assertSafeCronSessionTargetId } from "../../cron/session-target.js";
import type { CronJob } from "../../cron/types.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { optionalStringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { callGatewayTool, readGatewayCallOptions, type GatewayCallOptions } from "./gateway.js";

const DEFAULT_SLEEP_TIMEOUT_SECONDS = 900;
const MAX_SLEEP_SECONDS = 30 * 24 * 60 * 60;

const SessionsSleepToolSchema = Type.Object(
  {
    wakeAfterSeconds: Type.Number({
      description: "Seconds from now before this session should wake for the continuation turn.",
      minimum: 1,
    }),
    message: Type.String({
      description:
        "Self-contained continuation prompt for the wake turn. Keep it short and include the exact state needed to continue.",
    }),
    dedupeKey: Type.Optional(
      Type.String({
        description:
          "Stable key for the sleep being scheduled. Reusing the key refreshes the existing timer instead of creating duplicates.",
      }),
    ),
    name: Type.Optional(Type.String({ description: "Optional human-readable timer name." })),
    toolsAllow: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Optional minimal tool allow-list for the wake turn, e.g. ['browser','message','sessions_sleep'].",
      }),
    ),
    timeoutSeconds: Type.Optional(
      Type.Number({
        description:
          "Optional timeout for the wake turn. Defaults to a bounded timeout suitable for polling.",
        minimum: 0,
      }),
    ),
    thinking: Type.Optional(
      Type.String({ description: "Optional thinking level for the wake turn." }),
    ),
    lightContext: Type.Optional(
      Type.Boolean({
        description:
          "Whether to skip full workspace bootstrap context on the wake turn. Defaults to true for efficient polling.",
      }),
    ),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    onDuplicate: optionalStringEnum(["update", "add"] as const, {
      description:
        "When dedupeKey matches an existing job, update it or add another job. Default: update.",
    }),
  },
  { additionalProperties: true },
);

type GatewayToolCaller = typeof callGatewayTool;

type SessionsSleepToolDeps = {
  callGatewayTool?: GatewayToolCaller;
  nowMs?: () => number;
};

type CronListResult = {
  jobs?: unknown[];
};

function normalizeWakeAfterSeconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("wakeAfterSeconds required");
  }
  return Math.min(MAX_SLEEP_SECONDS, Math.max(1, Math.floor(value)));
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeToolsAllow(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const tools = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
  return tools.length > 0 ? tools : undefined;
}

function normalizeTimeoutSeconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_SLEEP_TIMEOUT_SECONDS;
  }
  return Math.max(0, Math.floor(value));
}

function buildSleepDescription(dedupeKey: string): string {
  return `${SESSIONS_SLEEP_DESCRIPTION_PREFIX}${dedupeKey}`;
}

function readMatchingSleepJob(jobs: unknown[], dedupeKey: string): CronJob | null {
  const description = buildSleepDescription(dedupeKey);
  for (const job of jobs) {
    if (!job || typeof job !== "object") {
      continue;
    }
    const candidate = job as Partial<CronJob>;
    if (candidate.description === description && typeof candidate.id === "string") {
      return candidate as CronJob;
    }
  }
  return null;
}

function sleepName(params: { explicitName?: string; dedupeKey?: string }): string {
  if (params.explicitName) {
    return params.explicitName;
  }
  if (params.dedupeKey) {
    return `Session sleep: ${params.dedupeKey.slice(0, 64)}`;
  }
  return "Session sleep";
}

export function createSessionsSleepTool(
  opts?: {
    agentSessionKey?: string;
    config?: OpenClawConfig;
  },
  deps?: SessionsSleepToolDeps,
): AnyAgentTool {
  const callGateway = deps?.callGatewayTool ?? callGatewayTool;
  const nowMs = deps?.nowMs ?? Date.now;
  return {
    label: "Session Sleep",
    name: "sessions_sleep",
    description:
      "Sleep this session and wake it later with a self-contained continuation prompt. Use this for efficient long-running polling instead of shell sleep or busy polling. The wake turn defaults to lightweight context and no fallback delivery; the agent must send any user-facing result itself. For Ask Pro, sleep 10 minutes after submit, then 5 minutes between checks. For Deep Research, sleep 30 minutes after submit, then 10 minutes between checks.",
    parameters: SessionsSleepToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const sessionKey = opts?.agentSessionKey?.trim();
      if (!sessionKey) {
        return jsonResult({ status: "error", error: "No session context" });
      }

      let wakeAfterSeconds: number;
      let message: string;
      try {
        wakeAfterSeconds = normalizeWakeAfterSeconds(params.wakeAfterSeconds);
        message = readStringParam(params, "message", { required: true });
      } catch (error) {
        return jsonResult({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      const dedupeKey = normalizeOptionalString(params.dedupeKey);
      const name = sleepName({
        explicitName: normalizeOptionalString(params.name),
        dedupeKey,
      });
      const wakeAt = new Date(nowMs() + wakeAfterSeconds * 1000).toISOString();
      const cfg = opts?.config ?? loadConfig();
      const agentId = resolveSessionAgentId({ sessionKey, config: cfg });
      const sessionTarget = `session:${assertSafeCronSessionTargetId(sessionKey)}`;
      const gatewayOpts: GatewayCallOptions = {
        ...readGatewayCallOptions(params),
        timeoutMs:
          typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
            ? params.timeoutMs
            : 60_000,
      };
      const payload: Record<string, unknown> = {
        kind: "agentTurn",
        message,
        timeoutSeconds: normalizeTimeoutSeconds(params.timeoutSeconds),
        lightContext: params.lightContext === undefined ? true : params.lightContext === true,
      };
      const toolsAllow = normalizeToolsAllow(params.toolsAllow);
      if (toolsAllow) {
        payload.toolsAllow = toolsAllow;
      }
      const thinking = normalizeOptionalString(params.thinking);
      if (thinking) {
        payload.thinking = thinking;
      }

      const baseJob: Record<string, unknown> = {
        name,
        enabled: true,
        deleteAfterRun: true,
        schedule: { kind: "at", at: wakeAt },
        sessionTarget,
        wakeMode: "now",
        sessionKey,
        agentId,
        payload,
        delivery: { mode: "none" },
        failureAlert: false,
      };
      if (dedupeKey) {
        baseJob.description = buildSleepDescription(dedupeKey);
      }

      if (dedupeKey && params.onDuplicate !== "add") {
        const list = (await callGateway("cron.list", gatewayOpts, {
          includeDisabled: true,
          limit: 200,
          query: dedupeKey,
        })) as CronListResult;
        const existing = readMatchingSleepJob(Array.isArray(list.jobs) ? list.jobs : [], dedupeKey);
        if (existing) {
          const updated = await callGateway("cron.update", gatewayOpts, {
            id: existing.id,
            patch: baseJob,
          });
          return jsonResult({
            status: "scheduled",
            action: "updated",
            wakeAt,
            wakeAfterSeconds,
            dedupeKey,
            job: updated,
          });
        }
      }

      const created = await callGateway("cron.add", gatewayOpts, baseJob);
      return jsonResult({
        status: "scheduled",
        action: "created",
        wakeAt,
        wakeAfterSeconds,
        ...(dedupeKey ? { dedupeKey } : {}),
        job: created,
      });
    },
  };
}
