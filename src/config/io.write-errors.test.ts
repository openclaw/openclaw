import { expect, it } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { ConfigWritePostCommitError, recoverConfigWriteFailure } from "./io.write-errors.js";

it("settles asynchronous compensation before reporting a committed write failure", async () => {
  const started = createDeferredCore();
  const compensation = createDeferredCore();
  const writeFailure = new Error("runtime activation failed");
  const compensationFailure = new Error("snapshot owner retired");
  let settled = false;
  const outcome = recoverConfigWriteFailure({
    configPath: "/fixture/openclaw.json",
    cause: writeFailure,
    restoreFile: async () => true,
    restoreEffects: () => {
      started.resolve();
      return compensation.promise;
    },
  }).catch((error: unknown) => {
    settled = true;
    return error;
  });

  await started.promise;
  await Promise.resolve();
  expect(settled).toBe(false);
  compensation.reject(compensationFailure);

  const failure = await outcome;
  expect(failure).toBeInstanceOf(ConfigWritePostCommitError);
  expect(failure).toMatchObject({
    rollbackStatus: "restored",
    cause: { errors: [writeFailure, compensationFailure] },
  });
});
