import fsSync from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { createZeroUsageFixture } from "../../agents/test-helpers/usage-fixtures.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { embeddedRunMock } from "../test-helpers.runtime-state.js";

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

export function holdCompaction(
  result: HeldCompactionResult = {
    ok: true,
    compacted: true,
    result: {
      summary: "summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 120,
      tokensAfter: 80,
    },
  },
) {
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
      await Promise.race([
        entered.promise,
        compactResult.then((response) => {
          throw new Error(
            `Compaction RPC completed before backend entry: ${JSON.stringify(response)}`,
          );
        }),
      ]);
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
      api: "responses",
      model: "gpt-test",
      usage: { ...createZeroUsageFixture(), input: 1, output: 1, totalTokens: 2 },
      timestamp: Date.now(),
    }),
  );
  const preCompactionLeafId = persistLeaf("expected persisted session leaf before compaction");
  await session.appendCompactionAsync("compaction summary", preCompactionLeafId, 123, { ok: true });
  const postCompactionLeafId = persistLeaf("expected post-compaction leaf");
  return {
    session,
    sessionId: session.getSessionId(),
    sessionFile,
    preCompactionLeafId,
    postCompactionLeafId,
  };
}
