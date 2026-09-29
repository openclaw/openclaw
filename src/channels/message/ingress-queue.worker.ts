import { runSqlitePinnedReadSnapshotSync } from "../../infra/sqlite-pinned-read-snapshot.js";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import {
  requestSqliteWorkerOperationAdmission,
  takeSqliteWorkerOperationAdmissionAttachment,
} from "../../infra/sqlite-worker-operation-admission.js";
import type {
  OpenClawStateDatabase,
  OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db-contract.js";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } from "../../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import * as kernel from "./ingress-queue.kernel.js";
import type { ChannelIngressWorkerOperations } from "./ingress-queue.worker-contract.js";

const kernels: {
  [Kind in keyof ChannelIngressWorkerOperations]: (
    db: OpenClawStateDatabase["db"],
    input: ChannelIngressWorkerOperations[Kind]["input"],
    now: () => number,
  ) => ChannelIngressWorkerOperations[Kind]["output"];
} = {
  "channelIngress.list": kernel.listChannelIngressRowsInDatabase,
  "channelIngress.claimSnapshot": kernel.readChannelIngressClaimSnapshotInDatabase,
  "channelIngress.staleClaims": kernel.listStaleChannelIngressClaimsInDatabase,
  "channelIngress.enqueue": kernel.enqueueChannelIngressInDatabase,
  "channelIngress.claim": kernel.claimChannelIngressInDatabase,
  "channelIngress.claimNext": kernel.claimNextChannelIngressInDatabase,
  "channelIngress.recover": kernel.recoverChannelIngressClaimInDatabase,
  "channelIngress.refresh": kernel.refreshChannelIngressClaimInDatabase,
  "channelIngress.complete": kernel.completeChannelIngressInDatabase,
  "channelIngress.release": kernel.releaseChannelIngressInDatabase,
  "channelIngress.fail": kernel.failChannelIngressInDatabase,
  "channelIngress.delete": kernel.deleteChannelIngressInDatabase,
  "channelIngress.resubmit": kernel.resubmitChannelIngressInDatabase,
  "channelIngress.prune": kernel.pruneChannelIngressInDatabase,
  "channelIngress.purge": kernel.purgeChannelIngressInDatabase,
};

export function isChannelIngressCommand(command: {
  type: string;
}): command is { type: keyof ChannelIngressWorkerOperations } {
  return Object.hasOwn(kernels, command.type);
}

export function executeChannelIngressCommand(
  command: SqliteWorkerCommand<ChannelIngressWorkerOperations>,
  options: OpenClawStateDatabaseOptions,
  open: () => OpenClawStateDatabase,
): ChannelIngressWorkerOperations[keyof ChannelIngressWorkerOperations]["output"] {
  if (command.type === "channelIngress.list") {
    const read = ({ db }: Pick<OpenClawStateDatabase, "db">) =>
      runSqlitePinnedReadSnapshotSync(db, () =>
        kernel.listChannelIngressRowsInDatabase(db, command.input),
      );
    return command.input.readOnly
      ? (withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(read, options) ?? [])
      : read(open());
  }
  const database = open();
  if (command.type === "channelIngress.claimSnapshot") {
    return runSqlitePinnedReadSnapshotSync(database.db, () =>
      kernel.readChannelIngressClaimSnapshotInDatabase(database.db, command.input),
    );
  }
  if (command.type === "channelIngress.staleClaims") {
    return kernel.listStaleChannelIngressClaimsInDatabase(database.db, command.input);
  }
  let transitionClock: Float64Array | undefined;
  if (
    (command.type === "channelIngress.claim" || command.type === "channelIngress.claimNext") &&
    command.input.customClock
  ) {
    const attachment = takeSqliteWorkerOperationAdmissionAttachment();
    if (
      !(attachment instanceof Float64Array) ||
      !(attachment.buffer instanceof SharedArrayBuffer) ||
      attachment.length !== 1
    ) {
      throw new Error("Channel ingress claim requires its admitted clock attachment");
    }
    transitionClock = attachment;
  }
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      let admitted = false;
      const admitTransaction = () => {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        admitted = true;
      };
      if (command.type !== "channelIngress.claim" && command.type !== "channelIngress.claimNext") {
        admitTransaction();
      }
      const result = executeInTransaction(db, command, () => {
        admitTransaction();
        return transitionClock?.[0] ?? Date.now();
      });
      // A changed claim snapshot returns without entering its transition.
      if (!admitted) {
        admitTransaction();
      }
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      return result;
    },
    { path: database.path, env: options.env },
  );
}

function executeInTransaction<
  Kind extends Exclude<
    keyof ChannelIngressWorkerOperations,
    "channelIngress.list" | "channelIngress.claimSnapshot" | "channelIngress.staleClaims"
  >,
>(
  db: OpenClawStateDatabase["db"],
  command: {
    [Key in Kind]: { type: Key; input: ChannelIngressWorkerOperations[Key]["input"] };
  }[Kind],
  now: () => number,
) {
  return kernels[command.type](db, command.input, now);
}
