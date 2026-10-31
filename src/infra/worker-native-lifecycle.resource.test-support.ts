import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createDeferredCore } from "../shared/deferred.js";
import type {
  NativeWorkerResourceOwner,
  NativeWorkerResourcePort,
} from "./worker-native-lifecycle.types.js";

export function createNativeWorkerResource(
  port: NativeWorkerResourcePort,
  input: unknown,
  ownerPort?: NativeWorkerResourcePort,
): NativeWorkerResourceOwner {
  assert.ok(isRecord(input));
  const { databasePath, lateAttachment } = input;
  assert.ok(typeof databasePath === "string");
  assert.ok(ownerPort);
  const sendOwner = ownerPort.postMessage.bind(ownerPort);
  sendOwner({ type: "constructed", brokerPid: process.pid });
  let attempts = 0;
  const permission = createDeferredCore();
  ownerPort.on("message", (message) => {
    assert.ok(isRecord(message));
    if (message.type === "permit-close") {
      permission.resolve();
    }
  });
  let child: ChildProcessWithoutNullStreams | undefined;
  let closed: Promise<void>;
  port.on("message", (message) => {
    assert.ok(isRecord(message));
    assert.equal(child, undefined, "one native child belongs to this resource owner");
    const script = `const { DatabaseSync } = require("node:sqlite");
         const db = new DatabaseSync(${JSON.stringify(databasePath)});
         db.exec("PRAGMA journal_mode=WAL; CREATE TABLE proof(value); INSERT INTO proof VALUES(1)");
         db.exec("BEGIN IMMEDIATE; INSERT INTO proof VALUES(2)");
         process.stdin.on("data", () => {
           db.exec("ROLLBACK");
           db.close();
           process.exit(0);
         });
         setTimeout(() => process.exit(97), ${lateAttachment === true ? 40_000 : 12_000}).unref();
         const bootstrapKeys = ["OPENCLAW_SPAWN_RESOURCE_ENDPOINT", "OPENCLAW_SPAWN_RESOURCE_SECRET", "OPENCLAW_SPAWN_RESOURCE_GENERATION"];
         process.stdout.write(JSON.stringify(bootstrapKeys.filter(key => Object.hasOwn(process.env, key))) + "\\n");`;
    const owned = spawn(process.execPath, ["--eval", script], { stdio: "pipe", windowsHide: true });
    child = owned;
    if (owned.pid !== undefined) {
      sendOwner({ type: "child", pid: owned.pid });
    }
    owned.once("close", (code) => sendOwner({ type: "child-closed", code }));
    closed = once(owned, "close").then(([code]) => {
      assert.equal(code, 0, `Native SQLite child exited with code ${code}`);
    });
    void closed.catch(() => undefined);
    createInterface({ input: owned.stdout }).once("line", (line) => {
      const keys: unknown = JSON.parse(line);
      sendOwner({ type: "child-environment", keys });
      port.postMessage({ ready: true, pid: owned.pid });
    });
    owned.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  });
  return {
    async close() {
      sendOwner({ type: "close-attempt", attempt: ++attempts });
      if (attempts === 1) {
        throw new Error("synthetic first resource close failure");
      }
      if (!child) {
        return;
      }
      const failure = new Error("resource close permission deadline");
      const timeout = setTimeout(permission.reject, 10_000, failure);
      try {
        await permission.promise;
      } finally {
        clearTimeout(timeout);
      }
      child.stdin.end("close\n");
      await closed;
    },
  };
}
