import fs from "node:fs/promises";
import path from "node:path";
import type { WorkspaceBootstrapFile } from "../agents/workspace.js";
import { resolveUserTimezone } from "../agents/date-time.js";
import { readNodeLocationState } from "../infra/node-location-state.js";
import { resolveUserPath } from "../utils.js";

export const DEFAULT_SOUL_INNIE = "SOUL.innie.md";
export const DEFAULT_SOUL_OUTIE = "SOUL.outie.md";
export const DEFAULT_MEMORY_INNIE = "MEMORY.innie.md";
export const DEFAULT_MEMORY_OUTIE = "MEMORY.outie.md";

export type SeverancePersona = "innie" | "outie";

export type SeveranceSchedule = {
  workHours?: { start?: string; end?: string };
  workDays?: number[];
};

export type SeveranceLocationConfig = {
  lat?: number;
  lon?: number;
  radiusKm?: number;
};

export type SeveranceActivation = {
  mode?: "schedule" | "channel" | "env" | "manual" | "location";
  schedule?: SeveranceSchedule;
  channels?: { innie?: string[] };
  env?: { var?: string; innieValue?: string };
  persona?: SeverancePersona;
  location?: SeveranceLocationConfig;
};

export type SeveranceFilesConfig = {
  soulInnie?: string;
  soulOutie?: string;
  memoryInnie?: string;
  memoryOutie?: string;
};

export type SeveranceConfig = {
  activation?: SeveranceActivation;
  files?: SeveranceFilesConfig;
};

export type SeveranceDecision = {
  persona: SeverancePersona;
  reason: string;
};

type SeveranceLog = {
  debug?: (message: string) => void;
  warn?: (message: string) => void;
};

export function resolveSeveranceConfigFromHook(
  entry: Record<string, unknown> | undefined,
  log?: SeveranceLog,
): SeveranceConfig | null {
  if (!entry) {
    return null;
  }

  let activation: SeveranceActivation | undefined;
  if (entry.activation !== undefined) {
    if (typeof entry.activation === "object" && entry.activation !== null) {
      const raw = entry.activation as Record<string, unknown>;
      const mode = typeof raw.mode === "string" ? raw.mode : undefined;
      if (mode && !["schedule", "channel", "env", "manual", "location"].includes(mode)) {
        log?.warn?.(
          "severance config: activation.mode must be schedule|channel|env|manual|location",
        );
      }
      activation = {
        mode: mode as SeveranceActivation["mode"],
        schedule:
          typeof raw.schedule === "object" && raw.schedule !== null
            ? resolveSchedule(raw.schedule as Record<string, unknown>)
            : undefined,
        channels:
          typeof raw.channels === "object" && raw.channels !== null
            ? resolveChannels(raw.channels as Record<string, unknown>)
            : undefined,
        env:
          typeof raw.env === "object" && raw.env !== null
            ? resolveEnvConfig(raw.env as Record<string, unknown>)
            : undefined,
        persona:
          typeof raw.persona === "string" && (raw.persona === "innie" || raw.persona === "outie")
            ? raw.persona
            : undefined,
        location:
          typeof raw.location === "object" && raw.location !== null
            ? resolveLocationConfig(raw.location as Record<string, unknown>)
            : undefined,
      };
    } else {
      log?.warn?.("severance config: activation must be an object");
    }
  }

  let files: SeveranceFilesConfig | undefined;
  if (entry.files !== undefined) {
    if (typeof entry.files === "object" && entry.files !== null) {
      const raw = entry.files as Record<string, unknown>;
      files = {
        soulInnie: typeof raw.soulInnie === "string" ? raw.soulInnie : undefined,
        soulOutie: typeof raw.soulOutie === "string" ? raw.soulOutie : undefined,
        memoryInnie: typeof raw.memoryInnie === "string" ? raw.memoryInnie : undefined,
        memoryOutie: typeof raw.memoryOutie === "string" ? raw.memoryOutie : undefined,
      };
    } else {
      log?.warn?.("severance config: files must be an object");
    }
  }

  if (!activation) {
    return null;
  }
  return { activation, files };
}

function resolveSchedule(raw: Record<string, unknown>): SeveranceSchedule {
  let workHours: SeveranceSchedule["workHours"];
  if (typeof raw.workHours === "object" && raw.workHours !== null) {
    const wh = raw.workHours as Record<string, unknown>;
    workHours = {
      start: typeof wh.start === "string" ? wh.start : undefined,
      end: typeof wh.end === "string" ? wh.end : undefined,
    };
  }
  let workDays: number[] | undefined;
  if (Array.isArray(raw.workDays)) {
    workDays = raw.workDays.filter((d) => typeof d === "number");
  }
  return { workHours, workDays };
}

