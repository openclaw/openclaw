import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { closedObject } from "../../packages/gateway-protocol/src/schema/closed-object.js";
import { ProgressCardPutParamsSchema } from "../../packages/gateway-protocol/src/schema/progress-card.js";
import { normalizeProgressCardInput, ProgressCardInputError } from "./progress-card-input.js";
import type {
  ProgressOwner,
  WorkSource,
  WorkFence,
  ProgressWorkState,
  ProgressWorkCommand,
  AcceptedWaitReference,
} from "./progress-card-work.js";

const text = Type.String({ minLength: 1, maxLength: 512 });
export const ProgressWorkIntentSchema = Type.Union([
  closedObject({
    action: Type.Union([Type.Literal("begin"), Type.Literal("replace")]),
    scope: text,
  }),
  closedObject({
    action: Type.Literal("reconcile"),
    disposition: Type.Optional(Type.Union([Type.Literal("actionable"), Type.Literal("completed")])),
  }),
  closedObject({ action: Type.Literal("paused-blocked"), reason: text, resumeCondition: text }),
  closedObject({ action: Type.Literal("retire") }),
]);
export type ProgressWorkIntent = Static<typeof ProgressWorkIntentSchema>;
export const ProgressReconcileParamsSchema = closedObject({
  ...Type.Omit(ProgressCardPutParamsSchema, ["expectedRevision"]).properties,
  work: Type.Optional(ProgressWorkIntentSchema),
});
export type ProgressReconcileParams = Static<typeof ProgressReconcileParamsSchema>;
export type ProgressWorkCustody = {
  owner: ProgressOwner;
  source: WorkSource;
  expected: WorkFence | null;
  /** Native producer evidence, never a model or serialized RPC field. */
  acceptedWait?: { receipt: AcceptedWaitReference; resumeCondition: string };
};
export type WorkCoverage =
  | { kind: "covered"; basis: "bounded-no-handoff" }
  | { kind: "unavailable"; reason: string };
export type WorkSnapshot =
  | { kind: "none" }
  | { kind: "retained"; state: ProgressWorkState; coverage?: WorkCoverage }
  | { kind: "unavailable"; reason: string };

export function normalizeProgressWorkIntent(value: unknown): ProgressWorkIntent | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Check(ProgressWorkIntentSchema, value)) {
    throw new ProgressCardInputError("Invalid explicit work intent");
  }
  const normalize = (step: string) =>
    normalizeProgressCardInput({ plan: [{ step, status: "pending" }] }).steps![0]!.step;
  if (value.action === "begin" || value.action === "replace") {
    return { ...value, scope: normalize(value.scope) };
  }
  if (value.action === "paused-blocked") {
    return {
      ...value,
      reason: normalize(value.reason),
      resumeCondition: normalize(value.resumeCondition),
    };
  }
  return value;
}

/** Select semantics inside the existing aggregate transaction, not from displayed steps. */
export function progressWorkCommandForIntent(
  custody: ProgressWorkCustody,
  intent: ProgressWorkIntent | undefined,
  steps: ReturnType<typeof normalizeProgressCardInput>["steps"],
): ProgressWorkCommand | undefined {
  const base = {
    ...custody,
    display: "replace" as const,
  };
  if (custody.acceptedWait) {
    return { ...custody, kind: "observe-wait", ...custody.acceptedWait };
  }
  if (!intent && !steps) {
    return undefined;
  }
  if (!intent && custody.expected === null) {
    return { ...base, kind: "begin", scope: steps![0]!.step };
  }
  if (!intent) {
    return { ...base, kind: "reconcile" };
  }
  switch (intent.action) {
    case "begin":
    case "replace":
      return { ...base, kind: intent.action, scope: intent.scope };
    case "retire":
      return { ...base, kind: "retire" };
    case "paused-blocked":
      return {
        ...base,
        kind: "reconcile",
        disposition: {
          kind: "paused-blocked",
          reason: intent.reason,
          resumeCondition: intent.resumeCondition,
          source: custody.source,
        },
      };
    case "reconcile":
      return {
        ...base,
        kind: "reconcile",
        ...(intent.disposition
          ? {
              disposition:
                intent.disposition === "completed"
                  ? { kind: "completed" as const, source: custody.source }
                  : { kind: "actionable" as const },
            }
          : {}),
      };
  }
  return undefined;
}
