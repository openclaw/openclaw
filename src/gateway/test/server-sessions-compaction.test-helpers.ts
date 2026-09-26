import fsSync from "node:fs";
import path from "node:path";
import type { AssistantMessage, UserMessage } from "openclaw/plugin-sdk/llm";
import { expect } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { createZeroUsageFixture } from "../../agents/test-helpers/usage-fixtures.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  loadTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
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

function buildSessionTranscriptLines(sessionId: string, totalLines: number): string[] {
  const header = JSON.stringify({
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: "2026-06-19T12:00:00.000Z",
    cwd: "/tmp",
  });
  const entries = Array.from({ length: Math.max(0, totalLines - 1) }, (_, index) =>
    JSON.stringify({
      type: "message",
      id: `entry-${index}`,
      parentId: index === 0 ? null : `entry-${index - 1}`,
      timestamp: `2026-06-19T12:00:${String(index % 60).padStart(2, "0")}.000Z`,
      message: { role: "user", content: `line-${index}`, timestamp: index },
    }),
  );
  return [header, ...entries];
}

export async function seedTranscriptRows(params: {
  agentId?: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  totalLines: number;
}): Promise<void> {
  const scope = {
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  };
  if (params.totalLines <= 0) {
    return;
  }
  const header = JSON.parse(buildSessionTranscriptLines(params.sessionId, 1)[0] ?? "{}");
  await appendTranscriptEvent(scope, header);
  for (let index = 0; index < params.totalLines - 1; index += 1) {
    await appendTranscriptMessage(scope, {
      cwd: "/tmp",
      message: {
        role: "user",
        content: `line-${index}`,
        timestamp: index,
      },
      now: Date.parse(`2026-06-19T12:00:${String(index % 60).padStart(2, "0")}.000Z`),
    });
  }
}

export async function loadTranscriptRows(params: {
  agentId?: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<Array<Record<string, unknown>>> {
  const rows = await loadTranscriptEvents({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  });
  return rows.map((row) =>
    row && typeof row === "object" && !Array.isArray(row) ? (row as Record<string, unknown>) : {},
  );
}