function resolveChannels(raw: Record<string, unknown>): SeveranceActivation["channels"] {
  let innie: string[] | undefined;
  if (Array.isArray(raw.innie)) {
    innie = raw.innie.filter((c) => typeof c === "string");
  }
  return { innie };
}

function resolveEnvConfig(raw: Record<string, unknown>): SeveranceActivation["env"] {
  return {
    var: typeof raw.var === "string" ? raw.var : undefined,
    innieValue: typeof raw.innieValue === "string" ? raw.innieValue : undefined,
  };
}

function resolveLocationConfig(raw: Record<string, unknown>): SeveranceLocationConfig {
  return {
    lat: typeof raw.lat === "number" ? raw.lat : undefined,
    lon: typeof raw.lon === "number" ? raw.lon : undefined,
    radiusKm: typeof raw.radiusKm === "number" ? raw.radiusKm : undefined,
  };
}

// ── Time-of-day helper (reuses Intl pattern from soul-evil.ts) ─────────

function timeOfDayMinutesInTimezone(date: Date, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const map: Record<string, string> = {};
    for (const part of parts) {
      if (part.type !== "literal") {
        map[part.type] = part.value;
      }
    }
    if (!map.hour || !map.minute) {
      return null;
    }
    const hour = Number.parseInt(map.hour, 10);
    const minute = Number.parseInt(map.minute, 10);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
      return null;
    }
    return hour * 60 + minute;
  } catch {
    return null;
  }
}

function dayOfWeekInTimezone(date: Date, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
    }).formatToParts(date);
    const weekday = parts.find((p) => p.type === "weekday")?.value;
    if (!weekday) {
      return null;
    }
    const dayMap: Record<string, number> = {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
    };
    return dayMap[weekday] ?? null;
  } catch {
    return null;
  }
}

function parseTimeToMinutes(raw?: string): number | null {
  if (!raw) {
    return null;
  }
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(raw.trim());
  if (!match) {
    return null;
  }
  const hour = Number.parseInt(match[1] ?? "", 10);
  const minute = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return null;
  }
  return hour * 60 + minute;
}

// ── Haversine distance ─────────────────────────────────────────────────

export function haversineDistanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ── Decision logic ─────────────────────────────────────────────────────

export type SeveranceDecisionParams = {
  config?: SeveranceConfig;
  userTimezone?: string;
  now?: Date;
  runtimeChannel?: string;
  env?: NodeJS.ProcessEnv;
  locationStateDir?: string;
};

export async function decideSeverancePersona(
  params: SeveranceDecisionParams,
): Promise<SeveranceDecision | null> {
  const activation = params.config?.activation;
  if (!activation?.mode) {
    return null;
  }

  const mode = activation.mode;

  switch (mode) {
    case "schedule": {
      return decideBySchedule(activation.schedule, params);
    }
    case "channel": {
      return decideByChannel(activation.channels, params.runtimeChannel);
    }
    case "env": {
      return decideByEnv(activation.env, params.env);
    }
    case "manual": {
      return decideByManual(activation.persona);
    }
    case "location": {
      return await decideByLocation(activation.location, params.locationStateDir);
    }
    default: {
      return null;
    }
  }
}

function decideBySchedule(
  schedule: SeveranceSchedule | undefined,
  params: SeveranceDecisionParams,
): SeveranceDecision | null {
  if (!schedule?.workHours?.start || !schedule.workHours.end) {
    return null;
  }
  const timeZone = resolveUserTimezone(params.userTimezone);
  const now = params.now ?? new Date();

  const workDays = schedule.workDays ?? [1, 2, 3, 4, 5];
  const day = dayOfWeekInTimezone(now, timeZone);
  if (day === null) {
    return null;
  }
  if (!workDays.includes(day)) {
    return { persona: "outie", reason: "schedule:weekend" };
  }

  const startMin = parseTimeToMinutes(schedule.workHours.start);
  const endMin = parseTimeToMinutes(schedule.workHours.end);
  if (startMin === null || endMin === null) {
    return null;
  }

  const nowMin = timeOfDayMinutesInTimezone(now, timeZone);
  if (nowMin === null) {
    return null;
  }

  const inWork =
    startMin <= endMin
      ? nowMin >= startMin && nowMin < endMin
      : nowMin >= startMin || nowMin < endMin;

  return inWork
    ? { persona: "innie", reason: "schedule:work-hours" }
    : { persona: "outie", reason: "schedule:off-hours" };
}

function decideByChannel(
  channels: SeveranceActivation["channels"] | undefined,
  runtimeChannel?: string,
): SeveranceDecision | null {
  const innies = channels?.innie;
  if (!Array.isArray(innies) || innies.length === 0) {
    return null;
  }
  const channel = runtimeChannel?.trim().toLowerCase();
  if (!channel) {
    return { persona: "outie", reason: "channel:unknown" };
  }
  const isInnie = innies.some((c) => c.toLowerCase() === channel);
  return isInnie
    ? { persona: "innie", reason: `channel:${channel}` }
    : { persona: "outie", reason: `channel:${channel}` };
}

