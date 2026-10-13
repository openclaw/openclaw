import { ok, type Result } from "@openclaw/normalization-core/result";
import type { SqliteWorkerStore } from "../../infra/sqlite-worker-store.js";
import type {
  SessionTranscriptWriteScope,
  TranscriptAppendRefusal,
} from "./session-accessor.sqlite-contract.js";
import type { TranscriptReportWorkerOperations } from "./session-accessor.sqlite-transcript-reports.types.js";
import type { SessionActorStorageBinding } from "./session-actor-storage-binding.js";
import { readSessionActorStorageResult } from "./session-actor-storage-result.js";
import {
  captureOwnedTranscriptWriteAssertion,
  withOwnedSessionTranscriptWriterFence,
  SessionTranscriptWriterClaimReboundError,
} from "./transcript-write-context.js";

export async function withMemoryReportWorker<T>(
  scope: SessionTranscriptWriteScope,
  binding: SessionActorStorageBinding,
  run: (
    operation: Pick<SqliteWorkerStore<TranscriptReportWorkerOperations>, "execute">,
    assertCurrent: () => void,
    publish: (result: {
      projectionNeedsReconcile: boolean;
      cliHistoryChanged?: boolean;
      sessionEntryChanged?: boolean;
    }) => void,
  ) => Promise<Result<T, TranscriptAppendRefusal>>,
): Promise<Result<T, TranscriptAppendRefusal>> {
  const target = withOwnedSessionTranscriptWriterFence(scope);
  const targetScope = {
    ...target,
    agentId: binding.agentId,
    storePath: binding.path,
    sessionId: target.sessionId ?? binding.actor.snapshot(binding.authority)?.entry?.sessionId,
  };
  if (!targetScope.sessionId) {
    throw new Error("Transcript report requires its selected session window");
  }
  const fenced = { ...targetScope, sessionId: targetScope.sessionId };
  const assertOwned = captureOwnedTranscriptWriteAssertion(fenced);
  const authority = {
    ...binding.authority,
    assertCurrent() {
      binding.authority.assertCurrent();
      binding.actor.assertReadable();
      assertOwned();
    },
  };
  let version:
    | import("./session-transcript-context-version.types.js").SessionTranscriptContextVersion
    | undefined;
  const commit = async <
    Key extends
      | "session.report.assistant"
      | "session.report.abortedPartial"
      | "session.report.append",
  >(
    type: Key,
    input: import("./session-actor-memory-reports-contract.js").SessionActorMemoryReportsWrites[Key]["input"],
  ) => {
    const outcome = await binding.actor.storage!.mutate({ type, input }, authority);
    return readSessionActorStorageResult(outcome);
  };
  const commands: {
    [Key in keyof TranscriptReportWorkerOperations]: (
      input: TranscriptReportWorkerOperations[Key]["input"],
    ) => Promise<TranscriptReportWorkerOperations[Key]["output"]>;
  } = {
    prepare: async (selection) => {
      const selected = await binding.actor.storage!.read(
        { type: "session.report.prepare", input: { scope: fenced, selection } },
        authority,
      );
      if (!selected.ok) {
        return selected;
      }
      version = selected.value.version;
      return ok(selected.value.facts);
    },
    append: (report) => {
      if (!version) {
        throw new Error("Transcript report requires its prepared selection");
      }
      return commit("session.report.append", { scope: fenced, report, version });
    },
    assistant: (report) => commit("session.report.assistant", { scope: fenced, report }),
    abortedPartial: (report) => commit("session.report.abortedPartial", { scope: fenced, report }),
  };
  const result = await run(
    { execute: ({ type, input }) => commands[type](input) },
    () => authority.assertCurrent(),
    () => {},
  );
  if (!result.ok && fenced.expectedWriterRunId !== undefined) {
    throw new SessionTranscriptWriterClaimReboundError(result.error);
  }
  return result;
}
