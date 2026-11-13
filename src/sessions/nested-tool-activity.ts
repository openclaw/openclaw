import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import { boundedJsonUtf8Bytes } from "../infra/json-utf8-bytes.js";

export const NESTED_TOOL_ACTIVITY_CUSTOM_TYPE = "openclaw.nested-tool.v1";

const omittedResultText = "[Nested tool output omitted: exceeds display limit]";

const correlationId = z.string().min(1).max(1024);
const activityDetails = z
  .object({
    runId: correlationId,
    scopeId: correlationId,
    afterEntryId: correlationId.nullable(),
    startOrder: z.number().int().nonnegative(),
    parentToolCallId: correlationId.optional(),
    toolCallId: correlationId,
    toolName: z.string().min(1).max(256),
    input: z.unknown(),
    result: z.object({ content: z.array(z.unknown()), details: z.unknown().optional() }),
    isError: z.boolean(),
    startedAt: z.number().finite(),
    timestamp: z.number().finite(),
  })
  .strict();
const activitySchema = z.object({
  role: z.literal("custom"),
  customType: z.literal(NESTED_TOOL_ACTIVITY_CUSTOM_TYPE),
  display: z.literal(true),
  excludeFromContext: z.literal(true),
  content: z.literal(""),
  details: activityDetails,
  timestamp: z.number().finite(),
});
let compiledActivitySchema: typeof activitySchema | undefined;

function getActivitySchema() {
  // Ordinary transcript rows never pay the one-time compilation cost.
  return (compiledActivitySchema ??= z.compile(activitySchema));
}

export type NestedToolActivity = z.infer<typeof activitySchema>;

/** Validate correlation slots separately from the payloads that always require redaction. */
export function readNestedToolActivity(value: unknown): NestedToolActivity | undefined {
  if (asOptionalRecord(value)?.customType !== NESTED_TOOL_ACTIVITY_CUSTOM_TYPE) {
    return undefined;
  }
  const parsed = getActivitySchema().safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Reads the run's own activity even after a hidden turn (for example child coordination)
 * cleared its display flag. Display readers keep using readNestedToolActivity.
 */
export function readOwnNestedToolActivity(value: unknown): NestedToolActivity | undefined {
  const record = asOptionalRecord(value);
  return readNestedToolActivity(record?.display === false ? { ...record, display: true } : value);
}

/** Keep each terminal activity bounded independently of provider context. */
export function createNestedToolActivity(
  details: Omit<NestedToolActivity["details"], "result"> & { result: unknown },
): NestedToolActivity {
  const input = boundedJsonUtf8Bytes(details.input, 8_192).complete
    ? structuredClone(details.input)
    : "[Nested tool input omitted: exceeds display limit]";
  const result = boundedJsonUtf8Bytes(details.result, 32_768).complete
    ? details.result
    : {
        content: [{ type: "text", text: omittedResultText }],
      };
  return getActivitySchema().parse({
    role: "custom",
    customType: NESTED_TOOL_ACTIVITY_CUSTOM_TYPE,
    display: true,
    excludeFromContext: true,
    content: "",
    details: { ...details, input, result },
    timestamp: details.startedAt,
  });
}

/** Display omission retains no evidence that the invocation finished. */
export function isNestedToolActivityResultOmitted({ details }: NestedToolActivity): boolean {
  const { result } = details;
  const content = asOptionalRecord(result.content[0]);
  return (
    result.details === undefined &&
    result.content.length === 1 &&
    content?.type === "text" &&
    content.text === omittedResultText
  );
}

/** Tool-card content for public history. */
export function nestedToolActivityContent({ details }: NestedToolActivity) {
  const { input, result, ...call } = details;
  return [
    {
      type: "toolCall",
      id: call.toolCallId,
      runId: call.runId,
      name: call.toolName,
      arguments: input,
      parentToolCallId: call.parentToolCallId,
      timestamp: call.startedAt,
    },
    { ...call, ...result, type: "toolResult" },
  ] as const;
}

/** Hooks retain call/result evidence; model snapshots and context engines stay unchanged. */
export function projectNestedToolActivityForHooks(
  messages: readonly unknown[],
  activities: readonly NestedToolActivity[],
): unknown[] {
  return [
    ...messages,
    ...activities.map((activity) => ({
      ...activity,
      // Role/content observers need distinct invocations, not fabricated model turns.
      content: JSON.stringify({
        scopeId: activity.details.scopeId,
        toolCallId: activity.details.toolCallId,
        toolName: activity.details.toolName,
        isError: activity.details.isError,
      }),
    })),
  ];
}
