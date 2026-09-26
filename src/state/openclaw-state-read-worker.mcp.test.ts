// Register shared pool mocks before modules that consume them.
// oxfmt-ignore
import { emptyReply, queueTask, source } from "./openclaw-state-read-worker.test-harness.js";
import { expect, it } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { createOpenClawStateReadTransport } from "./openclaw-state-read-worker.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";

it.each(["mcpOAuth.statuses", "userPreferences.values"] as const)(
  "captures and charges the full %s batch before queued dispatch",
  async (type) => {
    const { options } = source();
    const context = captureOpenClawStateWorkerContext(options);
    const keys = ["principal-根🦞", "second-principal"];
    const expected = [...keys];
    const dispatch = createDeferredCore();
    const baselineTask = queueTask(dispatch.promise);
    const task = queueTask(dispatch.promise);
    const baseline = createOpenClawStateReadTransport({ type: "fleet.list" });
    const key = "notification-根🦞";
    const transport = createOpenClawStateReadTransport(
      type === "mcpOAuth.statuses" ? { type, input: keys } : { type, profileIds: keys, key },
    );
    const controller = new AbortController();
    const authority = {
      signal: controller.signal,
      assertCurrent: context.admission.assertCurrent,
    };
    const location = { context, location: options.path, checkFreshAdmission: true };
    const baselineRead = baseline.read(location, authority);
    const read = transport.read(location, authority);
    try {
      const [baselineOptions, batchOptions] = await Promise.all([
        baselineTask.submitted,
        task.submitted,
      ]);
      const additionalBytes =
        Buffer.byteLength(type) -
        Buffer.byteLength("fleet.list") +
        expected.reduce((bytes, profileId) => bytes + Buffer.byteLength(profileId), 0) +
        (type === "userPreferences.values" ? Buffer.byteLength(key) : 0);
      expect(batchOptions.inputBytes).toBe(Number(baselineOptions.inputBytes) + additionalBytes);
      keys[0] = "changed-principal";
      keys.push("added-after-admission");
      dispatch.resolve();
      expect((await task.captured).command).toEqual(
        type === "mcpOAuth.statuses"
          ? { type, input: expected }
          : { type, profileIds: expected, key },
      );
      baselineTask.result.resolve(emptyReply);
      task.result.resolve(
        type === "mcpOAuth.statuses"
          ? {
              ok: true,
              type,
              sourceAdmitted: true,
              value: expected.map(() => ({ state: "unauthenticated" })),
            }
          : { ok: true, type, sourceAdmitted: true, values: new Map() },
      );
      await Promise.all([baselineRead, read]);
    } finally {
      dispatch.resolve();
      baselineTask.result.resolve(emptyReply);
      task.result.resolve(emptyReply);
      await Promise.allSettled([baselineRead, read]);
      await Promise.all([baseline.close(), transport.close()]);
    }
  },
);
