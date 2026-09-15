import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { SqliteWorkerBackend } from "./sqlite-worker-contract.js";
import {
  requestSqliteWorkerOperationAdmission,
  takeSqliteWorkerOperationAdmissionAttachment,
} from "./sqlite-worker-operation-admission.js";

export type AttachmentFixtureOperations = {
  inspect: {
    input: { value: string };
    output: { length: number; digest: string; executions: number };
  };
};

/** JS-only backend: no database handle, schema, filesystem, or native coordinator. */
export function createSqliteWorkerBackend(): SqliteWorkerBackend<AttachmentFixtureOperations> {
  let executions = 0;
  return {
    execute(command) {
      assert.equal(command.type, "inspect");
      assert.deepEqual(Object.keys(command.input), ["value"]);
      assert.equal(typeof command.input.value, "string");
      const attachment = takeSqliteWorkerOperationAdmissionAttachment();
      assert(attachment !== null && typeof attachment === "object");
      assert("word" in attachment && attachment.word instanceof SharedArrayBuffer);
      assert.equal(attachment.word.byteLength, 32);
      assert("label" in attachment && attachment.label === "ordinary-attachment");
      assert.throws(takeSqliteWorkerOperationAdmissionAttachment, /attachment is unavailable/);
      requestSqliteWorkerOperationAdmission({ stage: "prepare", facts: "ordinary-js-backend" });
      const word = new Int32Array(attachment.word);
      assert.equal(Atomics.add(word, 0, 1), 0);
      executions++;
      return {
        length: command.input.value.length,
        digest: createHash("sha256").update(command.input.value).digest("hex"),
        executions,
      };
    },
    close() {},
  };
}
