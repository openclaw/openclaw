import { runSqlitePinnedReadSnapshotSync } from "../../infra/sqlite-pinned-read-snapshot.js";
import {
  requestSqliteWorkerOperationAdmission,
  takeSqliteWorkerOperationAdmissionAttachment,
} from "../../infra/sqlite-worker-operation-admission.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } from "../../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import type {
  WorkerOperationContext,
  WorkerOperationHandlers,
} from "../../state/worker-operation-registry.js";
import * as kernel from "./ingress-queue.kernel.js";
import type { ChannelIngressListInput } from "./ingress-queue.types.js";

type Mutation<Input, Result> = (
  db: OpenClawStateDatabase["db"],
  input: Input,
  now: () => number,
) => Result;

function write<Input, Result>(
  apply: Mutation<Input, Result>,
): (input: Input, context: WorkerOperationContext) => Result;
function write<Input, Result>(
  apply: Mutation<Input, Result>,
  claim: true,
): (input: Input & { customClock?: true }, context: WorkerOperationContext) => Result;
function write<Input, Result>(apply: Mutation<Input, Result>, claim = false) {
  return (
    input: Input & { customClock?: true },
    { open, stateOptions }: WorkerOperationContext,
  ) => {
    const options = stateOptions();
    const database = open();
    let transitionClock: Float64Array | undefined;
    if (claim && input.customClock) {
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
        if (!claim) {
          admitTransaction();
        }
        const result = apply(db, input, () => {
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
  };
}

export const channelIngressOperations = {
  "channelIngress.list": (
    input: ChannelIngressListInput & { readOnly: boolean },
    { open, stateOptions },
  ) => {
    const read = ({ db }: Pick<OpenClawStateDatabase, "db">) =>
      runSqlitePinnedReadSnapshotSync(db, () => kernel.listChannelIngressRowsInDatabase(db, input));
    return input.readOnly
      ? (withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(read, stateOptions()) ?? [])
      : read(open());
  },
  "channelIngress.claimSnapshot": (
    input: Parameters<typeof kernel.readChannelIngressClaimSnapshotInDatabase>[1],
    { open },
  ) => {
    const { db } = open();
    return runSqlitePinnedReadSnapshotSync(db, () =>
      kernel.readChannelIngressClaimSnapshotInDatabase(db, input),
    );
  },
  "channelIngress.staleClaims": (
    input: Parameters<typeof kernel.listStaleChannelIngressClaimsInDatabase>[1],
    { open },
  ) => kernel.listStaleChannelIngressClaimsInDatabase(open().db, input),
  "channelIngress.enqueue": write(kernel.enqueueChannelIngressInDatabase),
  "channelIngress.claim": write(kernel.claimChannelIngressInDatabase, true),
  "channelIngress.claimNext": write(kernel.claimNextChannelIngressInDatabase, true),
  "channelIngress.recover": write(kernel.recoverChannelIngressClaimInDatabase),
  "channelIngress.refresh": write(kernel.refreshChannelIngressClaimInDatabase),
  "channelIngress.complete": write(kernel.completeChannelIngressInDatabase),
  "channelIngress.release": write(kernel.releaseChannelIngressInDatabase),
  "channelIngress.fail": write(kernel.failChannelIngressInDatabase),
  "channelIngress.delete": write(kernel.deleteChannelIngressInDatabase),
  "channelIngress.resubmit": write(kernel.resubmitChannelIngressInDatabase),
  "channelIngress.prune": write(kernel.pruneChannelIngressInDatabase),
  "channelIngress.purge": write(kernel.purgeChannelIngressInDatabase),
} satisfies WorkerOperationHandlers;
