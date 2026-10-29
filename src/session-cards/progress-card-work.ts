import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import {
  PROGRESS_CARD_MAX_STEP_UTF8_BYTES,
  PROGRESS_CARD_MAX_STEPS,
} from "../../packages/gateway-protocol/src/progress-card-limits.js";
import { closedObject } from "../../packages/gateway-protocol/src/schema/closed-object.js";
import {
  ProgressCardStepSchema,
  type ProgressCard,
  type ProgressCardStep,
} from "../../packages/gateway-protocol/src/schema/progress-card.js";
import { normalizeProgressCardInput, ProgressCardInputError } from "./progress-card-input.js";

const text = Type.String({ minLength: 1, maxLength: PROGRESS_CARD_MAX_STEP_UTF8_BYTES });
const OwnerSchema = closedObject({
  agentId: text,
  sessionKey: text,
  sessionId: text,
  lifecycleRevision: Type.Union([text, Type.Null()]),
});
const SourceSchema = closedObject({
  runId: text,
  turnId: text,
  toolCallId: text,
  processGeneration: text,
});
const WaitSchema = Type.Union([
  closedObject({ kind: Type.Literal("child"), runId: text, childSessionKey: text }),
  closedObject({ kind: Type.Literal("media"), runId: text, taskId: text }),
]);
const DispositionSchema = Type.Union([
  closedObject({ kind: Type.Literal("actionable") }),
  closedObject({
    kind: Type.Literal("waiting"),
    receipt: WaitSchema,
    resumeCondition: text,
    source: SourceSchema,
  }),
  closedObject({
    kind: Type.Literal("paused-blocked"),
    reason: text,
    resumeCondition: text,
    source: SourceSchema,
  }),
  closedObject({ kind: Type.Literal("completed"), source: SourceSchema }),
]);
const RecordSchema = closedObject({
  version: Type.Literal(1),
  owner: OwnerSchema,
  source: SourceSchema,
  scope: text,
  steps: Type.Array(ProgressCardStepSchema, { minItems: 1, maxItems: PROGRESS_CARD_MAX_STEPS }),
  disposition: DispositionSchema,
});
export type ProgressOwner = Static<typeof OwnerSchema>;
export type WorkSource = Static<typeof SourceSchema>;
export type AcceptedWaitReference = Static<typeof WaitSchema>;
export type WorkDisposition = Static<typeof DispositionSchema>;
export type WorkRecord = Static<typeof RecordSchema>;
export type WorkFence = { generation: number; revision: number };
export type ProgressWorkState = WorkFence & {
  record: WorkRecord | null;
  lastCommand?: { id: string; fingerprint: string };
};
export type ProgressAggregate = Omit<ProgressCard, "sessionKey"> & {
  checklist?: "independent" | "work";
  work?: ProgressWorkState;
};
export type ProgressWorkCommand = {
  owner: ProgressOwner;
  source: WorkSource;
  expected: WorkFence | null;
  /** Omission leaves presentation alone; tool calls explicitly replace it. */
  display?: "replace";
} & (
  | { kind: "begin" | "replace"; scope: string }
  | { kind: "reconcile"; disposition?: WorkDisposition }
  | { kind: "retire" }
  | { kind: "observe-wait"; receipt: AcceptedWaitReference; resumeCondition: string }
);

