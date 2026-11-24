import path from "node:path";
import { expect } from "vitest";
import { withSessionCompactionPersistenceAsync } from "../../agents/sessions/session-compaction-persistence.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  loadTranscriptEvents,
  persistCompactionBoundaryWithSessionEntryAsync,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";
import { readSessionEntryReadOnlyInWorker } from "./session-entry-read-runtime.js";

export async function assertCompactionPathAlias(
  alias: SessionTranscriptRuntimeTarget & { env: NodeJS.ProcessEnv },
  canonical: SessionTranscriptRuntimeTarget & { env: NodeJS.ProcessEnv },
  refusal?: "different store" | "changed writer",
) {
  // The writer control must reach the claim guard even before alias handling is repaired.
  const scope = refusal === "changed writer" ? canonical : alias;
  await upsertSessionEntryCore(scope, {
    sessionId: scope.sessionId,
    updatedAt: 1,
    compactionCount: 0,
    lifecycleRevision: "compaction-lifecycle",
    activeWriterRunId: "compaction-writer",
  });
  const manager = await SessionManager.openAsync(scope, path.dirname(scope.storePath));
  const keptId = await manager.appendMessageAsync({ role: "user", content: "keep", timestamp: 1 });
  expect(keptId).toBeTypeOf("string");
  const before = await loadTranscriptEvents(canonical);
  const otherStore = {
    ...scope,
    storePath: path.join(path.dirname(scope.storePath), "other.sqlite"),
  };
  if (refusal === "different store") {
    await upsertSessionEntryCore(otherStore, { sessionId: scope.sessionId, updatedAt: 1 });
  } else if (refusal === "changed writer") {
    await upsertSessionEntryCore(scope, { activeWriterRunId: "replacement-writer" });
  }
  const pending = withSessionCompactionPersistenceAsync(
    manager,
    (prepared) =>
      persistCompactionBoundaryWithSessionEntryAsync(
        {
          ...scope,
          expectedLifecycleRevision: "compaction-lifecycle",
          expectedWriterRunId: "compaction-writer",
        },
        {
          prepared: refusal === "different store" ? { ...prepared, scope: otherStore } : prepared,
          transcriptByteCompactionLatch: null,
        },
      ),
    () => manager.appendCompactionAsync("summary", keptId!, 100),
  );
  if (refusal) {
    if (refusal === "changed writer") {
      await expect(pending).rejects.toMatchObject({ cause: { code: "session-rebound" } });
    } else {
      await expect(pending).rejects.toThrow("session writer claim changed");
    }
    expect(await loadTranscriptEvents(canonical)).toEqual(before);
    expect(await readSessionEntryReadOnlyInWorker(canonical)).toMatchObject({
      compactionCount: 0,
      activeWriterRunId: refusal === "changed writer" ? "replacement-writer" : "compaction-writer",
    });
    if (refusal === "different store") {
      expect(await loadTranscriptEvents(otherStore)).toEqual([]);
    }
    return;
  }
  const boundaryId = await pending;
  expect(await readSessionEntryReadOnlyInWorker(canonical)).toMatchObject({
    compactionCount: 1,
  });
  expect((await loadTranscriptEvents(canonical)).at(-1)).toMatchObject({
    id: boundaryId,
    type: "compaction",
    summary: "summary",
  });
}
