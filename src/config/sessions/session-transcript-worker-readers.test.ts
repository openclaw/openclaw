import path from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { execNodeEvalSync } from "../../test-utils/node-process.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { createSessionHistoryWorkerReaders } from "./session-transcript-worker-readers.js";
import { createSessionHistoryWorkerRequestStub } from "./session-transcript-worker-readers.test-support.js";
import type { InternalSessionEntry } from "./types.js";

const storageStateDir = path.resolve("synthetic-worker-state");
const storagePath = path.join(storageStateDir, "agents", "main", "agent.sqlite");
const storageEnv = new Proxy(
  { OPENCLAW_STATE_DIR: storageStateDir, SYNTHETIC_VALUE: "worker-env-sentinel" },
  {},
);
type Readers = ReturnType<typeof createSessionHistoryWorkerReaders>;
const storageInput = { env: storageEnv };

function summaryEntry(sessionKey: string): InternalSessionEntry {
  return {
    sessionId: "synthetic-session",
    lifecycleRevision: "synthetic-lifecycle",
    updatedAt: 1,
    lastRunId: "synthetic-run",
    observerDigest: {
      sessionKey,
      sessionId: "synthetic-session",
      lifecycleRevision: "synthetic-lifecycle",
      agentId: "main",
      runId: "synthetic-run",
      revision: 1,
      updatedAt: 1,
      headline: "Finished",
      health: "done",
    },
    restartRecoveryOperatorSource: {
      version: 1,
      agentId: "main",
      sessionKey,
      sessionId: "synthetic-session",
      lifecycleRevision: "synthetic-lifecycle",
      sourceRunId: "synthetic-run",
      snapshot: {
        profileId: "synthetic-profile",
        scopes: ["operator.read"],
        assignedRole: null,
        githubLogin: null,
        grant: null,
        aliasBindingIds: [],
        authPolicy: {
          generation: "",
          grantGeneration: "synthetic-grant",
          role: "operator",
          authMethod: "token",
        },
        controlUiAdmin: false,
        localOperator: true,
        sourceIngress: "internal",
      },
    },
  };
}

it.each(["matching", "stale", "legacy"] as const)(
  "preserves %s summary evidence when adopting worker entries",
  async (kind) => {
    const sessionKey = "agent:main:synthetic-summary";
    const entry = summaryEntry(sessionKey);
    if (kind === "stale") {
      Object.assign(entry.restartRecoveryOperatorSource!, {
        sessionKey: "agent:other:previous",
        sessionId: "previous-session",
        lifecycleRevision: "previous-lifecycle",
        sourceRunId: "previous-run",
        agentId: "other",
      });
      Object.assign(entry.observerDigest!, {
        sessionId: "previous-session",
        lifecycleRevision: "previous-lifecycle",
      });
    } else if (kind === "legacy") {
      delete entry.observerDigest!.sessionId;
      delete entry.observerDigest!.lifecycleRevision;
      delete entry.observerDigest!.runId;
      delete entry.observerDigest!.agentId;
      delete entry.restartRecoveryOperatorSource!.lifecycleRevision;
    }
    const expected = structuredClone(entry);
    const readers = createSessionHistoryWorkerReaders(
      createSessionHistoryWorkerRequestStub(async () => ({
        kind: "session-exact-entries",
        entries: structuredClone([{ sessionKey, entry }]),
        lifecycleTimestamps: {},
      })),
    );
    const result = await readers.readExactEntries({ env: {}, sessionKeys: [sessionKey] });
    expect(result.entries).toStrictEqual([{ sessionKey, entry: expected }]);
    result.entries[0]!.entry.observerDigest!.headline = "Changed by caller";
    expect(entry).toStrictEqual(expected);
  },
);

const session = { ...storageInput, sessionId: "one" };