function nonempty(value: string): string {
  const normalized = normalizeProgressCardInput({ plan: [{ step: value, status: "pending" }] })
    .steps![0]!.step;
  return normalized;
}
function validateRecord(record: unknown): asserts record is WorkRecord {
  if (!Check(RecordSchema, record)) {
    throw new ProgressCardInputError("Invalid retained work record");
  }
  for (const value of [
    ...Object.values(record.owner),
    ...Object.values(record.source),
    record.scope,
  ]) {
    if (value !== null) {
      nonempty(value);
    }
  }
  const steps = normalizeProgressCardInput({ plan: record.steps }).steps;
  if (!steps || !isDeepStrictEqual(steps, record.steps)) {
    throw new ProgressCardInputError("Invalid retained work steps");
  }
  const unresolved = steps.some((step) => step.status !== "completed");
  if (unresolved === (record.disposition.kind === "completed")) {
    throw new ProgressCardInputError("Work disposition does not match its obligations");
  }
  if (record.disposition.kind === "paused-blocked") {
    nonempty(record.disposition.reason);
  }
  if (record.disposition.kind === "paused-blocked" || record.disposition.kind === "waiting") {
    nonempty(record.disposition.resumeCondition);
  }
}
export function decodeProgressWorkRecord(json: string | null): WorkRecord | null {
  if (json === null) {
    return null;
  }
  const value: unknown = JSON.parse(json);
  validateRecord(value);
  return value;
}
export function presentSessionProgress(
  sessionKey: string,
  state: ProgressAggregate | undefined,
): ProgressCard | null {
  if (!state) {
    return null;
  }
  const steps = state.checklist === "work" ? state.work?.record?.steps : state.steps;
  if (state.checklist === "work" && !state.work?.record) {
    throw new ProgressCardInputError("Progress display has no retained work");
  }
  if (!state.markdown && !steps?.length) {
    return null;
  }
  return {
    sessionKey,
    revision: state.revision,
    updatedAt: state.updatedAt,
    ...(state.markdown ? { markdown: state.markdown } : {}),
    ...(steps?.length ? { steps } : {}),
  };
}

export function assertProgressWorkFence(
  current: ProgressWorkState | undefined,
  expected: WorkFence | null,
) {
  if (
    current
      ? !expected ||
        current.generation !== expected.generation ||
        current.revision !== expected.revision
      : expected !== null
  ) {
    throw new ProgressCardInputError("Retained work changed before commit");
  }
}

