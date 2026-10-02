import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { deserialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createCurrentOpenClawAgentDatabaseFixtures } from "../state/openclaw-agent-db.test-support.js";
import {
  createSqliteReadOnlyWorkerScope,
  runSqliteReadOnlyOperation,
} from "./sqlite-readonly-worker.js";
import { readDatabasePathIdentitySync } from "./sqlite-worker-identity.js";
import { SQLITE_WORKER_TRANSFER_FRAME_BYTES } from "./sqlite-worker-transfer.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const scope = createSqliteReadOnlyWorkerScope();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await scope.close();
    vi.restoreAllMocks();
    cleanup();
  }),
);
let source: string;
let expectedIdentity: string;
let env: NodeJS.ProcessEnv;
let child: ChildProcess;
let sourceDigest: string;
const contents = JSON.stringify({
  providers: {
    fixture: {
      models: [{ id: "fixture-model", name: `${"catalog".repeat(1_300_000)}🌊` }],
    },
  },
});
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function read(pluginIds: string[], signal?: AbortSignal) {
  return scope.run(() =>
    runSqliteReadOnlyOperation(
      source,
      { type: "pluginCatalog.read", input: { agentId: "main", pluginIds } },
      { source: "canonical", expectedIdentity, env, signal },
    ),
  );
}

beforeAll(async () => {
  const root = tempDirs.make("openclaw-readonly-operations-");
  source = path.join(root, "openclaw-agent.sqlite");
  env = { ...process.env, OPENCLAW_STATE_DIR: root };
  createCurrentOpenClawAgentDatabaseFixtures(path.join(root, "template.sqlite"), [
    { path: source, agentId: "main" },
  ]);
  const database = new DatabaseSync(source);
  try {
    const insert = database.prepare(
      "INSERT INTO cache_entries (scope, key, value_json, updated_at) VALUES (?, ?, ?, ?)",
    );
    insert.run("plugin-model-catalog-v1", "fixture", contents, 1);
    insert.run("plugin-model-catalog-v1", "small", "small catalog", 1);
  } finally {
    database.close();
  }
  expectedIdentity = readDatabasePathIdentitySync(source).key;
  sourceDigest = digest(readFileSync(source));
  await read(["small"]);
  child = vi.mocked(spawn).mock.results[0]?.value;
});

