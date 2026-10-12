import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
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
  assert.ok(typeof input.databasePath === "string");
  assert.ok(ownerPort);
  const sendOwner = ownerPort.postMessage.bind(ownerPort);
  const sendTarget = port.postMessage.bind(port);
  sendOwner({ type: "constructed", brokerPid: process.pid });
  let attempts = 0;
  const permission = createDeferredCore();
  const childWatchdogMs = input.lateAttachment === true ? 40_000 : 12_000;
  ownerPort.on("message", (message) => {
    assert.ok(isRecord(message));
    if (message.type === "permit-close") {
      permission.resolve();
    }
  });
  const waitForPermission = async (gate: Deferred) => {
    const timeout = setTimeout(
      () => gate.reject(new Error("resource close permission deadline")),
      10_000,
    );
    try {
      await gate.promise;
    } finally {
      clearTimeout(timeout);
    }
  };
  const databasePath = input.databasePath;
  let child: ChildProcessWithoutNullStreams | undefined;
  const closed = createDeferredCore();
  void closed.promise.catch(() => undefined);
  const owner: NativeWorkerResourceOwner = {
    async close() {
      sendOwner({ type: "close-attempt", attempt: ++attempts });
      if (attempts === 1) {
        throw new Error("synthetic first resource close failure");
      }
      if (!child) {
        return;
      }
      process.stderr.write(`native resource pid=${process.pid}: awaiting close permission\n`);
      await waitForPermission(permission);
      child.stdin.end("close\n");
      await closed.promise;
    },
  };

  // The factory returns its owner before a queued target request can spawn native work.
  port.on("message", (message) => {
    assert.ok(isRecord(message));
    assert.equal(child, undefined, "one native child belongs to this resource owner");
    const owned = spawn(
      process.execPath,
      [
        "--eval",
        `const { DatabaseSync } = require("node:sqlite");
         const db = new DatabaseSync(${JSON.stringify(databasePath)});
         db.exec("PRAGMA journal_mode=WAL; CREATE TABLE proof(value); INSERT INTO proof VALUES(1)");
         db.exec("BEGIN IMMEDIATE; INSERT INTO proof VALUES(2)");
         process.stdin.on("data", () => {
           db.exec("ROLLBACK");
           db.close();
           process.exit(0);
         });
         setTimeout(() => process.exit(97), ${childWatchdogMs}).unref();
         const bootstrapKeys = ["OPENCLAW_SPAWN_RESOURCE_ENDPOINT", "OPENCLAW_SPAWN_RESOURCE_SECRET", "OPENCLAW_SPAWN_RESOURCE_GENERATION"];
         process.stdout.write("environment:" + JSON.stringify(bootstrapKeys.filter(key => Object.hasOwn(process.env, key))) + "\\n");
         process.stdout.write("ready\\n");`,
      ],
      { stdio: "pipe", windowsHide: true },
    );
    child = owned;
    if (owned.pid !== undefined) {
      sendOwner({ type: "child", pid: owned.pid });
    }
    owned.once("error", closed.reject);
    owned.once("close", (code) => {
      sendOwner({ type: "child-closed", code });
      if (code === 0) {
        closed.resolve();
      } else {
        closed.reject(new Error(`Native SQLite child exited with code ${code}`));
      }
    });
    let output = "";
    let ready = false;
    owned.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (!ready && output.includes("ready\n")) {
        ready = true;
        const environment = output.split("\n").find((line) => line.startsWith("environment:"));
        assert.ok(environment);
        const keys: unknown = JSON.parse(environment.slice("environment:".length));
        sendOwner({ type: "child-environment", keys });
        sendTarget({ ready: true, pid: owned.pid });
      }
    });
    owned.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  });
  return owner;
}
