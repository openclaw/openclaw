import { isSessionParticipantIdentity } from "../../../../packages/gateway-protocol/src/compiled/sender-identity.js";
import * as json from "../../lib/snapshot-json.ts";

const nonnegative = json.refine(json.number, (value) => value >= 0);
const optionalNonnegative = json.optional(nonnegative);
const optionalText = json.optional(json.text);
const sessionKeySchema = json.refine(json.text, (value) => value.length > 0);
const subagentStatus = json.enumeration([
  "queued",
  "running",
  "waiting",
  "done",
  "failed",
  "stopped",
]);

export const detailsSnapshotSchema = json.optional(
  json.object({
    locale: json.text,
    docking: json.optional(json.object({ layout: json.text, wide: json.boolean })),
    session: json.optional(
      json.object({
        createdActor: json.optional(
          json.object({
            type: json.enumeration(["human", "agent", "system"]),
            id: optionalText,
            label: optionalText,
            avatarUrl: optionalText,
            identity: json.optional(json.checked(isSessionParticipantIdentity)),
          }),
        ),
        participantCount: optionalNonnegative,
      }),
    ),
    environment: json.optional(json.object({ branch: optionalText, worktree: json.boolean })),
    progress: json.optional(
      json.object({
        revision: nonnegative,
        updatedAt: nonnegative,
        sessionStatus: json.optional(
          json.enumeration([
            "queued",
            "running",
            "done",
            "failed",
            "interrupted",
            "killed",
            "timeout",
          ]),
        ),
        startedAt: optionalNonnegative,
        endedAt: optionalNonnegative,
        hasActiveRun: json.optional(json.boolean),
        runtime: json.object({
          known: json.optional(json.boolean),
          connected: json.optional(json.boolean),
          hasActiveSubagentRun: json.optional(json.boolean),
          lastRunError: optionalText,
          childError: optionalText,
          children: json.optional(
            json.object({
              running: nonnegative,
              queued: nonnegative,
              waiting: nonnegative,
              failed: nonnegative,
              stopped: optionalNonnegative,
            }),
          ),
        }),
      }),
    ),
    subagents: json.optional(
      json.object({
        total: nonnegative,
        rows: json.array(
          json.object({
            key: sessionKeySchema,
            label: json.text,
            status: subagentStatus,
            listed: json.optional(json.boolean),
            activity: optionalText,
            progress: json.optional(json.object({ completed: nonnegative, total: nonnegative })),
            session: json.optional(
              json.object({
                startedAt: optionalNonnegative,
                endedAt: optionalNonnegative,
              }),
            ),
          }),
          8,
        ),
        counts: json.array(
          json.object({
            status: subagentStatus,
            count: nonnegative,
            listed: json.optional(json.boolean),
          }),
          8,
        ),
      }),
    ),
    automations: json.optional(
      json.object({
        rows: json.array(
          json.object({
            id: sessionKeySchema,
            name: json.text,
            disabled: json.optional(json.boolean),
            autoDisabled: json.optional(json.boolean),
            running: json.optional(json.boolean),
            state: json.text,
            nextRunAtMs: json.optional(json.nullable(nonnegative)),
          }),
          10,
        ),
        more: json.boolean,
      }),
    ),
    outputs: optionalNonnegative,
    processes: json.optional(
      json.object({
        total: nonnegative,
        rows: json.array(
          json.object({
            processId: sessionKeySchema,
            instanceId: sessionKeySchema,
            name: json.text,
          }),
          3,
        ),
      }),
    ),
  }),
);

export type ChatDetailsSnapshot = NonNullable<json.SnapshotValue<typeof detailsSnapshotSchema>>;
