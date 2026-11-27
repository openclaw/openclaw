import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  applyAgentDatabaseReaderRequest,
  captureDeletedAgentDatabaseFences,
  installDeletedAgentDatabaseFences,
} from "../infra/agent-database-readers.js";
import * as workerPools from "../infra/worker-task-pool-registry.js";
import { reviveAgentDatabasesAfterConfigCommit } from "./server-reload-agent-databases.js";

let previousFences: ReturnType<typeof captureDeletedAgentDatabaseFences>;
beforeEach(() => {
  previousFences = captureDeletedAgentDatabaseFences();
  installDeletedAgentDatabaseFences([]);
});
afterEach(() => {
  installDeletedAgentDatabaseFences(previousFences);
  vi.restoreAllMocks();
});

it.each([
  { admitted: ["new-agent"], revived: false },
  { admitted: ["new-agent", "returning-agent"], revived: true },
])("reconciles only admitted deleted owners ($revived)", async ({ admitted, revived }) => {
  const returning = path.resolve("returning-agent-test.sqlite");
  const departed = path.resolve("departed-agent-test.sqlite");
  for (const { agentId, pathname } of [
    { agentId: "returning-agent", pathname: returning },
    { agentId: "departed-agent", pathname: departed },
  ]) {
    await applyAgentDatabaseReaderRequest({
      kind: "close",
      candidates: [{ path: pathname }],
      deleted: true,
      agentId,
    });
  }
  const broadcasts = vi.spyOn(workerPools, "closeWorkerTaskPoolResources");
  const warn = vi.fn();
  await reviveAgentDatabasesAfterConfigCommit(admitted, warn);
  expect(warn).not.toHaveBeenCalled();
  expect(broadcasts).toHaveBeenCalledTimes(revived ? 1 : 0);
  expect(captureDeletedAgentDatabaseFences()).toEqual(
    revived
      ? [[departed, "departed-agent"]]
      : [
          [returning, "returning-agent"],
          [departed, "departed-agent"],
        ],
  );
});