function decideByEnv(
  envConfig: SeveranceActivation["env"] | undefined,
  env?: NodeJS.ProcessEnv,
): SeveranceDecision | null {
  const varName = envConfig?.var?.trim();
  if (!varName) {
    return null;
  }
  const envValue = (env ?? process.env)[varName]?.trim();
  const innieValue = envConfig?.innieValue?.trim() ?? "innie";
  if (envValue === innieValue) {
    return { persona: "innie", reason: `env:${varName}=${envValue}` };
  }
  return { persona: "outie", reason: `env:${varName}=${envValue ?? ""}` };
}

function decideByManual(persona?: SeverancePersona): SeveranceDecision | null {
  if (persona !== "innie" && persona !== "outie") {
    return null;
  }
  return { persona, reason: "manual" };
}

async function decideByLocation(
  locationConfig: SeveranceLocationConfig | undefined,
  stateDir?: string,
): Promise<SeveranceDecision | null> {
  if (
    typeof locationConfig?.lat !== "number" ||
    typeof locationConfig.lon !== "number" ||
    typeof locationConfig.radiusKm !== "number"
  ) {
    return null;
  }

  const state = await readNodeLocationState(stateDir);
  if (!state) {
    return { persona: "outie", reason: "location:no-data" };
  }

  const distance = haversineDistanceKm(
    state.lat,
    state.lon,
    locationConfig.lat,
    locationConfig.lon,
  );

  if (distance <= locationConfig.radiusKm) {
    return { persona: "innie", reason: `location:${distance.toFixed(2)}km` };
  }
  return { persona: "outie", reason: `location:${distance.toFixed(2)}km` };
}

// ── Bootstrap file override ────────────────────────────────────────────

export async function applySeveranceOverride(params: {
  files: WorkspaceBootstrapFile[];
  workspaceDir: string;
  config?: SeveranceConfig;
  userTimezone?: string;
  now?: Date;
  runtimeChannel?: string;
  env?: NodeJS.ProcessEnv;
  locationStateDir?: string;
  log?: SeveranceLog;
}): Promise<WorkspaceBootstrapFile[]> {
  const decision = await decideSeverancePersona({
    config: params.config,
    userTimezone: params.userTimezone,
    now: params.now,
    runtimeChannel: params.runtimeChannel,
    env: params.env,
    locationStateDir: params.locationStateDir,
  });

  if (!decision) {
    return params.files;
  }

  const filesConfig = params.config?.files;
  const soulFile =
    decision.persona === "innie"
      ? filesConfig?.soulInnie?.trim() || DEFAULT_SOUL_INNIE
      : filesConfig?.soulOutie?.trim() || DEFAULT_SOUL_OUTIE;
  const memoryFile =
    decision.persona === "innie"
      ? filesConfig?.memoryInnie?.trim() || DEFAULT_MEMORY_INNIE
      : filesConfig?.memoryOutie?.trim() || DEFAULT_MEMORY_OUTIE;

  const workspaceDir = resolveUserPath(params.workspaceDir);

  // Read persona-specific SOUL file
  const soulContent = await readOptionalFile(
    path.join(workspaceDir, soulFile),
    params.log,
    `severance:${soulFile}`,
  );
  // Read persona-specific MEMORY file
  const memoryContent = await readOptionalFile(
    path.join(workspaceDir, memoryFile),
    params.log,
    `severance:${memoryFile}`,
  );

  const hasSoul = params.files.some((f) => f.name === "SOUL.md");
  if (!hasSoul) {
    params.log?.warn?.(`severance active (${decision.reason}) but SOUL.md not in bootstrap files`);
    return params.files;
  }

  const updated = params.files.map((file) => {
    if (file.name === "SOUL.md" && soulContent !== null) {
      return { ...file, content: soulContent, missing: false };
    }
    if ((file.name === "MEMORY.md" || file.name === "memory.md") && memoryContent !== null) {
      return { ...file, content: memoryContent, missing: false };
    }
    return file;
  });

  params.log?.debug?.(
    `severance active: persona=${decision.persona} reason=${decision.reason} soul=${soulFile} memory=${memoryFile}`,
  );

  return updated;
}

async function readOptionalFile(
  filePath: string,
  log: SeveranceLog | undefined,
  label: string,
): Promise<string | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    if (!content.trim()) {
      log?.warn?.(`${label} file empty: ${filePath}`);
      return null;
    }
    return content;
  } catch {
    log?.warn?.(`${label} file missing: ${filePath}`);
    return null;
  }
}
