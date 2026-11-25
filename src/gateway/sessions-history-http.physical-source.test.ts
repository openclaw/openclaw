import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, test } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { resetSessionEntryLifecycle } from "../config/sessions/session-accessor.js";
import {
  emitSessionTranscriptUpdate,
  onInternalSessionTranscriptUpdate,
  type InternalSessionTranscriptUpdate,
} from "../sessions/transcript-events.js";
import { readSseEvent } from "./session-history-fixtures.test-support.js";
import {
  appendHistoryMessage,
  historyStream,
  historyTexts,
  readSessionHistoryBody,
} from "./sessions-history-http-read.test-support.js";
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

async function appendMessage(
  storePath: string,
  text: string,
  key = sessionKey,
  expectedLifecycleRevision?: string,
) {
  const result = await appendHistoryMessage({
    agentId: "main",
    sessionKey: key,
    storePath,
    message: assistantMessage(text),
    ...(expectedLifecycleRevision
      ? { expectedSessionId: sessionId, expectedLifecycleRevision }
      : {}),
  });
  return result.messageId;
}

async function captureAppend(storePath: string, text: string, key: string) {
  const updates: InternalSessionTranscriptUpdate[] = [];
  using _ = {
    [Symbol.dispose]: onInternalSessionTranscriptUpdate((update) => updates.push(update)),
  };
  const id = await appendMessage(storePath, text, key);
  return updates.find((update) => update.messageId === id);
}

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
    const entries = {
      [requestedKey]: { sessionId, updatedAt: 1, lifecycleRevision: "copied-history-owner" },
    };
    await writeSessionStore({ storePath, entries });
    if (mismatch === "physical store") {
      await writeSessionStore({ storePath: otherStorePath, entries });
      await appendMessage(otherStorePath, "other store first row", requestedKey);
      await appendMessage(otherStorePath, "other store second row", requestedKey);
    }
    const initialUpdate = await captureAppend(storePath, "bound initial message", requestedKey);
    if (!initialUpdate?.target || initialUpdate.messageSeq === undefined) {
      throw new Error("expected the committed inline transcript update");
    }
    const harness = await createGatewaySuiteHarness();
    const abort = new AbortController();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const url = `http://127.0.0.1:${harness.port}/sessions/${encodeURIComponent(requestedKey)}/history`;
      const response = await fetch(url, {
        headers: { ...headers, accept: "text/event-stream" },
        signal: abort.signal,
      });
      await using stream = historyStream(response);
      using _ = { [Symbol.dispose]: () => clearTimeout(deadline) };
      const { reader } = stream;
      await stream.expectTexts(["bound initial message"]);
      if (mismatch === "lifecycle owner") {
        const reset = await resetSessionEntryLifecycle({
          agentId: "main",
          storePath,
          target: { canonicalKey: requestedKey, storeKeys: [requestedKey] },
          resetBoundary: { context: "clear", reason: "reset", cwd: root },
          buildNextEntry: ({ currentEntry }) => {
            const current = expectDefined(currentEntry, "current lifecycle owner");
            return {
              ...current,
              lifecycleRevision: "after-reset",
              updatedAt: current.updatedAt + 1,
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
        await appendMessage(storePath, replacementText, requestedKey, "after-reset");
        let remaining = stream.streamState.buffer;
        const decoder = new TextDecoder();
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
          remaining += decoder.decode(chunk.value, { stream: true });
        }
        expect(remaining).not.toContain(replacementText);
        clearTimeout(deadline);
        expect(
          historyTexts(await readSessionHistoryBody(harness.port, requestedKey, { headers })),
        ).toContain(replacementText);
        return;
      }
      const foreignText = `unrelated payload from ${mismatch}`;
      if (mismatch === "physical store") {
        const foreignUpdate = await captureAppend(otherStorePath, foreignText, requestedKey);
        expect(foreignUpdate).toMatchObject({
          target: { ...initialUpdate.target, storePath: expect.any(String) },
          lifecycleRevision: "copied-history-owner",
        });
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
      let published = "";
      do {
        published = JSON.stringify((await readSseEvent(reader, stream.streamState)).data);
        expect(published).not.toContain(foreignText);
      } while (!published.includes(visibleText));
      expect(
        historyTexts(await readSessionHistoryBody(harness.port, requestedKey, { headers })),
      ).toEqual(["bound initial message", visibleText]);
    } finally {
      await harness.close();
    }
  },
);
