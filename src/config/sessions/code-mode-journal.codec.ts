import { z } from "zod";
import {
  CODE_MODE_JOURNAL_LIMITS as limits,
  CODE_MODE_JOURNAL_VERSION,
  type CodeModeJournal,
} from "./code-mode-journal.types.js";

const id = z.string().min(1).max(512);
export const codeModeJournalJson = z.string().superRefine((value, ctx) => {
  // Include string escaping in the budget: the journal stores exact JSON text inside JSON.
  if (Buffer.byteLength(JSON.stringify(value)) > limits.jsonValueBytes) {
    ctx.addIssue({ code: "custom", message: "Code Mode journal JSON exceeds byte limit" });
    return;
  }
  try {
    JSON.parse(value);
  } catch {
    ctx.addIssue({ code: "custom", message: "Code Mode journal requires valid JSON" });
  }
});
export const codeModeJournalKeySchema = z.object({
  sessionKey: id,
  sessionId: id,
  executionId: id,
});
export const codeModeJournalStartSchema = codeModeJournalKeySchema
  .extend({
    version: z.literal(CODE_MODE_JOURNAL_VERSION),
    runId: id,
    toolCallId: id,
    source: z.object({ version: z.literal(1), sourceJson: codeModeJournalJson }).strict(),
    programJson: codeModeJournalJson,
  })
  .strict();
export const codeModeJournalIntentSchema = z
  .object({
    key: id,
    operationId: id,
    name: id,
    argsJson: codeModeJournalJson,
    recovery: z.enum(["interrupt", "safe", "reconcile"]),
  })
  .strict();
const callSchema = z.discriminatedUnion("state", [
  codeModeJournalIntentSchema.extend({ state: z.literal("pending") }),
  codeModeJournalIntentSchema.extend({
    state: z.literal("completed"),
    resultJson: codeModeJournalJson,
    deliveryIndex: z.number().int().nonnegative(),
    issuedCalls: z.number().int().nonnegative().max(limits.callsPerExecution),
  }),
]);
export const codeModeJournalOutcomeSchema = z
  .object({
    resultJson: codeModeJournalJson,
    storeJson: codeModeJournalJson,
  })
  .strict();
const journalSchema = codeModeJournalStartSchema
  .extend({
    calls: z.array(callSchema).max(limits.callsPerExecution),
    outcome: codeModeJournalOutcomeSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const completed = value.calls.filter((call) => call.state === "completed");
    const deliveries = completed.map((call) => call.deliveryIndex).sort((a, b) => a - b);
    if (
      new Set(value.calls.map((call) => call.key)).size !== value.calls.length ||
      new Set(value.calls.map((call) => call.operationId)).size !== value.calls.length ||
      deliveries.some((index, i) => index !== i) ||
      completed.some((call) => call.issuedCalls > value.calls.length)
    ) {
      ctx.addIssue({ code: "custom", message: "Invalid Code Mode journal call ordering" });
    }
  });
export function decodeCodeModeJournal(json: string): CodeModeJournal {
  if (Buffer.byteLength(json) > limits.recordBytes) {
    throw new Error("Code Mode journal exceeds byte limit");
  }
  // Zod errors can include data; never expose persisted source or tool content in diagnostics.
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("Unsupported or invalid Code Mode journal; preserve it for recovery");
  }
  const result = journalSchema.safeParse(value);
  if (!result.success) {
    throw new Error("Unsupported or invalid Code Mode journal; preserve it for recovery");
  }
  return result.data;
}
export function encodeCodeModeJournal(journal: CodeModeJournal): string {
  const json = JSON.stringify(journal);
  const max = journal.outcome ? limits.recordBytes : limits.activeRecordBytes;
  if (Buffer.byteLength(json) > max) {
    throw new Error("Code Mode journal exceeds byte limit; no checkpoint was changed");
  }
  return json;
}