/** The storage owners supply current custody; this reducer never interprets prose or grants it. */
export function reconcileSessionProgress(
  current: ProgressAggregate | undefined,
  input: { markdown?: string; steps?: ProgressCardStep[]; workCommand: ProgressWorkCommand },
  now: number,
): ProgressAggregate {
  const command = input.workCommand;
  if (!Check(OwnerSchema, command.owner) || !Check(SourceSchema, command.source)) {
    throw new ProgressCardInputError("Invalid work custody");
  }
  const normalized = normalizeProgressCardInput({ markdown: input.markdown, plan: input.steps });
  const previous = current?.work;
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        kind: command.kind,
        expected: command.expected,
        owner: command.owner,
        display: command.display,
        ...normalized,
        ...(command.kind === "begin" || command.kind === "replace"
          ? { scope: nonempty(command.scope) }
          : {}),
        ...(command.kind === "reconcile" ? { disposition: command.disposition } : {}),
        ...(command.kind === "observe-wait"
          ? { receipt: command.receipt, resumeCondition: nonempty(command.resumeCondition) }
          : {}),
      }),
    )
    .digest("hex");
  const id = createHash("sha256")
    .update(
      JSON.stringify([command.source.runId, command.source.turnId, command.source.toolCallId]),
    )
    .digest("hex");
  if (previous?.record && !isDeepStrictEqual(previous.record.owner, command.owner)) {
    throw new ProgressCardInputError("Retained work belongs to another session incarnation");
  }
  if (previous?.lastCommand?.id === id) {
    if (previous.lastCommand.fingerprint !== fingerprint) {
      throw new ProgressCardInputError("Work command identity was reused");
    }
    return current!;
  }
  assertProgressWorkFence(previous, command.expected);
  let record: WorkRecord | null;
  let generation = previous?.generation ?? 0;
  const old = previous?.record;
  switch (command.kind) {
    case "begin":
    case "replace": {
      if (command.kind === "begin" && old && old.disposition.kind !== "completed") {
        throw new ProgressCardInputError("Use explicit replacement for unfinished work");
      }
      if (!normalized.steps) {
        throw new ProgressCardInputError("New work needs a nonempty plan");
      }
      generation += 1;
      record = {
        version: 1,
        owner: command.owner,
        source: command.source,
        scope: nonempty(command.scope),
        steps: normalized.steps,
        disposition: normalized.steps.some((step) => step.status !== "completed")
          ? { kind: "actionable" }
          : { kind: "completed", source: command.source },
      };
      break;
    }
    case "retire":
      if (!previous) {
        throw new ProgressCardInputError("No retained work to retire");
      }
      record = null;
      break;
    case "observe-wait":
    case "reconcile": {
      if (!old || old.disposition.kind === "completed") {
        throw new ProgressCardInputError("Terminal work requires explicit begin or replacement");
      }
      if (command.kind === "observe-wait" && old.disposition.kind !== "actionable") {
        return current!;
      }
      const steps = normalized.steps ?? old.steps;
      // Labels are the existing plan identity. Renaming/removing unresolved scope is replacement,
      // not an implicit completion. Completed steps stay available to avoid repeating effects.
      const counts = new Map<string, number>();
      for (const step of steps) {
        counts.set(step.step, (counts.get(step.step) ?? 0) + 1);
      }
      const omittedCompleted: ProgressCardStep[] = [];
      for (const step of old.steps) {
        const count = counts.get(step.step) ?? 0;
        if (count) {
          counts.set(step.step, count - 1);
        } else if (step.status === "completed") {
          omittedCompleted.push(step);
        } else {
          throw new ProgressCardInputError(
            "Reconcile every unresolved step or explicitly replace the task",
          );
        }
      }
      record = {
        ...old,
        // Only an explicit current disposition is a new observation basis.
        // Display/implicit plan updates and native waiting cannot erase uncertainty.
        source: command.kind === "reconcile" && command.disposition ? command.source : old.source,
        steps: [...omittedCompleted, ...steps],
        disposition:
          command.kind === "observe-wait"
            ? {
                kind: "waiting",
                receipt: command.receipt,
                resumeCondition: nonempty(command.resumeCondition),
                source: command.source,
              }
            : (command.disposition ?? old.disposition),
      };
      break;
    }
  }
  if (record) {
    validateRecord(record);
  }
  const changed = generation !== previous?.generation || !isDeepStrictEqual(old ?? null, record);
  const work: ProgressWorkState = {
    generation,
    revision: (previous?.revision ?? 0) + (changed ? 1 : 0),
    record,
    lastCommand: { id, fingerprint },
  };
  let next: ProgressAggregate = {
    ...current,
    revision: current?.revision ?? 0,
    updatedAt: current?.updatedAt ?? now,
    work,
  };
  if (command.display === "replace") {
    next = {
      revision: next.revision,
      updatedAt: next.updatedAt,
      work,
      ...(normalized.markdown ? { markdown: normalized.markdown } : {}),
      ...(normalized.steps
        ? record
          ? { checklist: "work" }
          : { checklist: "independent", steps: normalized.steps }
        : {}),
    };
  } else if (current?.checklist === "work" && !record) {
    next = { ...next, checklist: "independent", steps: old?.steps };
  }
  const before = current && {
    markdown: current.markdown,
    checklist: current.checklist,
    steps: presentSessionProgress(command.owner.sessionKey, current)?.steps,
  };
  const after = {
    markdown: next.markdown,
    checklist: next.checklist,
    steps: presentSessionProgress(command.owner.sessionKey, next)?.steps,
  };
  if (!isDeepStrictEqual(before, after)) {
    next = { ...next, revision: next.revision + 1, updatedAt: now };
  }
  return next;
}

/** Only the lifecycle owner may carry a task into its verified successor incarnation. */
export function transferProgressWork(
  state: ProgressAggregate,
  previous: ProgressOwner,
  next: ProgressOwner,
): ProgressAggregate {
  const work = state.work;
  if (!work?.record) {
    return state;
  }
  if (!isDeepStrictEqual(work.record.owner, previous)) {
    throw new ProgressCardInputError("Progress work reset source changed");
  }
  return {
    ...state,
    work: {
      generation: work.generation,
      revision: work.revision + 1,
      record: { ...work.record, owner: next },
    },
  };
}

export function retireProgressWork(state: ProgressAggregate, now: number): ProgressAggregate {
  if (!state.work?.record) {
    return state;
  }
  return {
    ...state,
    ...(state.checklist === "work"
      ? {
          checklist: "independent",
          steps: state.work.record.steps,
          revision: state.revision + 1,
          updatedAt: now,
        }
      : {}),
    work: { generation: state.work.generation, revision: state.work.revision + 1, record: null },
  };
}
