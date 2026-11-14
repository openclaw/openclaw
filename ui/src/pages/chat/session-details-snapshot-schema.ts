import { isSessionParticipantIdentity } from "../../../../packages/gateway-protocol/src/compiled/sender-identity.js";
import * as json from "../../lib/snapshot-json.ts";

const nonnegative = json.refine(json.number, (value) => value >= 0);
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
    session: json.optional(
      json.object({
        createdActor: json.optional(
          json.object({
            type: json.enumeration(["human", "agent", "system"]),
            id: json.optional(json.text),
            label: json.optional(json.text),
            avatarUrl: json.optional(json.text),
            identity: json.optional(json.checked(isSessionParticipantIdentity)),
          }),
        ),
        participantCount: json.optional(nonnegative),
      }),
    ),
    environment: json.optional(
      json.object({ branch: json.optional(json.text), worktree: json.boolean }),
    ),
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
        startedAt: json.optional(nonnegative),
        endedAt: json.optional(nonnegative),
        hasActiveRun: json.optional(json.boolean),
        runtime: json.object({
          known: json.optional(json.boolean),
          connected: json.optional(json.boolean),
          hasActiveSubagentRun: json.optional(json.boolean),
          lastRunError: json.optional(json.text),
          childError: json.optional(json.text),
          children: json.optional(
            json.object({
              running: nonnegative,
              queued: nonnegative,
              waiting: nonnegative,
              failed: nonnegative,
              stopped: json.optional(nonnegative),
            }),
          ),
        }),
      }),
    ),
    subagents: json.optional(
      json.object({
        total: nonnegative,
        rows: json.array(
          json.object({ key: sessionKeySchema, label: json.text, status: subagentStatus }),
          5,
        ),
        counts: json.array(json.object({ status: subagentStatus, count: nonnegative }), 5),
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
            timezone: json.optional(json.text),
          }),
          10,
        ),
        more: json.boolean,
      }),
    ),
    outputs: json.optional(nonnegative),
  }),
);

export type ChatDetailsSnapshot = NonNullable<json.SnapshotValue<typeof detailsSnapshotSchema>>;
