import { isIncognitoSessionKey } from "../../routing/session-key.js";
import type { AgentDatabaseOperations } from "../../state/openclaw-agent-execution-contract.js";
import { captureOpenClawAgentDatabaseExecutionAsync } from "../../state/openclaw-agent-execution.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import type {
  CodeModeJournal,
  CodeModeJournalStart,
  CodeModeJournalCallIntent,
  CodeModeJournalCallCompletion,
} from "./code-mode-journal.types.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { createSessionWorkerExecutionSource } from "./session-worker-execution-source.js";

export type CodeModeJournalTarget = SessionAccessScope & {
  sessionId: string;
  /** Live caller authority. A stored source assertion never replaces this check. */
  assertCurrent: () => void;
};
type Operation =
  | "codeModeJournal.read"
  | "codeModeJournal.list"
  | "codeModeJournal.begin"
  | "codeModeJournal.call"
  | "codeModeJournal.completeCall"
  | "codeModeJournal.finish";

/** Existing agent worker and writer FIFO, with no native database work on the caller thread. */
export function createCodeModeJournalStore(target: CodeModeJournalTarget) {
  const scope = resolveSqliteScope(target);
  if (isIncognitoSessionKey(scope.sessionKey)) {
    throw new Error("Incognito Code Mode executions cannot use durable storage");
  }
  const options = toDatabaseOptions(scope);
  const sessionId = target.sessionId;
  const assertCurrent = target.assertCurrent;
  const key = (executionId: string) => ({ sessionKey: scope.sessionKey, sessionId, executionId });
  async function execute<Key extends Operation>(
    type: Key,
    input: AgentDatabaseOperations[Key]["input"],
  ): Promise<AgentDatabaseOperations[Key]["output"]> {
    assertCurrent();
    // Worker payloads own their immutable bytes before any queue/admission await.
    const capturedInput = structuredClone(input);
    const execution = await captureOpenClawAgentDatabaseExecutionAsync(options, {}, "inherit");
    const source = createSessionWorkerExecutionSource(
      assertCurrent,
      "Code Mode journal owner changed",
    );
    try {
      return await runOpenClawAgentWorkerWrite(options, async () => {
        await execution.prepare(source);
        const result = await execution.runExisting(source, async (worker) => ({
          value: await worker.execute({ type, input: capturedInput }),
        }));
        if (!result) {
          throw new Error("Code Mode journal database disappeared");
        }
        return result.value;
      });
    } finally {
      await execution.release();
    }
  }
  return {
    read: (executionId: string) => execute("codeModeJournal.read", key(executionId)),
    list: () => execute("codeModeJournal.list", { sessionKey: scope.sessionKey, sessionId }),
    begin: (input: Omit<CodeModeJournalStart, "sessionKey" | "sessionId">) =>
      execute("codeModeJournal.begin", { ...input, ...key(input.executionId) }),
    call: (executionId: string, intent: CodeModeJournalCallIntent) =>
      execute("codeModeJournal.call", { key: key(executionId), intent }),
    completeCall: (
      executionId: string,
      input: Omit<CodeModeJournalCallCompletion, "sessionKey" | "sessionId" | "executionId">,
    ) => execute("codeModeJournal.completeCall", { ...input, ...key(executionId) }),
    finish: (executionId: string, outcome: NonNullable<CodeModeJournal["outcome"]>) =>
      execute("codeModeJournal.finish", { key: key(executionId), outcome }),
  };
}
