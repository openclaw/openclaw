import { isStringOption } from "../utils/string-readers.js";
import { INTERNAL_WAKE_TRANSCRIPT_PROMPTS } from "./heartbeat.js";
import type { MsgContext } from "./templating.js";

type InternalTurnContext = Pick<
  MsgContext,
  "InternalTurnSource" | "Provider" | "Surface" | "OriginatingChannel"
>;

/** Keep wake history compact while preserving the producer's actual event identity. */
export function resolveInternalTurnTranscript(
  ctx: Pick<MsgContext, "InputProvenance" | "InternalTurnSource">,
) {
  const provenance =
    ctx.InputProvenance?.kind === "internal_system"
      ? ctx.InputProvenance
      : { kind: "internal_system" as const, sourceTool: ctx.InternalTurnSource ?? "heartbeat" };
  const source = provenance.sourceTool ?? ctx.InternalTurnSource ?? "heartbeat";
  const text =
    source === "heartbeat"
      ? INTERNAL_WAKE_TRANSCRIPT_PROMPTS.heartbeat
      : source === "exec" || source === "exec-event"
        ? INTERNAL_WAKE_TRANSCRIPT_PROMPTS.exec
        : source === "cron"
          ? INTERNAL_WAKE_TRANSCRIPT_PROMPTS.cron
          : INTERNAL_WAKE_TRANSCRIPT_PROMPTS.event;
  return { text, provenance };
}

function legacyInternalTurnSource(value: string | undefined): MsgContext["InternalTurnSource"] {
  switch (value) {
    case "heartbeat":
      return "heartbeat";
    case "cron-event":
      return "cron";
    case "exec-event":
      return "exec";
    default:
      return undefined;
  }
}

/** Fold shipped SDK source labels at ingress; runtime channels describe transport only. */
export function normalizeInternalTurnContext(ctx: InternalTurnContext): void {
  const source = isStringOption(ctx.InternalTurnSource, ["heartbeat", "cron", "exec"] as const)
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
