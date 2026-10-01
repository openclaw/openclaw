import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
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
  let closePending = false;
  const permission = createDeferredCore();
  const firstFailurePermission = createDeferredCore();
  const custodyAck = createDeferredCore();
  let acknowledgments = 0;
  let fences = 0;
  const gateFirstFailure = input.gateFirstFailure === true;
  const requireCustodyAck = input.requireCustodyAck === true;
  const childWatchdogMs = input.lateAttachment === true ? 40_000 : 12_000;
  ownerPort.on("message", (message) => {
    assert.ok(isRecord(message));
    if (message.type === "permit-close") {
      permission.resolve();
    }
    if (message.type === "fail-first-close") {
      firstFailurePermission.resolve();
    }
    if (message.type === "close-barrier") {
      sendOwner({ type: "close-barrier", attempts, pending: closePending });
    }
    if (message.type === "custody-ack") {
      sendOwner({ type: "custody-ack", count: ++acknowledgments });
      custodyAck.resolve();
    }
    if (message.type === "fixture-fence") {
      sendOwner({ type: "fixture-fence", count: ++fences });
      throw Object.assign(
        new RangeError("synthetic owner fence failure", {
          cause: Object.assign(new TypeError("synthetic owner fence cause"), {
            code: "E_NATIVE_FENCE_CAUSE",
          }),
        }),
        { code: "E_NATIVE_FENCE" },
      );
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
  let childClosed = false;
  const closeReceiptPath = input.closeReceiptPath;
  assert.ok(closeReceiptPath === undefined || typeof closeReceiptPath === "string");
  const closed = createDeferredCore();
  void closed.promise.catch(() => undefined);
  const owner: NativeWorkerResourceOwner = {
    async close() {
      closePending = true;
      try {
        sendOwner({ type: "close-attempt", attempt: ++attempts });
        if (attempts === 1) {
          if (gateFirstFailure) {
            await waitForPermission(firstFailurePermission);
          }
          throw new Error("synthetic first resource close failure");
        }
        if (!child || childClosed) {
          return;
        }
        process.stderr.write(`native resource pid=${process.pid}: awaiting close permission\n`);
        if (requireCustodyAck) {
          await waitForPermission(custodyAck);
        }
        await waitForPermission(permission);
        child.stdin.end("close\n");
        await closed.promise;
      } finally {
        closePending = false;
      }
    },
  };

  // The factory returns its owner before a queued target request can spawn native work.
  port.on("message", (message) => {
    assert.ok(isRecord(message));
    if (message.type === "owner-reply-barrier") {
      sendOwner({ type: "owner-reply-barrier", acknowledgments, fences });
      return;
    }
    if (message.type === "domain-close") {
      void owner.close().then(
        () => sendTarget({ domainClosed: true }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          sendTarget({ domainClosed: false, error: error.message });
        },
      );
      return;
    }
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
    owned.once("close", (code, signal) => {
      childClosed = true;
      if (closeReceiptPath !== undefined) {
        // Persist only this original ChildProcess.close fact, before a sealed port can refuse it.
        const temporary = `${closeReceiptPath}.partial`;
        writeFileSync(temporary, JSON.stringify({ kind: "child-close", code, signal }));
        renameSync(temporary, closeReceiptPath);
      }
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
