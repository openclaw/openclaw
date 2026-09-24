// Register shared pool mocks before modules that consume them.
// oxfmt-ignore
import { emptyReply, queueTask, source } from "./openclaw-state-read-worker.test-harness.js";
import { expect, it } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { createOpenClawStateReadTransport } from "./openclaw-state-read-worker.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";

it("captures and charges the full MCP status batch before queued dispatch", async () => {
  const { options } = source();
  const context = captureOpenClawStateWorkerContext(options);
  const keys = ["principal-根🦞", "second-principal"];
  const expected = [...keys];
  const dispatch = createDeferredCore();
  const baselineTask = queueTask(dispatch.promise);
  const task = queueTask(dispatch.promise);
  const baseline = createOpenClawStateReadTransport({ type: "fleet.list" });
  const transport = createOpenClawStateReadTransport({ type: "mcpOAuth.statuses", input: keys });
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
      Buffer.byteLength("mcpOAuth.statuses") -
      Buffer.byteLength("fleet.list") +
      expected.reduce((bytes, key) => bytes + Buffer.byteLength(key), 0);
    expect(batchOptions.inputBytes).toBe(Number(baselineOptions.inputBytes) + additionalBytes);
    keys[0] = "changed-principal";
    keys.push("added-after-admission");
    dispatch.resolve();
    expect((await task.captured).command).toEqual({ type: "mcpOAuth.statuses", input: expected });
    baselineTask.result.resolve(emptyReply);
    task.result.resolve({
      ok: true,
      type: "mcpOAuth.statuses",
      sourceAdmitted: true,
      value: expected.map(() => ({ state: "unauthenticated" })),
    });
    await Promise.all([baselineRead, read]);
  } finally {
    dispatch.resolve();
    baselineTask.result.resolve(emptyReply);
    task.result.resolve(emptyReply);
    await Promise.allSettled([baselineRead, read]);
    await Promise.all([baseline.close(), transport.close()]);
  }
});
