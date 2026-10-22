import path from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { createSessionHistoryWorkerReaders } from "./session-transcript-worker-readers.js";
import { createSessionHistoryWorkerRequestStub } from "./session-transcript-worker-readers.test-support.js";

const storageStateDir = path.resolve("synthetic-worker-state");
const storagePath = path.join(storageStateDir, "agents", "main", "agent.sqlite");
const storageEnv = new Proxy(
  { OPENCLAW_STATE_DIR: storageStateDir, SYNTHETIC_VALUE: "worker-env-sentinel" },
  {},
);
type Readers = ReturnType<typeof createSessionHistoryWorkerReaders>;
const storageInput = { env: storageEnv };
const session = { ...storageInput, sessionId: "one" };
// One direct reader covers the shared factory; keep both custom eviction preparers.
const storageRequests: Array<[string, (readers: Readers) => Promise<unknown>]> = [
  ["cold metadata", (readers) => readers.readColdMetadata(session)],
  [
    "historical eviction",
    (readers) =>
      readers.readHistoricalEvictionCandidates({ ...storageInput, admissionIdentities: [] }),
  ],
  [
    "archived eviction",
    (readers) =>
      readers.readArchivedEvictionCandidates({
        ...storageInput,
        archived: { liveSessionKeys: [] },
      }),
  ],
];

it.each(storageRequests)("serializes Proxy environments for %s requests", async (_name, read) => {
  const serialized = new Error("Stopped after serializing the worker request");
  const readers = createSessionHistoryWorkerReaders(async (prepare) => {
    // Exercise the actual producer without starting a Worker or opening a database.
    const request = structuredClone(prepare());
    expect(request).toMatchObject({ env: { ...storageEnv } });
    throw serialized;
  });
  await expect(read(readers)).rejects.toBe(serialized);
});

it("serializes the nested Proxy environment for activity summary reads", async () => {
  const serialized = new Error("Stopped after serializing the worker request");
  const readers = createSessionHistoryWorkerReaders(async (prepare) => {
    const request = structuredClone(prepare());
    expect(request).toMatchObject({ scope: { env: { ...storageEnv } } });
    throw serialized;
  });
  const scope = { agentId: "main", sessionId: "one", storePath: storagePath, env: storageEnv };
  await expect(readers.readActivitySummarySource({ scope })).rejects.toBe(serialized);
});

const transcriptInput = {
  target: { sessionId: "synthetic-session" },
  resolvedScope: { agentId: "main", sessionId: "synthetic-session" },
  includeEventJson: true,
};
const version = (rawSeq: number) => ({
  generation: "synthetic-generation",
  rawSeq,
  updatedAt: 123,
});

function readFrames(frames: unknown[], eventCount: number, rawSeq = 7, encoding = "utf-8") {
  const signal = new AbortController().signal;
  const readers = createSessionHistoryWorkerReaders(
    createSessionHistoryWorkerRequestStub(async (_prepare, _inputBytes, _signal, onRequest) => {
      if (!onRequest) {
        throw new Error("Transcript reader did not provide its chunk receiver");
      }
      for (const frame of frames) {
        await onRequest({ kind: "transcript-hydration-chunk", encoding, frames: [frame] }, signal);
      }
      return { kind: "full", version: version(rawSeq), eventCount };
    }),
  );
  return readers.readTranscript(transcriptInput, signal);
}

it("preserves the direct read request, signal, and projected result", async () => {
  const input = { scope: { agentId: "main", sessionId: "synthetic-session" } };
  const signal = new AbortController().signal;
  const readers = createSessionHistoryWorkerReaders(
    createSessionHistoryWorkerRequestStub(async (prepare, inputBytes, receivedSignal) => {
      expect(prepare()).toEqual({ kind: "transcript-message-presence", ...input });
      expect(inputBytes).toBe(JSON.stringify(input).length * 2);
      expect(receivedSignal).toBe(signal);
      return { kind: "transcript-message-presence", present: true };
    }),
  );
  await expect(readers.readMessagePresence(input, signal)).resolves.toBe(true);
});

