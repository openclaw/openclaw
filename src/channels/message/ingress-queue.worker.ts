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

export function isChannelIngressCommand(command: {
  type: string;
}): command is { type: keyof ChannelIngressWorkerOperations } {
  return (
    command.type === "channelIngress.list" ||
    command.type === "channelIngress.claimSnapshot" ||
    command.type === "channelIngress.staleClaims" ||
    command.type === "channelIngress.enqueue" ||
    command.type === "channelIngress.claim" ||
    command.type === "channelIngress.claimNext" ||
    command.type === "channelIngress.recover" ||
    command.type === "channelIngress.refresh" ||
    command.type === "channelIngress.complete" ||
    command.type === "channelIngress.release" ||
    command.type === "channelIngress.fail" ||
    command.type === "channelIngress.delete" ||
    command.type === "channelIngress.resubmit" ||
    command.type === "channelIngress.prune" ||
    command.type === "channelIngress.purge"
  );
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

function executeInTransaction(
  db: OpenClawStateDatabase["db"],
  command: Exclude<
    SqliteWorkerCommand<ChannelIngressWorkerOperations>,
    { type: "channelIngress.list" | "channelIngress.claimSnapshot" | "channelIngress.staleClaims" }
  >,
  now: () => number,
) {
  switch (command.type) {
    case "channelIngress.enqueue":
      return kernel.enqueueChannelIngressInDatabase(db, command.input);
    case "channelIngress.claim":
      return kernel.claimChannelIngressInDatabase(db, command.input, now);
    case "channelIngress.claimNext":
      return kernel.claimNextChannelIngressInDatabase(db, command.input, now);
    case "channelIngress.recover":
      return kernel.recoverChannelIngressClaimInDatabase(db, command.input);
    case "channelIngress.refresh":
      return kernel.refreshChannelIngressClaimInDatabase(db, command.input);
    case "channelIngress.complete":
      return kernel.completeChannelIngressInDatabase(db, command.input);
    case "channelIngress.release":
      return kernel.releaseChannelIngressInDatabase(db, command.input);
    case "channelIngress.fail":
      return kernel.failChannelIngressInDatabase(db, command.input);
    case "channelIngress.delete":
      return kernel.deleteChannelIngressInDatabase(db, command.input);
    case "channelIngress.resubmit":
      return kernel.resubmitChannelIngressInDatabase(db, command.input);
    case "channelIngress.prune":
      return kernel.pruneChannelIngressInDatabase(db, command.input);
    case "channelIngress.purge":
      return kernel.purgeChannelIngressInDatabase(db, command.input);
  }
  return command satisfies never;
}
