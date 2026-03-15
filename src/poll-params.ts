import { readSnakeCaseParamRaw } from "./param-key.js";

export type PollCreationParamKind = "string" | "stringArray" | "number" | "boolean";

export type PollCreationParamDef = {
  kind: PollCreationParamKind;
  telegramOnly?: boolean;
};

export const POLL_CREATION_PARAM_DEFS: Record<string, PollCreationParamDef> = {
  pollQuestion: { kind: "string" },
  pollOption: { kind: "stringArray" },
  pollDurationHours: { kind: "number" },
  pollMulti: { kind: "boolean" },
  pollDurationSeconds: { kind: "number", telegramOnly: true },
  pollAnonymous: { kind: "boolean", telegramOnly: true },
  pollPublic: { kind: "boolean", telegramOnly: true },
};

export type PollCreationParamName = keyof typeof POLL_CREATION_PARAM_DEFS;

export const POLL_CREATION_PARAM_NAMES = Object.keys(POLL_CREATION_PARAM_DEFS);

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

/**
 * Check whether params contain meaningful poll creation intent.
 *
 * Models frequently auto-fill optional poll fields from the tool schema even
 * when the user only wants a plain send. To avoid false positives we require
 * **pollQuestion** (the one field that unambiguously signals poll intent) to
 * be present and non-empty. Without a question there is no actionable poll,
 * so stray defaults like `pollDurationHours: 0` or `pollMulti: false` are
 * harmless noise.
 *
 * See: https://github.com/openclaw/openclaw/issues/42820
 *      https://github.com/openclaw/openclaw/issues/43015
 */
export function hasPollCreationParams(params: Record<string, unknown>): boolean {
  // Gate on pollQuestion — the only required field for a real poll.
  const question = readPollParamRaw(params, "pollQuestion");
  if (typeof question !== "string" || question.trim().length === 0) {
    return false;
  }
  return true;
}

/**
 * Strip all poll-creation parameters from a params bag.
 * Useful for sanitizing `action="send"` requests where models may have
 * auto-populated poll fields from the shared tool schema.
 */
export function stripPollCreationParams(params: Record<string, unknown>): void {
  for (const key of POLL_CREATION_PARAM_NAMES) {
    delete params[key];
    // Also delete snake_case variants (e.g. poll_question)
    const snakeKey = key
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase();
    if (snakeKey !== key) {
      delete params[snakeKey];
    }
  }
}
