import fsSync from "node:fs";
import path from "node:path";
import type { AssistantMessage, UserMessage } from "openclaw/plugin-sdk/llm";
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

export function holdCompaction(result: HeldCompactionResult) {
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

function writeSessionFixture(
  sessionFile: string,
  session: { getPersistedEntries(): unknown[] },
): void {
  const contents = session
    .getPersistedEntries()
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  fsSync.writeFileSync(sessionFile, `${contents}\n`, "utf8");
}

export async function createCompactedSessionFixture(dir: string) {
  const { SessionManager } = await getSessionManagerModule();
  const session = SessionManager.inMemory(dir);
  const userMessage: UserMessage = {
    role: "user",
    content: "before compaction",
    timestamp: Date.now(),
  };
  const assistantMessage: AssistantMessage = makeAgentAssistantMessage({
    content: [{ type: "text", text: "working on it" }],
    api: "responses",
    model: "gpt-test",
    usage: {
      ...createZeroUsageFixture(),
      input: 1,
      output: 1,
      totalTokens: 2,
    },
    timestamp: Date.now(),
  });
  session.appendMessage(userMessage);
  session.appendMessage(assistantMessage);
  const preCompactionLeafId = session.getLeafId();
  if (!preCompactionLeafId) {
    throw new Error("expected persisted session leaf before compaction");
  }
  const sessionFile = path.join(dir, `${session.getSessionId()}.jsonl`);
  writeSessionFixture(sessionFile, session);
  session.appendCompaction("compaction summary", preCompactionLeafId, 123, { ok: true });
  const postCompactionLeafId = session.getLeafId();
  if (!postCompactionLeafId) {
    throw new Error("expected post-compaction leaf");
  }
  writeSessionFixture(sessionFile, session);
  return {
    session,
    sessionId: session.getSessionId(),
    sessionFile,
    preCompactionLeafId,
    postCompactionLeafId,
  };
}
