import assert from "node:assert/strict";
import { expect, it } from "vitest";
import { encodeOpenClawStateWorkerError } from "../state/openclaw-state-worker-error.js";
import { receiveSqliteWorkerReply } from "./sqlite-worker-broker-reply.js";
import type { Job } from "./sqlite-worker-broker.types.js";

it("hydrates cached-context execute-frame errors without an explicit request context", () => {
  const original = Object.assign(
    new Error("Synthetic preparation failure", { cause: new Error("Synthetic read failure") }),
    { code: "EIO", errno: -5 },
  );
  const sharedState = encodeOpenClawStateWorkerError(original, { includeOrdinary: true });
  assert(sharedState);
  const unexpected = () => {
    throw new Error("Failed continuation must not dispatch or finish successfully");
  };
  const job: Job = {
    observation: { started() {}, completed() {} },
    request: { type: "execute-frame", id: 1, actor: 1, input: new Uint8Array() },
    bytes: 0,
    resolve: unexpected,
    reject: unexpected,
    detach: unexpected,
  };
  let failure: unknown;

  receiveSqliteWorkerReply(
    { current: job, worker: { postMessage: unexpected } },
    {
      id: 1,
      ok: false,
      error: {
        name: "Error",
        message: "Synthetic preparation failure",
        code: "EIO",
        sharedState: structuredClone(sharedState),
      },
    },
    {
      fail(error) {
        failure = error;
      },
      finish: unexpected,
      dispatch: unexpected,
    },
  );

  expect(failure).toBeInstanceOf(Error);
  expect(failure).toMatchObject({
    message: "Synthetic preparation failure",
    code: "EIO",
    errno: -5,
    cause: { message: "Synthetic read failure" },
  });
});
