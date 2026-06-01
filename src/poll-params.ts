import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { readSnakeCaseParamRaw } from "./param-key.js";

type PollCreationParamKind = "string" | "stringArray" | "positiveInteger" | "boolean";

type PollCreationParamDef = {
  kind: PollCreationParamKind;
};

const SHARED_POLL_CREATION_PARAM_DEFS = {
  pollQuestion: { kind: "string" },
  pollOption: { kind: "stringArray" },
  pollDurationHours: { kind: "positiveInteger" },
  pollMulti: { kind: "boolean" },
} satisfies Record<string, PollCreationParamDef>;

export const POLL_CREATION_PARAM_DEFS: Record<string, PollCreationParamDef> =
  SHARED_POLL_CREATION_PARAM_DEFS;

type SharedPollCreationParamName = keyof typeof SHARED_POLL_CREATION_PARAM_DEFS;

export const SHARED_POLL_CREATION_PARAM_NAMES = Object.keys(
  SHARED_POLL_CREATION_PARAM_DEFS,
) as SharedPollCreationParamName[];
const POLL_CREATION_ANCHOR_PARAM_KEY_SET = new Set(
  ["pollQuestion", "pollOption"].map(normalizePollParamKey),
);

function readPollParamRaw(params: Record<string, unknown>, key: string): unknown {
  return readSnakeCaseParamRaw(params, key);
}

function normalizePollParamKey(key: string): string {
  return normalizeLowercaseStringOrEmpty(key.replaceAll("_", ""));
}

export function hasPollCreationParams(params: Record<string, unknown>): boolean {
  for (const key of SHARED_POLL_CREATION_PARAM_NAMES) {
    const def = POLL_CREATION_PARAM_DEFS[key];
    const value = readPollParamRaw(params, key);
    if (def.kind === "string" && typeof value === "string" && value.trim().length > 0) {
      return POLL_CREATION_ANCHOR_PARAM_KEY_SET.has(normalizePollParamKey(key));
    }
    if (def.kind === "stringArray") {
      if (
        Array.isArray(value) &&
        value.some((entry) => typeof entry === "string" && entry.trim())
      ) {
        return POLL_CREATION_ANCHOR_PARAM_KEY_SET.has(normalizePollParamKey(key));
      }
      if (typeof value === "string" && value.trim().length > 0) {
        return POLL_CREATION_ANCHOR_PARAM_KEY_SET.has(normalizePollParamKey(key));
      }
    }
  }
  return false;
}
