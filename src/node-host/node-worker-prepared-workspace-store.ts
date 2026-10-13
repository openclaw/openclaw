import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import type {
  NodeWorkerPreparedWorkspaceBinding,
  NodeWorkerPreparedWorkspaceRegistration,
} from "../worker/node-workspace-prepared-protocol.js";
import { NodeWorkerJournalWorker } from "./node-worker-journal-worker.js";
import type { NodeWorkerJournalAuthority } from "./node-worker-journal.types.js";
import type { NodeWorkerPreparedWorkspaceRow } from "./node-worker-prepared-workspace-store.kernel.js";

export type { NodeWorkerPreparedWorkspaceRow } from "./node-worker-prepared-workspace-store.kernel.js";

/** Prepared workspace persistence shares the node journal's admission and settlement owner. */
export class NodeWorkerPreparedWorkspaceStore {
  private readonly worker: NodeWorkerJournalWorker;
  constructor(options: Pick<OpenClawStateDatabaseOptions, "env" | "path">) {
    this.worker = new NodeWorkerJournalWorker({
      env: options.env,
      path: options.path,
    });
  }

  find(environmentId: string): Promise<NodeWorkerPreparedWorkspaceRow | undefined> {
    return this.worker.run(
      (scope) => scope.execute({ type: "nodeWorker.prepared.find", input: [environmentId] }),
      undefined,
      { existingOnly: true },
    );
  }

  async assertCurrent(expected: NodeWorkerPreparedWorkspaceRow): Promise<void> {
    const row = await this.find(expected.environment_id);
    if (!row || JSON.stringify(row) !== JSON.stringify(expected)) {
      throw new Error("INVALID_REQUEST: prepared workspace ownership changed");
    }
  }

  async list(gatewayNamespace: string): Promise<NodeWorkerPreparedWorkspaceRow[]> {
    return (
      (await this.worker.run(
        (scope) => scope.execute({ type: "nodeWorker.prepared.list", input: [gatewayNamespace] }),
        undefined,
        { existingOnly: true },
      )) ?? []
    );
  }

  register(
    input: NodeWorkerPreparedWorkspaceRegistration,
    authority?: NodeWorkerJournalAuthority,
  ): Promise<NodeWorkerPreparedWorkspaceRow> {
    return this.worker.execute({ type: "nodeWorker.prepared.register", input: [input] }, authority);
  }

  bind(
    input: NodeWorkerPreparedWorkspaceBinding,
    authority?: NodeWorkerJournalAuthority,
  ): Promise<NodeWorkerPreparedWorkspaceRow> {
    return this.worker.execute({ type: "nodeWorker.prepared.bind", input: [input] }, authority);
  }

  /** A lost permit stays retiring after restart; only its verified completion can reopen it. */
  async beginMutation(
    expected: NodeWorkerPreparedWorkspaceRow,
    authority?: NodeWorkerJournalAuthority,
  ): Promise<{ complete: () => Promise<void> }> {
    if (expected.state !== "bound") {
      throw new Error("INVALID_REQUEST: prepared workspace is not bound");
    }
    const retiring = await this.retire(expected, false, authority);
    return {
      complete: async () => {
        await this.worker.execute(
          { type: "nodeWorker.prepared.completeMutation", input: [retiring] },
          authority,
        );
      },
    };
  }

  retire(
    expected: NodeWorkerPreparedWorkspaceRow,
    completed = false,
    authority?: NodeWorkerJournalAuthority,
  ): Promise<NodeWorkerPreparedWorkspaceRow> {
    return this.worker.execute(
      { type: "nodeWorker.prepared.retire", input: [expected, completed] },
      authority,
    );
  }
}
