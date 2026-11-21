import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { NodeWorkerPreparedWorkspaceStore } from "./node-worker-prepared-workspace-store.js";
import type { NodeWorkerPreparedWorkspaceRow } from "./node-worker-prepared-workspace-store.kernel.js";

const mock = vi.hoisted(() => ({ execute: vi.fn(), find: vi.fn() }));
vi.mock("./node-worker-journal-worker.js", () => ({
  NodeWorkerJournalWorker: class {
    execute = mock.execute;
  },
}));
vi.mock("./node-worker-prepared-workspace-store.kernel.js", () => ({
  NodeWorkerPreparedWorkspaceKernel: class {
    find = mock.find;
  },
}));

const bound: NodeWorkerPreparedWorkspaceRow = {
  preparation_key: "a".repeat(64),
  cache_key: "b".repeat(64),
  gateway_namespace: "gateway",
  environment_id: "environment",
  workspace_dir: "/synthetic/workspace",
  home_dir: "/synthetic/home",
  source_manifest_ref: `sha256:${"c".repeat(64)}`,
  prepared_manifest_ref: `sha256:${"d".repeat(64)}`,
  state: "bound",
  session_id: "session",
  session_key: "agent:main:session",
  owner_epoch: 1,
  created_at_ms: 1,
  bound_at_ms: 2,
  retired_at_ms: null,
};
const retiring = { ...bound, state: "retiring" };
beforeEach(() => {
  mock.execute.mockReset().mockResolvedValue(undefined);
  mock.find.mockReset().mockReturnValue(bound);
});

describe("prepared workspace mutation admission", () => {
  it.each(["accepted", "refused"] as const)(
    "fences legacy reads through %s retirement",
    async (outcome) => {
      const store = new NodeWorkerPreparedWorkspaceStore({});
      const admitted = createDeferredCore<NodeWorkerPreparedWorkspaceRow>();
      mock.execute.mockReturnValueOnce(admitted.promise);
      expect(store.findSync(bound.environment_id)).toBe(bound);
      const pending = store.beginMutation(bound);
      const failure = new Error("synthetic retirement refused");
      const rejected = outcome === "refused" ? expect(pending).rejects.toBe(failure) : undefined;
      let permit: Awaited<typeof pending> | undefined;
      try {
        expect(() => store.findSync(bound.environment_id)).toThrow(/mutation/i);
        if (!rejected) {
          admitted.resolve(retiring);
          permit = await pending;
          expect(() => store.findSync(bound.environment_id)).toThrow(/mutation/i);
          permit.close();
          expect(store.findSync(bound.environment_id)).toBe(bound);
        }
      } finally {
        if (rejected) {
          admitted.reject(failure);
          await rejected;
        } else {
          admitted.resolve(retiring);
          (permit ?? (await pending)).close();
        }
      }
      expect(store.findSync(bound.environment_id)).toBe(bound);
    },
  );
});
