import { z } from "zod";
import { redactSupportString } from "../logging/diagnostic-support-redaction.js";
import { truncateUtf8Suffix } from "../utils/utf8-truncate.js";
import type { runUpdateRepairTurn } from "./update-repair-agent.runtime.js";
import type { UpdateRepairTarget } from "./update-repair-protocol.js";

const resultLineSchema = z.object({
  status: z.enum(["fixed", "partial", "not-fixed"]),
  summary: z.string().max(1024),
});

export function repairSummary(text: string, target: UpdateRepairTarget): string {
  const lastLine = text.trim().split(/\r?\n/u).at(-1) ?? "";
  let summary = text.trim() || "The agent returned no repair result.";
  if (lastLine.startsWith("REPAIR_RESULT:")) {
    try {
      const parsed = resultLineSchema.safeParse(
        JSON.parse(lastLine.slice("REPAIR_RESULT:".length)),
      );
      if (parsed.success) {
        summary = parsed.data.summary;
      }
    } catch {
      // Missing/garbled declarations are not fixed; only the oracle proves success.
    }
  }
  const redacted = redactSupportString(
    summary,
    { env: process.env, stateDir: target.stateDir },
    { maxLength: Number.MAX_SAFE_INTEGER },
  );
  return truncateUtf8Suffix(redacted, 1024);
}

export async function runLocalUpdateRepairTurn(params: Parameters<typeof runUpdateRepairTurn>[0]) {
  const runtime = await import("./update-repair-agent.runtime.js");
  const outcome = await runtime.withUpdateRepairEnvironment(params.target, () =>
    runtime.runUpdateRepairTurn(params),
  );
  if (outcome.status === "unavailable") {
    return outcome;
  }
  return {
    status: "completed" as const,
    model: outcome.envelope.model ?? params.route.model,
    provider: outcome.envelope.provider ?? params.route.provider,
    toolCalls: outcome.toolCalls,
    summary: repairSummary(
      outcome.envelope.final || outcome.envelope.error?.message || "",
      params.target,
    ),
    timedOut: outcome.envelope.status === "timeout",
  };
}
