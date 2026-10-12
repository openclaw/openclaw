import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { required, type WorkerSessionPlacementRecord } from "./placement-record.js";
import { capturePlacementReplicaRead } from "./placement-turn-authority.js";

export function createPlacementReadStore(params: {
  path: string;
  withWorkspaceResultConflict: (
    record: WorkerSessionPlacementRecord | undefined,
  ) => WorkerSessionPlacementRecord | undefined;
}) {
  const context = captureOpenClawStateWorkerContext({ path: params.path });
  const decorate = (records: WorkerSessionPlacementRecord[]) => {
    context.admission.assertCurrent();
    return records.map((record) => params.withWorkspaceResultConflict(record)!);
  };
  const read = async (sessionIds?: readonly string[]) => {
    const publish = capturePlacementReplicaRead(context.admission.identity);
    const records = await runOpenClawStateWorkerOperation(context, (scope) =>
      scope.execute({ type: "workerPlacements.read", input: { sessionIds } }),
    );
    const decorated = decorate(records);
    publish(records, sessionIds);
    return decorated;
  };
  const getManyAsync = async (
    sessionIds: readonly string[],
  ): Promise<ReadonlyMap<string, WorkerSessionPlacementRecord>> => {
    const ids = [...new Set(sessionIds.map((id) => required(id, "session id")))];
    context.admission.assertCurrent();
    const records = ids.length ? await read(ids) : [];
    return new Map(records.map((record) => [record.sessionId, record]));
  };
  return {
    getManyAsync,
    async getAsync(sessionId: string) {
      const id = required(sessionId, "session id");
      return (await getManyAsync([id])).get(id);
    },
    async getWithMoveAsync(sessionId: string) {
      const id = required(sessionId, "session id");
      const publish = capturePlacementReplicaRead(context.admission.identity);
      const result = await runOpenClawStateWorkerOperation(context, (scope) =>
        scope.execute({ type: "workerPlacements.readWithMove", input: { sessionId: id } }),
      );
      publish(result.placement ? [result.placement] : [], [id]);
      const [placement] = decorate(result.placement ? [result.placement] : []);
      return { ...result, placement };
    },
    listAsync: () => read(),
    async getPlacementMoveAsync(sessionId: string) {
      const id = required(sessionId, "move session id");
      const move = await runOpenClawStateWorkerOperation(context, (scope) =>
        scope.execute({
          type: "workerPlacements.readMove",
          input: { sessionId: id },
        }),
      );
      context.admission.assertCurrent();
      return move;
    },
    async listForReconcileAsync(sessionKey?: string) {
      const publish = capturePlacementReplicaRead(context.admission.identity);
      const records = decorate(
        await runOpenClawStateWorkerOperation(context, (scope) =>
          scope.execute({ type: "workerPlacements.readReconcile", input: { sessionKey } }),
        ),
      );
      publish(records);
      return records;
    },
  };
}