it("retains one physical string for each equal summary identity after worker decoding", () => {
  const sessionKey = "agent:main:synthetic-summary";
  const payload = JSON.stringify({
    kind: "session-exact-entries",
    entries: [{ sessionKey, entry: summaryEntry(sessionKey) }],
    lifecycleTimestamps: {},
  });
  // A small fresh isolate avoids snapshotting the test runner and its other loaded suites.
  const output = execNodeEvalSync(
    `
      import assert from "node:assert/strict";
      import { getHeapSnapshot } from "node:v8";
      import { createSessionHistoryWorkerReaders } from "./src/config/sessions/session-transcript-worker-readers.ts";
      const readers = createSessionHistoryWorkerReaders(async (_prepare, _bytes, receive) =>
        receive(JSON.parse(${JSON.stringify(payload)})));
      class RetainedSummaryRows { constructor(rows) { this.rows = rows; } }
      globalThis.fixture = new RetainedSummaryRows(
        (await readers.readExactEntries({ env: {}, sessionKeys: [${JSON.stringify(sessionKey)}] })).entries);
      const chunks = [];
      for await (const chunk of getHeapSnapshot()) chunks.push(chunk);
      const { snapshot, nodes, edges, strings } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const fields = snapshot.meta.node_fields;
      const edgeFields = snapshot.meta.edge_fields;
      const width = fields.length;
      const edgeWidth = edgeFields.length;
      const type = fields.indexOf("type");
      const name = fields.indexOf("name");
      const edgeCount = fields.indexOf("edge_count");
      const starts = new Map();
      let offset = 0;
      let holder;
      for (let node = 0; node < nodes.length; node += width) {
        starts.set(node, offset);
        offset += nodes[node + edgeCount] * edgeWidth;
        if (snapshot.meta.node_types[type][nodes[node + type]] === "object" &&
            strings[nodes[node + name]] === "RetainedSummaryRows") holder = node;
      }
      assert.notEqual(holder, undefined);
      function target(node, key) {
        const start = starts.get(node);
        for (let edge = start; edge < start + nodes[node + edgeCount] * edgeWidth; edge += edgeWidth) {
          const kind = snapshot.meta.edge_types[edgeFields.indexOf("type")][edges[edge + edgeFields.indexOf("type")]];
          const name = edges[edge + edgeFields.indexOf("name_or_index")];
          if ((kind === "property" && strings[name] === key) || (kind === "element" && name === key)) {
            return edges[edge + edgeFields.indexOf("to_node")];
          }
        }
        throw new Error("Missing fixture field " + key);
      }
      const row = target(target(holder, "rows"), 0);
      const entry = target(row, "entry");
      const digest = target(entry, "observerDigest");
      const source = target(entry, "restartRecoveryOperatorSource");
      for (const nested of [digest, source]) {
        for (const field of ["sessionId", "lifecycleRevision"]) {
          assert.equal(target(nested, field), target(entry, field), field + " retained a duplicate string node");
        }
        assert.equal(target(nested, "sessionKey"), target(row, "sessionKey"));
      }
      assert.equal(target(source, "sourceRunId"), target(entry, "lastRunId"));
      assert.equal(target(digest, "runId"), target(entry, "lastRunId"));
      assert.equal(target(source, "agentId"), target(digest, "agentId"));
      console.log("shared summary identities");
    `,
    { imports: ["./scripts/tsx.mjs"], timeout: 30_000 },
  );
  expect(output.trim()).toBe("shared summary identities");
});

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

it("keeps interleaved decorated readers on their own request runner", async () => {
  const first = Promise.withResolvers<boolean>();
  const second = Promise.withResolvers<boolean>();
  const create = (result: Promise<boolean>) => ({
    ...createSessionHistoryWorkerReaders(
      createSessionHistoryWorkerRequestStub(async () => ({
        kind: "transcript-message-presence",
        present: await result,
      })),
    ),
    assertCurrent() {},
  });
  const input = { scope: { agentId: "main", sessionId: "synthetic-session" } };
  const firstRead = create(first.promise).readMessagePresence(input);
  const secondRead = create(second.promise).readMessagePresence(input);
  second.resolve(false);
  await expect(secondRead).resolves.toBe(false);
  first.resolve(true);
  await expect(firstRead).resolves.toBe(true);
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
