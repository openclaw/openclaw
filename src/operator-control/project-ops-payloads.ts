import { z } from "zod";

const DIRECT_UPDATE_ALLOWED_FIELDS = ["item_url", "itemUrl", "set", "clear"] as const;
const PROJECT_OPS_TASK_HINT_FIELDS = [
  "task_id",
  "objective",
  "capability",
  "acceptance_criteria",
  "requester",
] as const;
const TASK_LIFECYCLE_HINT_FIELDS = ["task_id", "run_id", "state", "reason", "updated_at"] as const;

const projectOpsUpdateSchema = z
  .object({
    item_url: z.string().trim().min(1).optional(),
    itemUrl: z.string().trim().min(1).optional(),
    set: z.record(z.string(), z.unknown()).optional(),
    clear: z.array(z.string().trim().min(1)).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const itemUrl = value.item_url?.trim() || value.itemUrl?.trim();
    if (!itemUrl) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Project-ops update requires item_url or itemUrl.",
        path: ["item_url"],
      });
    }
  });

export type ProjectOpsUpdatePayload = {
  item_url: string;
  set: Record<string, unknown>;
  clear: string[];
};

type ClassifiedProjectOpsUpdatePayload =
  | {
      kind: "item-mutation";
      payload: ProjectOpsUpdatePayload;
    }
  | {
      kind: "project-ops-task";
      message: string;
    }
  | {
      kind: "task-lifecycle";
      message: string;
    }
  | {
      kind: "invalid";
      message: string;
    };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasAnyField(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => key in record);
}

function listUnknownFields(record: Record<string, unknown>): string[] {
  return Object.keys(record)
    .filter(
      (key) =>
        !DIRECT_UPDATE_ALLOWED_FIELDS.includes(
          key as (typeof DIRECT_UPDATE_ALLOWED_FIELDS)[number],
        ),
    )
    .toSorted((left, right) => left.localeCompare(right));
}

export function classifyProjectOpsUpdatePayload(
  payload: unknown,
): ClassifiedProjectOpsUpdatePayload {
  const record = asRecord(payload);
  if (!record) {
    return {
      kind: "invalid",
      message: "Project-ops update requires a JSON object body.",
    };
  }

  if (record.schema === "PawAndOrderTaskV1") {
    return {
      kind: "project-ops-task",
      message:
        "Project-ops update only accepts { item_url, set, clear }. Send PawAndOrderTaskV1 payloads to /project-ops/task instead.",
    };
  }

  if (record.schema === "DebOperatorTaskSyncV1") {
    return {
      kind: "task-lifecycle",
      message:
        "Project-ops update only accepts { item_url, set, clear }. Send DebOperatorTaskSyncV1 payloads to /project-ops/operator/events instead.",
    };
  }

  if (hasAnyField(record, TASK_LIFECYCLE_HINT_FIELDS) && "state" in record && "run_id" in record) {
    return {
      kind: "task-lifecycle",
      message:
        "Project-ops update only accepts { item_url, set, clear }. This payload looks like a task lifecycle event; send it to /project-ops/operator/events instead.",
    };
  }

  if (hasAnyField(record, PROJECT_OPS_TASK_HINT_FIELDS)) {
    return {
      kind: "project-ops-task",
      message:
        "Project-ops update only accepts { item_url, set, clear }. This payload looks like a project-ops task; send it to /project-ops/task instead.",
    };
  }

  const parsed = projectOpsUpdateSchema.safeParse(record);
  if (parsed.success) {
    return {
      kind: "item-mutation",
      payload: {
        item_url: parsed.data.item_url?.trim() || parsed.data.itemUrl?.trim() || "",
        set: parsed.data.set ?? {},
        clear: parsed.data.clear ?? [],
      },
    };
  }

  const unknownFields = listUnknownFields(record);
  const unknownFieldText =
    unknownFields.length > 0 ? ` Unmapped fields: ${unknownFields.join(", ")}.` : "";
  return {
    kind: "invalid",
    message: `Project-ops update only accepts { item_url, set, clear }.${unknownFieldText}`.trim(),
  };
}

export function parseProjectOpsUpdatePayload(payload: unknown): ProjectOpsUpdatePayload {
  const classified = classifyProjectOpsUpdatePayload(payload);
  if (classified.kind === "item-mutation") {
    return classified.payload;
  }
  throw new Error(classified.message);
}
