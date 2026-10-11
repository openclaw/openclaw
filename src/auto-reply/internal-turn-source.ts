import { isStringOption } from "../utils/string-readers.js";
import type { MsgContext } from "./templating.js";

type InternalTurnContext = Pick<
  MsgContext,
  "InternalTurnSource" | "Provider" | "Surface" | "OriginatingChannel"
>;

const LEGACY_INTERNAL_TURN_SOURCES = new Map<string, MsgContext["InternalTurnSource"]>([
  ["cron-event", "cron"],
  ["exec-event", "exec"],
]);

function legacyInternalTurnSource(value: string | undefined): MsgContext["InternalTurnSource"] {
  return value ? LEGACY_INTERNAL_TURN_SOURCES.get(value) : undefined;
}

/** Fold shipped SDK source labels at ingress; runtime channels describe transport only. */
export function normalizeInternalTurnContext(ctx: InternalTurnContext): void {
  const source = isStringOption(ctx.InternalTurnSource, [
    "cron",
    "exec",
    "event",
    "progress-card-refresh",
  ] as const)
    ? ctx.InternalTurnSource
    : legacyInternalTurnSource(ctx.Provider);
  if (source) {
    ctx.InternalTurnSource = source;
  } else {
    delete ctx.InternalTurnSource;
  }
  for (const field of ["Provider", "Surface", "OriginatingChannel"] as const) {
    if (legacyInternalTurnSource(ctx[field])) {
      delete ctx[field];
    }
  }
}
