// Register shared pool mocks before modules that consume them.
// oxfmt-ignore
import { emptyReply, mock, queueTask, source } from "./openclaw-state-read-worker.test-harness.js";
import { expect, it } from "vitest";
import { closeOpenClawStateDatabaseByPathAsync } from "./openclaw-state-db-cache.js";
import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";

it("uses completed admission for later resource closes through the same pool owner", async () => {
  const { pathname, options } = source();
  mock.capabilities.mockReturnValue({
    explicitSqliteCloseReleasesNativeResources: false,
    decided: false,
    reason: "admission pending",
  });
  const early = queueTask();
  early.result.resolve(emptyReply);
  await executeExistingOpenClawStateRead(options, { type: "backup.runs" });
  await closeOpenClawStateDatabaseByPathAsync(pathname);
  expect(mock.rotate).toHaveBeenCalledOnce();
  expect(mock.closeResources).not.toHaveBeenCalled();

  mock.capabilities.mockReturnValue({
    explicitSqliteCloseReleasesNativeResources: true,
    decided: true,
    reason: "native close confirmed",
  });
  const admitted = queueTask();
  admitted.result.resolve(emptyReply);
  await executeExistingOpenClawStateRead(options, { type: "backup.runs" });
  const request = await admitted.captured;
  await closeOpenClawStateDatabaseByPathAsync(pathname);
  expect(mock.closeResources).toHaveBeenCalledExactlyOnceWith(request.expectedIdentity);
  expect(mock.rotate).toHaveBeenCalledOnce();
  expect(mock.create).toHaveBeenCalledOnce();
  expect(mock.closePool).not.toHaveBeenCalled();
});
