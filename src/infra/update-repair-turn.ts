import { z } from "zod";
import { redactSupportString } from "../logging/diagnostic-support-redaction.js";
import { truncateUtf8Suffix } from "../utils/utf8-truncate.js";
import type { UpdateRepairTarget, UpdateRepairTurnRunner } from "./update-repair-protocol.js";

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
      // Only the independent oracle can establish that a repair succeeded.
    }
  }
  return truncateUtf8Suffix(
    redactSupportString(
      summary,
      { env: process.env, stateDir: target.stateDir },
      { maxLength: Number.MAX_SAFE_INTEGER },
    ),
    1024,
  );
}

/** Local triage retains its selected route; update workers own one isolated turn. */
export function createUpdateRepairTurnRunner(target: UpdateRepairTarget): UpdateRepairTurnRunner {
  let selected:
    | Awaited<
        ReturnType<typeof import("./update-repair-agent.runtime.js").prepareUpdateRepairInference>
      >
    | undefined;
  return async (params) => {
    const assertCurrent = () => {
      params.signal.throwIfAborted();
      if (params.isCurrent?.() === false) {
        throw new Error("Repair no longer owns the update attempt.");
      }
    };
    // The old updater never calls this driver or imports the migrated inference graph.
    const runtime = await import("./update-repair-agent.runtime.js");
    assertCurrent();
    selected ??= await runtime.withUpdateRepairEnvironment(target, () =>
      runtime.prepareUpdateRepairInference(params.signal, params.timeoutMs),
    );
    assertCurrent();
    if (!selected.ok) {
      return { status: "unavailable", reason: repairSummary(selected.reason, target) };
    }
    const { route, modelFallbacks } = selected;
    params.onRoute({ model: route.model, provider: route.provider });
    const outcome = await runtime.withUpdateRepairEnvironment(target, () =>
      runtime.runUpdateRepairTurn({
        target,
        route,
        modelFallbacks,
        prompt: params.prompt,
        timeoutMs: params.timeoutMs,
        maxToolCalls: params.maxToolCalls,
        signal: params.signal,
        isCurrent: params.isCurrent,
      }),
    );
    if (outcome.status === "unavailable") {
      return { status: "unavailable", reason: repairSummary(outcome.reason, target) };
    }
    return {
      status: "completed",
      model: outcome.envelope.model ?? route.model,
      provider: outcome.envelope.provider ?? route.provider,
      toolCalls: outcome.toolCalls,
      summary: repairSummary(
        outcome.envelope.final || outcome.envelope.error?.message || "",
        target,
      ),
      timedOut: outcome.envelope.status === "timeout",
    };
  };
}
