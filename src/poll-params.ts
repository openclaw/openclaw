import { readSnakeCaseParamRaw } from "./param-key.js";

export type PollCreationParamKind = "string" | "stringArray" | "number" | "boolean";

export type PollCreationParamDef = {
  kind: PollCreationParamKind;
};

const SHARED_POLL_CREATION_PARAM_DEFS = {
  pollQuestion: { kind: "string" },
  pollOption: { kind: "stringArray" },
  pollDurationHours: { kind: "number" },
  pollMulti: { kind: "boolean" },
} satisfies Record<string, PollCreationParamDef>;

const TELEGRAM_POLL_CREATION_PARAM_DEFS = {
  pollDurationSeconds: { kind: "number" },
  pollAnonymous: { kind: "boolean" },
  pollPublic: { kind: "boolean" },
} satisfies Record<string, PollCreationParamDef>;

export const POLL_CREATION_PARAM_DEFS: Record<string, PollCreationParamDef> = {
  ...SHARED_POLL_CREATION_PARAM_DEFS,
  ...TELEGRAM_POLL_CREATION_PARAM_DEFS,
};

export type SharedPollCreationParamName = keyof typeof SHARED_POLL_CREATION_PARAM_DEFS;
export type TelegramPollCreationParamName = keyof typeof TELEGRAM_POLL_CREATION_PARAM_DEFS;
export type PollCreationParamName = keyof typeof POLL_CREATION_PARAM_DEFS;

export const POLL_CREATION_PARAM_NAMES = Object.keys(POLL_CREATION_PARAM_DEFS);
export const SHARED_POLL_CREATION_PARAM_NAMES = Object.keys(
  SHARED_POLL_CREATION_PARAM_DEFS,
) as SharedPollCreationParamName[];
export const TELEGRAM_POLL_CREATION_PARAM_NAMES = Object.keys(
  TELEGRAM_POLL_CREATION_PARAM_DEFS,
) as TelegramPollCreationParamName[];

function readPollParamRaw(params: Record<string, unknown>, key: string): unknown {
  return readSnakeCaseParamRaw(params, key);
}

export function resolveTelegramPollVisibility(params: {
  pollAnonymous?: boolean;
  pollPublic?: boolean;
}): boolean | undefined {
  if (params.pollAnonymous && params.pollPublic) {
    throw new Error("pollAnonymous and pollPublic are mutually exclusive");
  }
  return params.pollAnonymous ? true : params.pollPublic ? false : undefined;
}

export function hasPollCreationParams(params: Record<string, unknown>): boolean {
  for (const key of POLL_CREATION_PARAM_NAMES) {
    const def = POLL_CREATION_PARAM_DEFS[key];
    const value = readPollParamRaw(params, key);
    if (def.kind === "string" && typeof value === "string" && value.trim().length > 0) {
      return true;
    }
    if (def.kind === "stringArray") {
      if (
        Array.isArray(value) &&
        value.some((entry) => typeof entry === "string" && entry.trim())
      ) {
        return true;
      }
      if (typeof value === "string" && value.trim().length > 0) {
        return true;
      }
    }
    if (def.kind === "number") {
      // Treat 0 as absent — callers/wrappers often auto-fill numeric fields with 0 as a
      // default, and a zero-duration poll is not a meaningful poll creation signal.
      if (typeof value === "number" && Number.isFinite(value) && value !== 0) {
        return true;
      }
      if (typeof value === "string") {
        const trimmed = value.trim();
        const parsed = Number(trimmed);
        if (trimmed.length > 0 && Number.isFinite(parsed) && parsed !== 0) {
          return true;
        }
      }
    }
    if (def.kind === "boolean") {
      if (value === true) {
        return true;
      }
      if (typeof value === "string" && value.trim().toLowerCase() === "true") {
        return true;
      }
    }
  }
  return false;
}
