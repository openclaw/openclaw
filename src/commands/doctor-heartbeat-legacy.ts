import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { z } from "zod";
import {
  listAgentEntries,
  listAgentIds,
  resolveAgentEntry,
  tryResolveAmbientOwnerAgentId,
  withAgentRosterFactsBatch,
} from "../agents/agent-scope-config.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import type { LegacyHeartbeatConfig } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { LegacyHeartbeatVisibilitySchema } from "./doctor-heartbeat-visibility.js";

export type HeartbeatConfig = LegacyHeartbeatConfig;

type HeartbeatAgent = {
  agentId: string;
  heartbeat?: HeartbeatConfig;
};

export function resolveHeartbeatConfig(
  cfg: OpenClawConfig,
  agentId?: string,
): HeartbeatConfig | undefined {
  const defaults = cfg.agents?.defaults?.heartbeat;
  if (!agentId) {
    return defaults;
  }
  const overrides = resolveAgentEntry(cfg, agentId)?.heartbeat;
  return defaults || overrides ? { ...defaults, ...overrides } : undefined;
}

/** Resolve the cadence owned by the effective heartbeat configuration. */
export function resolveHeartbeatIntervalMs(
  cfg: OpenClawConfig,
  overrideEvery?: string,
  heartbeat?: HeartbeatConfig,
) {
  const raw = overrideEvery ?? heartbeat?.every ?? cfg.agents?.defaults?.heartbeat?.every ?? "30m";
  const trimmed = normalizeOptionalString(raw);
  if (!trimmed) {
    return null;
  }
  try {
    const intervalMs = parseDurationMs(trimmed, { defaultUnit: "m" });
    return intervalMs > 0 ? intervalMs : null;
  } catch {
    return null;
  }
}

function resolveHeartbeatAgentsInBatch(cfg: OpenClawConfig): HeartbeatAgent[] {
  const explicitAgents = listAgentEntries(cfg).filter((entry) => entry.heartbeat);
  if (explicitAgents.length > 0) {
    return explicitAgents
      .map((entry) => {
        const agentId = normalizeAgentId(entry.id);
        return { agentId, heartbeat: resolveHeartbeatConfig(cfg, agentId) };
      })
      .filter((agent) => agent.agentId);
  }
  const configuredAgentId = normalizeOptionalString(cfg.agents?.defaults?.heartbeat?.agentId);
  if (configuredAgentId) {
    const agentId = normalizeAgentId(configuredAgentId);
    return [{ agentId, heartbeat: resolveHeartbeatConfig(cfg, agentId) }];
  }
  if (cfg.agents?.defaults?.heartbeat) {
    return listAgentIds(cfg).map((agentId) => ({
      agentId,
      heartbeat: resolveHeartbeatConfig(cfg, agentId),
    }));
  }
  const agentId = tryResolveAmbientOwnerAgentId(cfg);
  return agentId ? [{ agentId, heartbeat: resolveHeartbeatConfig(cfg, agentId) }] : [];
}

export function resolveHeartbeatAgents(cfg: OpenClawConfig): HeartbeatAgent[] {
  return withAgentRosterFactsBatch(cfg, () => resolveHeartbeatAgentsInBatch(cfg));
}

/** Retire only the standalone acknowledgment; preserve every other prompt byte. */
export function migrateHeartbeatPrompt(prompt: string): string {
  return prompt.replace(/(?<![\p{L}\p{N}_])HEARTBEAT_OK(?![\p{L}\p{N}_])/gu, "NO_REPLY");
}

const LegacyHeartbeatSchema = z
  .object({
    every: z.string().optional(),
    activeHours: z
      .object({
        start: z.string().optional(),
        end: z.string().optional(),
        timezone: z.string().optional(),
      })
      .strict()
      .optional(),
    model: z.string().optional(),
    session: z.string().optional(),
    target: z.string().optional(),
    directPolicy: z.union([z.literal("allow"), z.literal("block")]).optional(),
    to: z.string().optional(),
    accountId: z.string().optional(),
    prompt: z.string().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    lightContext: z.boolean().optional(),
    isolatedSession: z.boolean().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.every) {
      try {
        parseDurationMs(val.every, { defaultUnit: "m" });
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["every"],
          message: "invalid duration (use ms, s, m, h)",
        });
      }
    }

    const active = val.activeHours;
    if (!active) {
      return;
    }
    const timePattern = /^([01]\d|2[0-3]|24):([0-5]\d)$/;
    const validateTime = (raw: string | undefined, opts: { allow24: boolean }, path: string) => {
      if (!raw) {
        return;
      }
      if (!timePattern.test(raw)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["activeHours", path],
          message: 'invalid time (use "HH:MM" 24h format)',
        });
        return;
      }
      const [hourStr, minuteStr] = raw.split(":");
      const hour = Number(hourStr);
      const minute = Number(minuteStr);
      if (hour === 24 && minute !== 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["activeHours", path],
          message: "invalid time (24:00 is the only allowed 24:xx value)",
        });
        return;
      }
      if (hour === 24 && !opts.allow24) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["activeHours", path],
          message: "invalid time (start cannot be 24:00)",
        });
      }
    };

    validateTime(active.start, { allow24: false }, "start");
    validateTime(active.end, { allow24: true }, "end");
  })
  .optional();

export function validateLegacyHeartbeatConfig(cfg: OpenClawConfig): void {
  const defaults = cfg.agents?.defaults?.heartbeat;
  if (defaults !== undefined) {
    LegacyHeartbeatSchema.unwrap()
      .safeExtend({ agentId: z.string().trim().min(1).optional() })
      .parse(defaults);
  }
  const agentIds = new Set(listAgentIds(cfg));
  if (defaults?.agentId && !agentIds.has(normalizeAgentId(defaults.agentId))) {
    throw new Error(`Unknown legacy heartbeat owner ${defaults.agentId}; config was retained.`);
  }
  for (const entry of listAgentEntries(cfg)) {
    LegacyHeartbeatSchema.parse(entry.heartbeat);
  }
  for (const [id, channel] of Object.entries(cfg.channels ?? {})) {
    if (id === "modelByChannel" || !isRecord(channel)) {
      continue;
    }
    LegacyHeartbeatVisibilitySchema.parse(channel.heartbeatVisibility);
    if (isRecord(channel.accounts)) {
      for (const account of Object.values(channel.accounts)) {
        if (isRecord(account)) {
          LegacyHeartbeatVisibilitySchema.parse(account.heartbeatVisibility);
        }
      }
    }
  }
}
