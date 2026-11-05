import fsSync from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { embeddedRunMock, createCompactionResult } from "../test-helpers.runtime-state.js";

const getSessionManagerModule = createLazyRuntimeModule(
  () => import("../../agents/sessions/index.js"),
);

type HeldCompactionResult = {
  ok: true;
  compacted: true;
  result: {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    tokensAfter: number;
    sessionId?: string;
  };
};

export function holdCompaction(result: HeldCompactionResult = createCompactionResult()) {
  const entered = createDeferred();
  const terminal = createDeferred<HeldCompactionResult>();
  embeddedRunMock.compactEmbeddedAgentSession.mockImplementationOnce(() => {
    entered.resolve();
    return terminal.promise;
  });
  return {
    release: () => terminal.resolve(result),
    waitForEntry: async (compactResult: Promise<unknown>) => {
      // Admission can outlast waitFor's default; only backend entry makes the held result ready.
      await awaitGateBeforeSettlement(
        entered.promise,
        compactResult,
        "Compaction RPC completed before backend entry",
      );
      expect(embeddedRunMock.compactEmbeddedAgentSession).toHaveBeenCalledTimes(1);
    },
  };
}

export async function createCompactedSessionFixture(dir: string) {
  const { SessionManager } = await getSessionManagerModule();
  const session = SessionManager.inMemory(dir);
  const sessionFile = path.join(dir, `${session.getSessionId()}.jsonl`);
  function persistLeaf(errorMessage: string) {
    const leaf = session.getLeafId();
    if (!leaf) {
      throw new Error(errorMessage);
    }
    const contents = session.getPersistedEntries().map((entry) => JSON.stringify(entry));
    fsSync.writeFileSync(sessionFile, `${contents.join("\n")}\n`, "utf8");
    return leaf;
  }
  await session.appendMessageAsync({
    role: "user",
    content: "before compaction",
    timestamp: Date.now(),
  });
  await session.appendMessageAsync(
    makeAgentAssistantMessage({
      content: [{ type: "text", text: "working on it" }],
    }),
  );
  const preCompactionLeafId = persistLeaf("expected persisted session leaf before compaction");
  await session.appendCompactionAsync("compaction summary", preCompactionLeafId, 123, { ok: true });
  persistLeaf("expected post-compaction leaf");
  return { sessionId: session.getSessionId(), sessionFile };
}