it("preserves bounded catalog reads, queued inputs, and cancellation ownership", async ({
  signal,
}) => {
  const frames: number[] = [];
  const observeFrame = (message: unknown) => {
    if (!isRecord(message) || !isRecord(message.result)) {
      return;
    }
    const frame = message.result.frame;
    if (isRecord(frame) && typeof frame.bytes === "string") {
      frames.push(Buffer.from(frame.bytes, "base64").byteLength);
    }
  };
  child.on("message", observeFrame);
  const sql = [
    ...(["exec", "prepare", "close"] as const).map((method) =>
      vi.spyOn(DatabaseSync.prototype, method),
    ),
    ...(["all", "get", "run", "iterate"] as const).map((method) =>
      vi.spyOn(StatementSync.prototype, method),
    ),
  ];
  try {
    const rows = await read(["fixture"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.pluginId).toBe("fixture");
    expect(digest(rows[0]?.contents ?? "")).toBe(digest(contents));
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.every((bytes) => bytes > 0 && bytes <= SQLITE_WORKER_TRANSFER_FRAME_BYTES)).toBe(
      true,
    );
    expect(frames.reduce((total, bytes) => total + bytes, 0)).toBeGreaterThan(
      SQLITE_WORKER_TRANSFER_FRAME_BYTES,
    );
    expect(digest(readFileSync(source))).toBe(sourceDigest);
    for (const operation of sql) {
      expect(operation).not.toHaveBeenCalled();
    }
  } finally {
    child.off("message", observeFrame);
    for (const operation of sql) {
      operation.mockRestore();
    }
  }
  const send = vi.spyOn(child, "send");
  const emit = child.emit.bind(child);
  let paused = createDeferredCore<() => boolean>();
  let pauseNextStart = true;
  const receiving = vi.spyOn(child, "emit").mockImplementation((event, ...args) => {
    const message: unknown = args[0];
    if (
      event === "message" &&
      pauseNextStart &&
      isRecord(message) &&
      isRecord(message.result) &&
      message.result.type === "start"
    ) {
      pauseNextStart = false;
      paused.resolve(() => emit(event, ...args));
      return true;
    }
    return emit(event, ...args);
  });
  const queuedAbort = new AbortController();
  const activeAbort = new AbortController();
  const pending: Promise<unknown>[] = [];
  try {
    const first = read(["small"]);
    pending.push(first);
    const release = await withinTest(
      awaitGateBeforeSettlement(paused.promise, first, "Read settled before its transfer started"),
      signal,
    );
    const command = {
      type: "pluginCatalog.read" as const,
      input: {
        agentId: "main",
        pluginIds: ["small"],
        synthetic: {
          count: 9_007_199_254_740_993n,
          absent: undefined,
          owners: new Map([["fixture", "captured"]]),
          selected: new Set(["small"]),
        },
      },
    };
    const captured = scope.run(() =>
      runSqliteReadOnlyOperation(source, command, {
        source: "canonical",
        expectedIdentity,
        env,
      }),
    );
    pending.push(captured);
    command.input.pluginIds[0] = "fixture";
    command.input.synthetic.count = 1n;
    command.input.synthetic.owners.set("fixture", "changed");
    command.input.synthetic.selected.add("fixture");
    const queuedFailure = new Error("queued catalog read cancelled");
    const queued = read(["fixture"], queuedAbort.signal);
    pending.push(queued);
    const rejectedQueued = expect(queued).rejects.toBe(queuedFailure);
    queuedAbort.abort(queuedFailure);
    release();
    await expect(first).resolves.toEqual([{ pluginId: "small", contents: "small catalog" }]);
    await expect(captured).resolves.toEqual([{ pluginId: "small", contents: "small catalog" }]);
    await rejectedQueued;
    const requests = () =>
      send.mock.calls.flatMap(([message]) =>
        isRecord(message) && isRecord(message.operation) ? [message.operation] : [],
      );
    expect(requests()).toHaveLength(2);
    const encoded = requests()[1]?.command;
    if (typeof encoded !== "string") {
      throw new Error("Expected a serialized operation command");
    }
    const decoded: unknown = deserialize(Buffer.from(encoded, "base64"));
    expect(decoded).toStrictEqual({
      type: "pluginCatalog.read",
      input: {
        agentId: "main",
        pluginIds: ["small"],
        synthetic: {
          count: 9_007_199_254_740_993n,
          absent: undefined,
          owners: new Map([["fixture", "captured"]]),
          selected: new Set(["small"]),
        },
      },
    });

    paused = createDeferredCore<() => boolean>();
    pauseNextStart = true;
    const active = read(["small"], activeAbort.signal);
    pending.push(active);
    const activeFailure = new Error("active catalog read cancelled");
    const rejectedActive = expect(active).rejects.toBe(activeFailure);
    await withinTest(
      awaitGateBeforeSettlement(paused.promise, active, "Read settled before cancellation"),
      signal,
    );
    activeAbort.abort(activeFailure);
    await rejectedActive;
    expect(requests()).toHaveLength(3);
    expect(child.signalCode).toBe("SIGKILL");
    expect(child.connected).toBe(false);
    expect(digest(readFileSync(source))).toBe(sourceDigest);
    expect(spawn).toHaveBeenCalledTimes(1);
  } finally {
    queuedAbort.abort();
    activeAbort.abort();
    receiving.mockRestore();
    send.mockRestore();
    await scope.close();
    await Promise.allSettled(pending);
  }
});
