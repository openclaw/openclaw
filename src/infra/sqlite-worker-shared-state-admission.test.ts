import fs from "node:fs";
import path from "node:path";
import { MessagePort, Worker } from "node:worker_threads";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  readNativeHookRelayBridgeRecord,
  renewOrRestoreNativeHookRelayBridgeRecord,
  writeNativeHookRelayBridgeRecord,
  type NativeHookRelayBridgeRecord,
} from "../agents/harness/native-hook-relay-store.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { sqliteWorkerPreloadEnv } from "./sqlite-worker-preload.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    vi.unstubAllEnvs();
    cleanup();
  }),
);

it.each([true, false])(
  "services a worker grant through a directory alias behind a synchronous shared-state writer (owner current: %s)",
  async (ownerCurrent) => {
    const root = tempDirs.make("openclaw-state-admission-");
    const actual = path.join(root, "actual");
    const alias = path.join(root, "alias");
    fs.mkdirSync(actual);
    fs.symlinkSync(actual, alias, "junction");
    vi.stubEnv("OPENCLAW_STATE_DIR", alias);
    const marker = path.join(root, "transaction-held");
    const preload = path.join(root, "observe-admission.cjs");
    fs.writeFileSync(
      preload,
      `const { MessagePort, isMainThread } = require("node:worker_threads");
const fs = require("node:fs");
if (!isMainThread) {
  const post = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function(message, ...rest) {
    if (message?.stage === "transaction" && message.decision instanceof SharedArrayBuffer) {
      fs.writeFileSync(${JSON.stringify(marker)}, "transaction-held");
    }
    return Reflect.apply(post, this, [message, ...rest]);
  };
}
`,
    );
    for (const [key, value] of Object.entries(sqliteWorkerPreloadEnv(preload))) {
      vi.stubEnv(key, value);
    }
    const stateDbPath = path.join(alias, "state", "openclaw.sqlite");
    const record: NativeHookRelayBridgeRecord = {
      relayId: "relay-concurrent-writer",
      pid: process.pid,
      hostname: "127.0.0.1",
      port: 12345,
      token: "synthetic-relay-token",
      expiresAtMs: Date.now() + 60_000,
    };
    const posts = vi.spyOn(Worker.prototype, "postMessage");
    await writeNativeHookRelayBridgeRecord({ record, stateDbPath });
    const worker = posts.mock.contexts[0];
    posts.mockRestore();
    if (!(worker instanceof Worker)) {
      throw new Error("Expected the shared-state worker");
    }
    openOpenClawStateDatabase({ path: stateDbPath });
    fs.rmSync(marker);
    let current = true;
    const mutation = vi.fn(() => "committed");
    // Keep the native implementation callable with the actual sending port.
    const nativePost = vi.spyOn(MessagePort.prototype, "postMessage");
    nativePost.mockRestore();
    const dispatch = vi
      .spyOn(MessagePort.prototype, "postMessage")
      .mockImplementation(function (this: MessagePort, message, transferList) {
        const result = nativePost.call(this, message, transferList);
        const request = asOptionalRecord(message);
        if (request?.type !== "accepted" || !(request.admission instanceof MessagePort)) {
          return result;
        }
        dispatch.mockRestore();
        // Keep the host listener queued until the worker owns its transaction,
        // then enter the competing synchronous write on the same event-loop turn.
        const deadline = Date.now() + 5_000;
        const pause = new Int32Array(new SharedArrayBuffer(4));
        while (!fs.existsSync(marker)) {
          if (Date.now() >= deadline) {
            throw new Error("Worker did not reach its transaction admission");
          }
          Atomics.wait(pause, 0, 0, 1);
        }
        current = ownerCurrent;
        runOpenClawStateWriteTransaction(mutation, { path: stateDbPath });
        return result;
      });
    const expiresAtMs = record.expiresAtMs + 1;
    const renewal = renewOrRestoreNativeHookRelayBridgeRecord({
      record: { ...record, expiresAtMs },
      stateDbPath,
      assertCurrent: () => {
        if (!current) {
          throw new Error("Native hook relay authority revoked");
        }
      },
    });
    if (ownerCurrent) {
      await expect(renewal).resolves.toBe(true);
    } else {
      await expect(renewal).rejects.toThrow("Native hook relay authority revoked");
    }
    expect(mutation).toHaveBeenCalledOnce();
    expect(await readNativeHookRelayBridgeRecord({ relayId: record.relayId, stateDbPath })).toEqual(
      { ...record, expiresAtMs: ownerCurrent ? expiresAtMs : record.expiresAtMs },
    );
  },
);
