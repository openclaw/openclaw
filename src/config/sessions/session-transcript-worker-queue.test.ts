import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import {
  onTrustedInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import type { OpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import type {
  SessionHistoryWorkerInput,
  SessionTranscriptHistoryWorkerInput,
  SessionTranscriptWorkerReply,
} from "./session-transcript-worker.types.js";

type PostedTask = { input: SessionHistoryWorkerInput; taskId: number };
type HeldPage = { sessionKey: string; complete: () => void };
const transport = vi.hoisted(() => ({
  pages: [] as HeldPage[],
  pending: new Set<() => void>(),
  drain: false,
  resources: [] as OpenClawAgentDatabaseAsyncResource[],
}));

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  const { EventEmitter } = await import("node:events");
  return {
    ...actual,
    Worker: class extends EventEmitter {
      postMessage(message: PostedTask) {
        const { input, taskId } = message;
        const complete = () => {
          if (!transport.pending.delete(complete)) {
            return;
          }
          let value: SessionTranscriptWorkerReply<SessionHistoryWorkerInput["kind"]>;
          if (input.kind === "history-page" && input.request.kind === "rpc") {
            value = {
              ok: true,
              value: { kind: "rpc", page: { messages: [input.request.params.canonicalKey] } },
            };
          } else if (input.kind === "session-row-presence") {
            value = { ok: true, value: true };
          } else if (input.kind === "transcript-hydration") {
            value = {
              ok: true,
              value: {
                kind: "full",
                eventCount: 0,
                version: { generation: null, rawSeq: null, updatedAt: null },
              },
            };
          } else {
            throw new Error(`Unexpected queue fixture request: ${input.kind}`);
          }
          this.emit("message", { status: "ok", taskId, value });
        };
        transport.pending.add(complete);
        if (input.kind === "history-page" && input.request.kind === "rpc") {
          transport.pages.push({ sessionKey: input.request.params.canonicalKey, complete });
          if (!transport.drain) {
            return;
          }
        }
        queueMicrotask(complete);
      }
      ref() {}
      unref() {}
      async terminate() {
        this.emit("exit", 0);
        return 0;
      }
    },
  };
});

// mock-isolation: Resolve synthetic workers without compiling or launching native readers.
vi.mock("../../infra/runtime-worker-url.js", () => ({
  resolveRuntimeWorkerUrl: () => new URL("file:///synthetic/session-transcript.worker.js"),
  resolveRuntimeWorkerArgv: () => [],
  resolveRuntimeWorkerThreadExecArgv: () => [],
}));
vi.mock("../../infra/bun-sqlite-library.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/bun-sqlite-library.js")>()),
  ensureSqliteLibrarySelected: () => ({ source: "runtime" }),
  captureSqliteWorkerClosePolicy: () => false,
}));
vi.mock("../../state/openclaw-agent-db-resources.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/openclaw-agent-db-resources.js")>()),
  registerOpenClawAgentDatabaseAsyncResource: (resource: OpenClawAgentDatabaseAsyncResource) => {
    transport.resources.push(resource);
    return () => {};
  },
}));
// mock-isolation: This transport fixture must not install a process-wide disk scan worker.
vi.mock("./disk-budget-runtime.js", () => ({
  measureSessionPhysicalDiskUsage: () => {
    throw new Error("Disk scans are outside the transcript queue fixture");
  },
  drainSessionDiskBudgetWorkers: async () => {},
}));

afterEach(async () => {
  await Promise.all(transport.resources.splice(0).map((resource) => resource.close()));
  transport.pages.length = 0;
  transport.pending.clear();
  transport.drain = false;
});

it("isolates point and transcript reads while bounded history pages dispatch FIFO", async () => {
  const database = { agentId: "main", path: "/synthetic/transcript-queue.sqlite" };
  const scope = {
    agentId: "main",
    databaseAgentId: "main",
    sessionKey: "agent:main:point",
    storePath: database.path,
  };
  const pointRead = () =>
    withSessionHistoryWorkerDatabase(database, (owner) => owner.readEntryPresence(scope));
  // Resolve the pool's lazy preparation before observing one deterministic dispatch turn.
  await expect(pointRead()).resolves.toBe(true);
  const events: Extract<DiagnosticEventPayload, { type: "worker.request" }>[] = [];
  await waitForDiagnosticEventsDrained();
  const unsubscribe = onTrustedInternalDiagnosticEvent(
    (event) => {
      if (event.type === "worker.request") {
        events.push(event);
      }
    },
    { include: ["worker.request"] },
  );
  const pending: Promise<unknown>[] = [];
  const keys = Array.from({ length: 6 }, (_, index) => `agent:main:page-${index}`);
  const startedPages = () => transport.pages.map(({ sessionKey }) => sessionKey);
  try {
    const pages = keys.map((sessionKey) => {
      const input: Omit<SessionTranscriptHistoryWorkerInput, "database"> = {
        kind: "history-page",
        request: {
          kind: "rpc",
          params: {
            entry: undefined,
            provider: undefined,
            sessionId: sessionKey,
            storePath: database.path,
            sessionAgentId: "main",
            canonicalKey: sessionKey,
            max: 100,
            maxHistoryBytes: 200_000,
            effectiveMaxChars: 20_000,
            offset: undefined,
            messageId: undefined,
          },
        },
        target: {
          transcript: {
            agentId: "main",
            sessionId: sessionKey,
            sessionFile: sessionKey,
            storePath: database.path,
          },
        },
      };
      return withSessionHistoryWorkerDatabase(database, (owner) =>
        owner.run(() => input, 1, "rpc"),
      );
    });
    pending.push(...pages);
    const completed: string[] = [];
    const point = pointRead().then((result) => {
      completed.push("point");
      return result;
    });
    const transcript = withSessionHistoryWorkerDatabase(database, (owner) =>
      owner.readTranscript({
        target: { agentId: "main", sessionId: "full", storePath: database.path },
        resolvedScope: { agentId: "main", sessionId: "full", path: database.path },
      }),
    ).then((result) => {
      completed.push("transcript");
      return result;
    });
    pending.push(point, transcript);
    await nextTurn();
    expect(completed.toSorted()).toEqual(["point", "transcript"]);
    expect(startedPages()).toEqual(keys.slice(0, 4));
    await expect(point).resolves.toBe(true);
    await expect(transcript).resolves.toEqual({
      kind: "full",
      snapshot: { events: [], version: { generation: null, rawSeq: null, updatedAt: null } },
    });

    transport.pages[1]!.complete();
    await pages[1];
    expect(startedPages()).toEqual(keys.slice(0, 5));
    transport.pages[0]!.complete();
    await pages[0];
    expect(startedPages()).toEqual(keys);
    for (const page of transport.pages.slice(2)) {
      page.complete();
    }
    await expect(Promise.all(pages)).resolves.toEqual(
      keys.map((key) => ({ kind: "rpc", page: { messages: [key] } })),
    );
    await waitForDiagnosticEventsDrained();
    const classes = events
      .filter((event) => event.phase === "started")
      .map((event) => `${event.kind}/${event.requestClass}`);
    expect(classes.toSorted()).toEqual(
      [
        ...Array.from({ length: 6 }, () => "sessionTranscript/history-page"),
        "sessionTranscript/transcript_read",
        "sessionTranscript/full-transcript",
      ].toSorted(),
    );
  } finally {
    transport.drain = true;
    for (const complete of transport.pending) {
      complete();
    }
    await Promise.allSettled(pending);
    await waitForDiagnosticEventsDrained();
    unsubscribe();
  }
});