it.each(["archives", "corpus", "targets", "exact entries", "row facts"] as const)(
  "serializes Windows storage environments for %s requests",
  async (inventory) => {
    const stateDir = path.resolve("synthetic-state");
    const storePath = path.join(stateDir, "sessions.sqlite");
    const platform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const env = cloneEnvWithPlatformSemantics({
        openclaw_state_dir: stateDir,
        OpenClaw_Supervisor_Mode: "external",
        UNRELATED_VALUE: "synthetic",
        GITHUB_TOKEN: "synthetic-credential",
      });
      const readers = createSessionHistoryWorkerReaders(
        createSessionHistoryWorkerRequestStub(async (prepare) => {
          // postMessage uses this same clone contract before a worker can consume the request.
          const request = structuredClone(prepare());
          const expectedEnv = {
            OPENCLAW_STATE_DIR: stateDir,
            OPENCLAW_SUPERVISOR_MODE: "external",
          };
          switch (request.kind) {
            case "session-row-facts":
              expect(request.env).toEqual(expectedEnv);
              return { kind: request.kind, rows: [] };
            case "session-exact-entries":
              expect(request.env).toEqual(expectedEnv);
              return { kind: request.kind, entries: [], lifecycleTimestamps: {} };
            case "session-archive-inventory":
              expect(request.env).toEqual(expectedEnv);
              return { kind: request.kind, archives: [] };
            case "session-corpus-inventory":
              expect(request.scope.env).toEqual(expectedEnv);
              return { kind: request.kind, entries: [] };
            case "memory-session-targets":
              expect(request.params.env).toEqual(expectedEnv);
              return { kind: request.kind, targets: [] };
            default:
              throw new Error(`Unexpected inventory request: ${request.kind}`);
          }
        }),
      );
      const archive = { agentId: "main", storePath, env, sessionIds: ["one"] };
      const entries = { env, sessionKeys: ["agent:main:main"] };
      const reads = {
        "row facts": () => readers.readRowFacts(entries),
        "exact entries": () => readers.readExactEntries(entries),
        archives: () => readers.readArchiveInventory(archive),
        targets: () => readers.readMemorySessionTargets({ params: archive }),
        corpus: () =>
          readers.readCorpusInventory({
            scope: {
              cfg: {},
              normalizedAgentId: "main",
              storePath,
              env,
              artifactDirs: [],
              isSharedFixedStore: false,
            },
            options: {},
            artifacts: [],
          }),
      };
      await expect(reads[inventory]()).resolves.toEqual(
        inventory === "row facts"
          ? { kind: "session-row-facts", rows: [] }
          : inventory === "exact entries"
            ? { kind: "session-exact-entries", entries: [], lifecycleTimestamps: {} }
            : [],
      );
    } finally {
      Object.defineProperty(process, "platform", { value: platform });
    }
  },
);

it("passes the cold metadata caller's signal to its reader task", async () => {
  const input = { sessionId: "synthetic-cold-session", env: {} };
  const signal = new AbortController().signal;
  const readers = createSessionHistoryWorkerReaders(
    createSessionHistoryWorkerRequestStub(async (prepare, _inputBytes, receivedSignal) => {
      expect(prepare()).toEqual({ kind: "cold-metadata", ...input });
      expect(receivedSignal).toBe(signal);
      return { kind: "cold-metadata", archive: undefined };
    }),
  );
  await expect(readers.readColdMetadata(input, signal)).resolves.toEqual({
    kind: "cold-metadata",
    archive: undefined,
  });
});

it("decodes cross-realm Uint8Array transcript frames", async () => {
  const event = { type: "message", text: "hello 🦞" };
  const json = JSON.stringify(event);
  const bytes = Array.from(new TextEncoder().encode(json));
  const data: unknown = runInNewContext("new Uint8Array(bytes)", { bytes });
  const result = readFrames([{ data, endOfEvent: true, seq: 7 }], 1);
  await expect(result).resolves.toEqual({
    kind: "full",
    snapshot: { events: [event], eventJson: [json], eventSeqs: [7], version: version(7) },
  });
});

it.each(["utf-8", "utf-16le", "utf-16be"])(
  "assembles split %s events across chunks and preserves exact correction JSON",
  async (encoding) => {
    const json = ' {"type":"message","text":"hello 🦞 café"} ';
    const bytes = Buffer.from(json, encoding === "utf-8" ? "utf8" : "utf16le");
    if (encoding === "utf-16be") {
      bytes.swap16();
    }
    // One-byte, offset views split UTF-8 code points and UTF-16 code units.
    const frames = Array.from({ length: bytes.length }, (_, offset) => ({
      data: bytes.subarray(offset, offset + 1),
      endOfEvent: false,
    }));
    await expect(
      readFrames(
        [
          ...frames,
          { data: new Uint8Array(), endOfEvent: true, seq: 7 },
          { data: bytes, endOfEvent: true, seq: 9 },
        ],
        2,
        9,
        encoding,
      ),
    ).resolves.toEqual({
      kind: "full",
      snapshot: {
        events: [
          { type: "message", text: "hello 🦞 café" },
          { type: "message", text: "hello 🦞 café" },
        ],
        eventJson: [json, json],
        eventSeqs: [7, 9],
        version: version(9),
      },
    });
  },
);

it.each([
  { json: "{", endOfEvent: true, seq: 7, eventCount: 1, error: /JSON/ },
  { json: "{}", endOfEvent: true, seq: undefined, eventCount: 1, error: /row sequence/ },
  { json: "{}", endOfEvent: false, seq: 7, eventCount: 0, error: /incomplete transcript/ },
  { json: "{}", endOfEvent: true, seq: 7, eventCount: 2, error: /incomplete transcript/ },
])("rejects unusable transcript data: %j", async ({ json, endOfEvent, seq, eventCount, error }) => {
  await expect(
    readFrames([{ data: Buffer.from(json), endOfEvent, seq }], eventCount),
  ).rejects.toThrow(error);
});
