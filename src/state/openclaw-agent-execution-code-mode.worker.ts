import type {
  CodeModeJournalStart,
  CodeModeJournalKey,
  CodeModeJournalCallIntent,
  CodeModeJournalCallCompletion,
  CodeModeJournal,
} from "../config/sessions/code-mode-journal.types.js";
import type { AgentWorkerOperationContext } from "./openclaw-agent-operation-context.js";
import type { WorkerOperationHandlers } from "./worker-operation-registry.js";

type Handlers = WorkerOperationHandlers<AgentWorkerOperationContext>;
export async function loadCodeModeJournalOperations() {
  const kernel = await import("../config/sessions/code-mode-journal.kernel.js");
  return {
    "codeModeJournal.read": (input: CodeModeJournalKey, { open, admit }) => {
      admit("prepare");
      return kernel.readCodeModeJournalInDatabase(open().db, input);
    },
    "codeModeJournal.list": (
      input: Pick<CodeModeJournalKey, "sessionKey" | "sessionId">,
      { open, admit },
    ) => {
      admit("prepare");
      return kernel.listCodeModeJournalsInDatabase(open().db, input);
    },
    "codeModeJournal.begin": (input: CodeModeJournalStart, { writeTransaction, admit }) =>
      writeTransaction("code-mode-journal.begin", "Code Mode journal", ({ db }) => {
        const result = kernel.beginCodeModeJournalInDatabase(db, input);
        admit("commit");
        return result;
      }),
    "codeModeJournal.call": (
      input: { key: CodeModeJournalKey; intent: CodeModeJournalCallIntent },
      { writeTransaction, admit },
    ) =>
      writeTransaction("code-mode-journal.call", "Code Mode journal", ({ db }) => {
        const result = kernel.recordCodeModeCallInDatabase(db, input.key, input.intent);
        admit("commit");
        return result;
      }),
    "codeModeJournal.completeCall": (
      input: CodeModeJournalCallCompletion,
      { writeTransaction, admit },
    ) =>
      writeTransaction("code-mode-journal.complete-call", "Code Mode journal", ({ db }) => {
        const result = kernel.completeCodeModeCallInDatabase(db, input);
        admit("commit");
        return result;
      }),
    "codeModeJournal.finish": (
      input: { key: CodeModeJournalKey; outcome: NonNullable<CodeModeJournal["outcome"]> },
      { writeTransaction, admit },
    ) =>
      writeTransaction("code-mode-journal.finish", "Code Mode journal", ({ db }) => {
        const result = kernel.finishCodeModeJournalInDatabase(db, input.key, input.outcome);
        admit("commit");
        return result;
      }),
  } satisfies Handlers;
}
