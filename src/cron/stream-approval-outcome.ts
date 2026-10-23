import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

/** An ended proposal is a recorded non-mutation, never execution authority. */
export const CronStreamApprovalEndedSchema = Type.Object(
  {
    code: Type.Literal("CRON_STREAM_APPROVAL_ENDED"),
    saved: Type.Literal(false),
    action: Type.Union([Type.Literal("add"), Type.Literal("update")]),
    approvalId: Type.String({ minLength: 1 }),
    outcome: Type.Union([
      Type.Literal("operator-denied"),
      Type.Literal("expired"),
      Type.Literal("cancelled"),
    ]),
    message: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export type CronStreamApprovalEnded = Static<typeof CronStreamApprovalEndedSchema>;

export function readCronStreamApprovalEnded(value: unknown): CronStreamApprovalEnded | undefined {
  return Value.Check(CronStreamApprovalEndedSchema, value) ? value : undefined;
}

export class CronStreamApprovalEndedError extends Error {
  readonly details: CronStreamApprovalEnded;

  constructor(params: Pick<CronStreamApprovalEnded, "action" | "approvalId" | "outcome">) {
    const decision =
      params.outcome === "operator-denied"
        ? "An operator declined this watcher proposal."
        : params.outcome === "expired"
          ? "The approval request expired."
          : "The approval request was canceled.";
    const effect =
      params.action === "add"
        ? "This proposal did not create or change a watcher."
        : "The requested change was not saved; this proposal left the existing watcher unchanged.";
    const message = `${decision} This approval request is closed and cannot be approved. ${effect} Any further operation must independently satisfy the current permissions and approval settings. This outcome concerns only this proposal; it does not establish a file-access or tool-capability failure or a need to change permissions.`;
    super(message);
    this.name = "CronStreamApprovalEndedError";
    this.details = { code: "CRON_STREAM_APPROVAL_ENDED", saved: false, ...params, message };
  }
}
