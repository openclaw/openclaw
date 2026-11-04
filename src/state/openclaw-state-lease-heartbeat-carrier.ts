import {
  MessageChannel,
  type MessagePort,
  type Transferable,
  type Worker,
} from "node:worker_threads";
import { postgresPoolTransferList } from "../infra/postgres-sync/pool.js";
import { receiveWorkerMemoryPort } from "../infra/worker-cpu.js";
import { recordWorkerMessage } from "../infra/worker-message-metrics.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  LEASE_CONTENTION_RETRY_MS,
  type LeaseHeartbeatReply,
  type LeaseHeartbeatWorkerData,
} from "./openclaw-state-lease-heartbeat-shared.js";

type CarrierReply = LeaseHeartbeatReply | { closed: true } | { startupError: string } | null;
type Member = {
  channel: Worker | MessagePort;
  closed: ReturnType<typeof createDeferredCore<number>>;
  message?: (reply: CarrierReply) => void;
  failure?: (error: unknown, exitCode?: number, registrationClosed?: boolean) => void;
  stopping: boolean;
};
type Carrier = {
  worker: Worker;
  renewalProgress: SharedArrayBuffer;
  members: Set<Member>;
  online: ReturnType<typeof createDeferredCore<void>>;
  exitCode?: number;
  stopping?: Promise<number>;
};
const carriers = resolveGlobalSingleton(
  Symbol.for("openclaw.stateLeaseHeartbeatCarriers"),
  () => new Map<string, Carrier>(),
);

/** Independent leases share native scheduling, never their ownership or expiry. */
export function acquireLeaseHeartbeatCarrier(params: {
  key: string;
  data: LeaseHeartbeatWorkerData;
  createWorker(): Worker;
}) {
  let carrier = carriers.get(params.key);
  const primary = carrier === undefined;
  if (!carrier) {
    const worker = params.createWorker();
    carrier = {
      worker,
      renewalProgress: params.data.renewalProgress,
      members: new Set(),
      online: createDeferredCore(),
    };
    const owned = carrier;
    void owned.online.promise.catch(() => {});
    carriers.set(params.key, owned);
    worker.once("online", () => owned.online.resolve());
    worker.once("error", (error) => {
      owned.online.reject(error);
      for (const member of owned.members) {
        member.failure?.(error);
      }
    });
    worker.once("exit", (code) => {
      owned.exitCode = code;
      owned.online.reject(new Error("State lease heartbeat carrier exited before startup"));
      if (carriers.get(params.key) === owned) {
        carriers.delete(params.key);
      }
      for (const member of owned.members) {
        member.failure?.(
          new Error(`State lease heartbeat carrier exited (exitCode=${code})`),
          code,
        );
        member.closed.resolve(code);
      }
      owned.members.clear();
    });
    worker.stdout?.resume();
    worker.stderr?.resume();
  }
  const owned = carrier;
  const ports = primary ? undefined : new MessageChannel();
  const member: Member = {
    channel: ports?.port1 ?? owned.worker,
    closed: createDeferredCore<number>(),
    stopping: false,
  };
  owned.members.add(member);
  const stopCarrier = () => {
    if (!owned.stopping) {
      if (carriers.get(params.key) === owned) {
        carriers.delete(params.key);
      }
      owned.stopping = (async () => {
        // Closed members admit no new SQLite work. Join the in-flight operation:
        // terminating inside a native write can strand its connection's write lock.
        const progress = new BigInt64Array(owned.renewalProgress);
        let observed = Atomics.load(progress, 0);
        while (observed % 2n === 1n && owned.exitCode === undefined) {
          await Atomics.waitAsync(progress, 0, observed, LEASE_CONTENTION_RETRY_MS).value;
          observed = Atomics.load(progress, 0);
        }
        return owned.exitCode ?? owned.worker.terminate();
      })();
      void owned.stopping.catch(() => {
        owned.stopping = undefined;
      });
    }
    return owned.stopping;
  };
  const closed = () => {
    if (!owned.members.delete(member)) {
      return;
    }
    member.channel.off("message", receive);
    if (!member.stopping) {
      member.failure?.(new Error("State lease heartbeat registration closed"), undefined, true);
    }
    if (owned.members.size === 0) {
      void stopCarrier().then(member.closed.resolve, member.closed.reject);
    } else {
      member.closed.resolve(0);
    }
  };
  const receive = (reply: CarrierReply) => {
    if (primary && receiveWorkerMemoryPort(owned.worker, reply)) {
      return;
    }
    if (ports) {
      recordWorkerMessage("lifecycle", "from_worker");
    }
    if (reply && "closed" in reply) {
      closed();
    } else if (reply && "startupError" in reply && member.stopping) {
      // A failed native close cannot strand this lease or leave shared custody uncertain.
      void stopCarrier().catch(member.closed.reject);
    } else {
      member.message?.(reply);
    }
  };
  member.channel.on("message", receive);
  ports?.port1.once("close", closed);
  if (ports) {
    params.data.renewalProgress = owned.renewalProgress;
    try {
      owned.worker.postMessage({ registration: params.data, port: ports.port2 }, [
        params.data.databaseAdmissionPort,
        params.data.lossPort,
        ...postgresPoolTransferList(params.data.postgresPool),
        ports.port2,
      ]);
    } catch (error) {
      owned.members.delete(member);
      ports.port1.close();
      ports.port2.close();
      throw error;
    }
  }
  return {
    online: owned.online.promise,
    closed: member.closed.promise,
    get pending() {
      return (
        owned.members.has(member) || (owned.members.size === 0 && owned.exitCode === undefined)
      );
    },
    onMessage(receiveMessage: Member["message"]) {
      member.message = receiveMessage;
    },
    onFailure(fail: Member["failure"]) {
      member.failure = fail;
    },
    postMessage(value: unknown, transferList: Transferable[]) {
      member.channel.postMessage(value, transferList);
      if (ports) {
        recordWorkerMessage("lifecycle", "to_worker");
      }
    },
    close(): Promise<number> {
      member.stopping = true;
      if (owned.members.size === 0 || (owned.members.size === 1 && owned.members.has(member))) {
        return stopCarrier();
      }
      if (owned.members.has(member)) {
        member.channel.postMessage({ close: true }, []);
        if (ports) {
          recordWorkerMessage("lifecycle", "to_worker");
        }
      }
      return member.closed.promise;
    },
  };
}

export type LeaseHeartbeatCarrier = ReturnType<typeof acquireLeaseHeartbeatCarrier>;
