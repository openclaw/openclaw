import { expect, it, onTestFinished } from "vitest";
import type { SqliteWorkerAdmissionRequest } from "../../infra/sqlite-worker-operation-admission.js";
import { createSessionWorkerExecutionSource } from "./session-worker-execution-source.js";

it("refuses commit when session source authority expires after transaction admission", () => {
  let current = true;
  const revoked = new Error("Session source authority revoked");
  const source = createSessionWorkerExecutionSource(() => {
    if (!current) {
      throw revoked;
    }
  }, "Session operation expired");
  const { admission } = source.createAdmission({
    attachment: { kind: "agent-execution", startupJournal: false },
    nativeLocations: [],
    authorize() {},
    assertCurrent() {},
  })({ settled: new Promise(() => {}) });
  onTestFinished(() => admission.finish());

  const request = (stage: SqliteWorkerAdmissionRequest["stage"]) => {
    const decision = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    admission.port.postMessage({ stage, decision: decision.buffer }, []);
    admission.service();
    return Atomics.load(decision, 0);
  };

  expect(request("transaction")).toBe(1);
  current = false;
  expect(request("commit")).toBe(2);
  expect(admission.failure).toBe(revoked);
});
