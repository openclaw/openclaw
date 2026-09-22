import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { resetSessionEntryLifecycle } from "../config/sessions/session-accessor.js";
import { appendExactAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import {
  emitSessionTranscriptUpdate,
  onInternalSessionTranscriptUpdate,
  type InternalSessionTranscriptUpdate,
} from "../sessions/transcript-events.js";
import { readSseEvent } from "./session-history-fixtures.test-support.js";
import { testState } from "./test-helpers.runtime-state.js";
import {
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  writeSessionStore,
} from "./test-helpers.server.js";

const sessionKey = "agent:main:main";
const sessionId = "shared-logical-history-id";
const headers = {
  authorization: "Bearer test-gateway-token-1234567890",
  "x-openclaw-scopes": "operator.read",
};

function assistantMessage(text: string) {
  return makeAgentAssistantMessage({ content: [{ type: "text", text }] });
}

async function appendMessage(storePath: string, text: string, key = sessionKey) {
  const result = await appendExactAssistantMessageToSessionTranscript({
    agentId: "main",
    sessionKey: key,
    storePath,
    message: assistantMessage(text),
  });
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.messageId;
}

describe("session history SSE source ownership", () => {
  installGatewayTestHooks();
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  test.each(["physical store", "canonical key", "lifecycle revision", "lifecycle owner"] as const)(
    "does not publish inline payloads from a different %s",
    async (mismatch) => {
      // Reserved sentinels keep their physical owners across multiple stores.
      const requestedKey = mismatch === "physical store" ? "global" : sessionKey;
      const root = tempDirs.make("openclaw-history-source-");
      const storePath = path.join(root, "bound", "sessions.json");
      const otherStorePath = path.join(root, "other", "sessions.json");
      testState.sessionStorePath = storePath;
      await writeSessionStore({
        storePath,
        entries: {
          [requestedKey]: { sessionId, updatedAt: 1, lifecycleRevision: "copied-history-owner" },
        },
      });
      if (mismatch === "physical store") {
        await writeSessionStore({
          storePath: otherStorePath,
          entries: {
            [requestedKey]: { sessionId, updatedAt: 1, lifecycleRevision: "copied-history-owner" },
          },
        });
        await appendMessage(otherStorePath, "other store first row", requestedKey);
        await appendMessage(otherStorePath, "other store second row", requestedKey);
      }
      const committed: InternalSessionTranscriptUpdate[] = [];
      const unsubscribe = onInternalSessionTranscriptUpdate((update) => committed.push(update));
      let initialId: string;
      try {
        initialId = await appendMessage(storePath, "bound initial message", requestedKey);
      } finally {
        unsubscribe();
      }
      const initialUpdate = committed.find((update) => update.messageId === initialId);
      if (!initialUpdate?.target || initialUpdate.messageSeq === undefined) {
        throw new Error("expected the committed inline transcript update");
      }
      const harness = await createGatewaySuiteHarness();
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const abort = new AbortController();
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const url = `http://127.0.0.1:${harness.port}/sessions/${encodeURIComponent(requestedKey)}/history`;
        const response = await fetch(url, {
          headers: { ...headers, accept: "text/event-stream" },
          signal: abort.signal,
        });
        expect(response.status).toBe(200);
        reader = response.body?.getReader();
        if (!reader) {
          throw new Error("expected the session history event stream");
        }
        const stream = { buffer: "" };
        const initial = await readSseEvent(reader, stream);
        expect(initial.event).toBe("history");
        expect(initial.data).toMatchObject({
          messages: [{ content: [{ text: "bound initial message" }] }],
        });
        if (mismatch === "lifecycle owner") {
          const reset = await resetSessionEntryLifecycle({
            agentId: "main",
            storePath,
            target: { canonicalKey: requestedKey, storeKeys: [requestedKey] },
            resetBoundary: { context: "clear", reason: "reset", cwd: root },
            buildNextEntry: ({ currentEntry }) => {
              if (!currentEntry) {
                throw new Error("expected the current lifecycle owner");
              }
              return {
                ...currentEntry,
                lifecycleRevision: "after-reset",
                updatedAt: currentEntry.updatedAt + 1,
              };
            },
          });
          expect(reset.nextEntry.sessionId).toBe(sessionId);
          // The old stream must close on the committed replacement, before its 15-second heartbeat.
          deadline = setTimeout(
            () => abort.abort(new Error("old history stream waited for its heartbeat")),
            5_000,
          );
          const replacementText = "replacement lifecycle message";
          const appended = await appendExactAssistantMessageToSessionTranscript({
            agentId: "main",
            sessionKey: requestedKey,
            storePath,
            expectedSessionId: sessionId,
            expectedLifecycleRevision: "after-reset",
            message: assistantMessage(replacementText),
          });
          expect(appended.ok).toBe(true);
          let remaining = stream.buffer;
          const decoder = new TextDecoder();
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) {
              break;
            }
            remaining += decoder.decode(chunk.value, { stream: true });
          }
          expect(remaining).not.toContain(replacementText);
          clearTimeout(deadline);
          const current = await fetch(url, { headers });
          expect(current.status).toBe(200);
          expect(JSON.stringify(await current.json())).toContain(replacementText);
          return;
        }
        const foreignText = `unrelated payload from ${mismatch}`;
        if (mismatch === "physical store") {
          const updates: InternalSessionTranscriptUpdate[] = [];
          const stop = onInternalSessionTranscriptUpdate((update) => updates.push(update));
          let foreignId: string;
          try {
            foreignId = await appendMessage(otherStorePath, foreignText, requestedKey);
          } finally {
            stop();
          }
          const foreignUpdate = updates.find((update) => update.messageId === foreignId);
          expect(foreignUpdate).toMatchObject({
            target: {
              agentId: initialUpdate.target.agentId,
              sessionId: initialUpdate.target.sessionId,
              sessionKey: initialUpdate.target.sessionKey,
            },
            lifecycleRevision: "copied-history-owner",
          });
          expect(initialUpdate.lifecycleRevision).toBe("copied-history-owner");
          expect(initialUpdate.target.storePath).toBeTypeOf("string");
          expect(foreignUpdate?.target?.storePath).toBeTypeOf("string");
          expect(foreignUpdate?.target?.storePath).not.toBe(initialUpdate.target.storePath);
          expect(foreignUpdate?.messageSeq).toBeGreaterThan(initialUpdate.messageSeq);
        } else {
          emitSessionTranscriptUpdate({
            ...initialUpdate,
            ...(mismatch === "canonical key"
              ? {
                  sessionKey: "agent:main:other",
                  target: { ...initialUpdate.target, sessionKey: "agent:main:other" },
                }
              : { lifecycleRevision: `${initialUpdate.lifecycleRevision ?? "owner"}-retired` }),
            message: assistantMessage(foreignText),
            messageId: "unrelated-message",
            messageSeq: initialUpdate.messageSeq + 1,
          });
        }
        const visibleText = "bound message after unrelated update";
        await appendMessage(storePath, visibleText, requestedKey);
        // The committed bound append is an ordering barrier, so no quiet-period timer is needed.
        while (true) {
          const event = await readSseEvent(reader, stream);
          const serialized = JSON.stringify(event.data);
          expect(serialized).not.toContain(foreignText);
          if (serialized.includes(visibleText)) {
            break;
          }
        }
        const history = await fetch(url, { headers });
        expect(history.status).toBe(200);
        expect(await history.json()).toMatchObject({
          messages: [
            { content: [{ text: "bound initial message" }] },
            { content: [{ text: visibleText }] },
          ],
        });
      } finally {
        clearTimeout(deadline);
        try {
          await reader?.cancel();
        } finally {
          await harness.close();
        }
      }
    },
  );
});
