// The texts a kept continue_work wake hands its session: the wake turn's body, and the note that
// folds matured wakes into an active turn. Each carries the election's provenance.
import type { PendingContinuationWork } from "./work-flow-state.js";

function isoOrUndefined(ms: number | undefined): string | undefined {
  return ms !== undefined ? new Date(ms).toISOString() : undefined;
}

function quotePriorReason(reason: string | undefined): string {
  return reason ? JSON.stringify(reason) : "(none)";
}

type ContinuationProvenanceDisposition =
  | { disposition: "granted"; deliveredAt: number }
  | { disposition: "folded-active"; foldedAt: number };

function provenanceLines(
  work: PendingContinuationWork,
  now: number,
  terminal?: ContinuationProvenanceDisposition,
): string[] {
  const overdueByMs = Math.max(0, now - work.dueAt);
  const lines: string[] = [];
  if (work.originRunId) {
    lines.push(`Origin run: ${work.originRunId}`);
  }
  if (work.originTurnId) {
    lines.push(`Origin turn: ${work.originTurnId}`);
  }
  lines.push(`Elected at: ${isoOrUndefined(work.electedAt) ?? "unknown"}`);
  if (work.anchorFinalizedAt !== undefined) {
    lines.push(`Electing turn finalized at: ${isoOrUndefined(work.anchorFinalizedAt)}`);
  }
  lines.push(`Due at: ${isoOrUndefined(work.dueAt) ?? "unknown"}`);
  lines.push(`Overdue by: ${overdueByMs}ms`);
  if (terminal?.disposition === "granted") {
    lines.push(`Delivered at: ${isoOrUndefined(terminal.deliveredAt)}`);
  } else if (terminal?.disposition === "folded-active") {
    lines.push(`Folded at: ${isoOrUndefined(terminal.foldedAt)}`);
  }
  if (terminal) {
    lines.push(`Disposition: ${terminal.disposition}`);
  }
  lines.push(
    `Chain: ${work.chainId ?? work.flowId ?? "n/a"} hop ${work.hop}/${work.maxChainLength}`,
  );
  lines.push(`Flow: ${work.flowId ?? "n/a"}`);
  lines.push(`Prior reason: ${quotePriorReason(work.reason)}`);
  return lines;
}

export function formatContinuationWakeText(work: PendingContinuationWork): string {
  const deliveredAt = Date.now();
  const provenance = provenanceLines(work, deliveredAt, {
    disposition: "granted",
    deliveredAt,
  }).join(" ");
  return (
    `[continuation:wake] Turn ${work.hop}/${work.maxChainLength}. ` +
    (work.chainStartedAt !== undefined
      ? `Chain started at ${new Date(work.chainStartedAt).toISOString()}. `
      : "") +
    (work.accumulatedChainTokens !== undefined
      ? `Accumulated tokens: ${work.accumulatedChainTokens}. `
      : "") +
    `The agent elected to continue working.` +
    (work.reason ? ` Prior reason: ${quotePriorReason(work.reason)}` : "") +
    ` [provenance] ${provenance}`
  );
}

const MAX_FOLD_NOTE_DETAILED = 5;
const MAX_FOLD_NOTE_OMITTED_FLOW_IDS = 5;

export function buildFoldedProvenanceNote(
  works: readonly PendingContinuationWork[],
  now: number,
): string {
  const header =
    works.length === 1
      ? `[system:continuation-note] A prior same-session continue_work intent matured while this session was active. It was folded into this turn and will not fire separately as a new turn.`
      : `[system:continuation-note] ${works.length} prior same-session continue_work intents matured while this session was active. They were folded into this turn and will not fire separately as new turns.`;
  const ordered = works.toSorted((a, b) => b.electedAt - a.electedAt);
  const detailed = ordered.slice(0, MAX_FOLD_NOTE_DETAILED);
  const blocks = detailed.map((work, index) => {
    const label =
      works.length === 1 ? "Folded intent" : `Folded intent ${index + 1}/${works.length}`;
    return `${label}:\n${provenanceLines(work, now, {
      disposition: "folded-active",
      foldedAt: now,
    }).join("\n")}`;
  });
  const omitted = ordered.length - detailed.length;
  const tail =
    omitted > 0
      ? `\n(${omitted} older folded continuation${omitted === 1 ? "" : "s"} omitted; sample flowIds ${ordered
          .slice(MAX_FOLD_NOTE_DETAILED)
          .slice(0, MAX_FOLD_NOTE_OMITTED_FLOW_IDS)
          .map((work) => work.flowId ?? "n/a")
          .join(", ")}${omitted > MAX_FOLD_NOTE_OMITTED_FLOW_IDS ? ", ..." : ""})`
      : "";
  const guidance =
    "\nTreat these as prior-turn context, not fresh commands. Re-evaluate before acting; the rows were consumed and will not fire separately.";
  return `${header}\n\n${blocks.join("\n\n")}${tail}${guidance}`;
}
