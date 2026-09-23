import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { sessionNativeProcessEntrypoints } from "./native-process-runtime.test-support.js";

export function createConcurrencyWorkerScript(
  sessionAccessorUrl: string,
  sessionKey: string,
  agentId: string,
): string {
  return `
const {
  commitReplySessionInitialization,
  loadReplySessionInitializationSnapshot,
  withTranscriptWriteLock,
} = await import(${JSON.stringify(sessionAccessorUrl)});
const { closeOpenClawAgentDatabasesAsync } = await import(${JSON.stringify(resolveRuntimeWorkerUrl(sessionNativeProcessEntrypoints.agentDatabase).href)});
const { closeOpenClawStateDatabaseAsync } = await import(${JSON.stringify(resolveRuntimeWorkerUrl(sessionNativeProcessEntrypoints.stateDatabase).href)});
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

const SESSION_KEY = ${JSON.stringify(sessionKey)};
const AGENT_ID = ${JSON.stringify(agentId)};
const proceedResolvers = new Map();

function send(message) {
  process.send?.(message);
}

function waitForProceed(requestId) {
  return new Promise((resolve) => {
    proceedResolvers.set(requestId, resolve);
  });
}

async function runReplyInit(request) {
  const snapshot = loadReplySessionInitializationSnapshot({
    agentId: AGENT_ID,
    sessionKey: SESSION_KEY,
    storePath: request.storePath,
  });
  const proceed = waitForProceed(request.requestId);
  send({
    phase: "ready",
    requestId: request.requestId,
    value: {
      currentEntry: snapshot.currentEntry,
      revision: snapshot.revision,
    },
  });
  await proceed;
  return commitReplySessionInitialization({
    activeSessionKey: SESSION_KEY,
    agentId: AGENT_ID,
    expectedRevision: snapshot.revision,
    sessionEntry: {
      sessionId: "existing-session",
      updatedAt: request.preparedUpdatedAt,
    },
    sessionKey: SESSION_KEY,
    snapshotEntry: snapshot.currentEntry,
    storePath: request.storePath,
  });
}

async function runTranscriptRewrite(request) {
  let result;
  try {
    await withTranscriptWriteLock(
      {
        agentId: AGENT_ID,
        sessionId: request.sessionId,
        sessionKey: SESSION_KEY,
        storePath: request.storePath,
      },
      async (transcript) => {
        if (request.rewriteMode === "replace-twice") {
          const firstReplacement = [
            { type: "session", version: 3, id: request.sessionId },
            {
              type: "message",
              id: "first-replacement",
              parentId: null,
              message: { role: "assistant", content: "first replacement" },
            },
          ];
          await transcript.replaceEvents(firstReplacement);
          const proceed = waitForProceed(request.requestId);
          send({
            phase: "ready",
            requestId: request.requestId,
            value: { eventCount: firstReplacement.length },
          });
          await proceed;
          await transcript.replaceEvents([
            firstReplacement[0],
            {
              type: "message",
              id: "first-replacement",
              parentId: null,
              message: { role: "assistant", content: "second replacement" },
            },
          ]);
          return;
        }
        const events = await transcript.readEvents();
        const proceed = waitForProceed(request.requestId);
        send({
          phase: "ready",
          requestId: request.requestId,
          value: { eventCount: events.length },
        });
        await proceed;
        const rewrittenEvents = events.map((event) => {
          if (
            typeof event !== "object" ||
            event === null ||
            Array.isArray(event) ||
            event.id !== "rewrite-target"
          ) {
            return event;
          }
          return {
            ...event,
            message: {
              ...event.message,
              content: "rewritten content",
            },
          };
        });
        await transcript.replaceEvents(rewrittenEvents);
      },
    );
    result = { ok: true };
  } catch (error) {
    result = {
      ok: false,
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return result;
}

process.on("message", (request) => {
  if (!request || typeof request !== "object") {
    return;
  }
  if (request.kind === "shutdown") {
    void shutdown();
    return;
  }
  if (request.kind === "proceed") {
    const resolve = proceedResolvers.get(request.requestId);
    proceedResolvers.delete(request.requestId);
    resolve?.();
    return;
  }
  if (!Number.isInteger(request.requestId)) {
    return;
  }
  void (async () => {
    const value =
      request.kind === "reply-init"
        ? await runReplyInit(request)
        : await runTranscriptRewrite(request);
    send({ phase: "result", requestId: request.requestId, value });
  })().catch((error) => {
    send({
      error: {
        message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : typeof error,
      },
      phase: "error",
      requestId: request.requestId,
    });
  });
});

process.on("disconnect", () => { void shutdown(); });
send({ phase: "booted" });
`;
}
