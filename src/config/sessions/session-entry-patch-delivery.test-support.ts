import { afterEach, vi } from "vitest";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";

// mock-isolation: Entry assertions exclude the maintenance owner's background writes and timers.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
// mock-isolation: Disk-budget sweeps must not mutate the fixture outside its explicit entry writes.
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

const delivery = vi.hoisted(() => ({
  afterPrepare: undefined as (() => void) | undefined,
  afterCommit: undefined as (() => void) | undefined,
  beforeCommit: undefined as (() => void) | undefined,
  commands: [] as string[],
}));
vi.mock("../../state/openclaw-agent-execution.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/openclaw-agent-execution.js")>();
  const { decorateSessionExecutionCaptures } =
    await import("./session-execution-delivery.test-support.js");
  return {
    ...actual,
    ...decorateSessionExecutionCaptures(actual, (worker) => ({
      execute: async (command, commandOptions) => {
        delivery.commands.push(command.type);
        if (command.type === "session.entry.patch.commit") {
          delivery.beforeCommit?.();
        }
        const result = await worker.execute(command, commandOptions);
        if (command.type === "session.entry.patch.prepare") {
          delivery.afterPrepare?.();
        }
        if (command.type === "session.entry.patch.commit") {
          delivery.afterCommit?.();
        }
        return result;
      },
    })),
  };
});

afterEach(() => {
  delivery.afterPrepare = undefined;
  delivery.afterCommit = undefined;
  delivery.beforeCommit = undefined;
  delivery.commands = [];
  vi.restoreAllMocks();
});

export function getSessionEntryPatchDelivery() {
  return delivery;
}

export function observeCommitAdmission() {
  let current: admission.SqliteWorkerOperationAdmission | undefined;
  const create = admission.createSqliteWorkerOperationAdmission;
  vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementation(
    (callback, attachment) => {
      const owned = create((request, grant) => {
        if (request.stage === "commit") {
          current = owned;
        }
        callback(request, grant);
      }, attachment);
      return owned;
    },
  );
  return () => current;
}
