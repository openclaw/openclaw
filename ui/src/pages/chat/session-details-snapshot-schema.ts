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
            result: json.object({
              summary: json.optional(json.text),
              checkedAt: json.optional(nonnegative),
              failed: json.optional(json.boolean),
            }),
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
