import { resolveRuntimeProcessEntrypointUrl } from "../../infra/runtime-process-url.js";
import { resolveRuntimeWorkerThreadExecArgv } from "../../infra/runtime-worker-url.js";
import { createCpuTrackedWorker } from "../../infra/worker-cpu.js";
import { createDeferredCore, type Deferred } from "../../shared/deferred.js";
import { copySecretSentinelDecryptionKey } from "../sentinel.js";
import type { SecretEgressCertificateStatus } from "./certificates.js";
import type {
  SecretEgressProcessGrant,
  SecretEgressProxyAuditEvent,
  SecretEgressSentinelBinding,
} from "./proxy-server.js";
import type {
  SecretEgressWorkerCommand,
  SecretEgressWorkerData,
  SecretEgressWorkerMessage,
  SecretEgressWorkerReady,
  SecretEgressWorkerReply,
} from "./proxy-worker.types.js";

export type SecretEgressProxyWorkerHandle = {
  caCertPath: string;
  proxyOrigin: string;
  registerProcess: (
    bindings?: readonly SecretEgressSentinelBinding[],
  ) => Promise<SecretEgressProcessGrant>;
  getCertificateStatus: () => Promise<SecretEgressCertificateStatus>;
  stop: () => Promise<void>;
};

/** The Gateway exchanges grants and health only; all network bytes stay in this Worker. */
export async function startSecretEgressProxyWorker(params: {
  caDir: string;
  allowedHosts?: readonly string[];
  bypassHosts?: readonly string[];
  onAudit: (event: SecretEgressProxyAuditEvent) => void;
  onFailure?: () => void;
}): Promise<SecretEgressProxyWorkerHandle> {
  const authority = new Int32Array(new SharedArrayBuffer(4));
  const decryptionKey = copySecretSentinelDecryptionKey();
  const workerUrl = resolveRuntimeProcessEntrypointUrl("secretEgressProxy");
  const worker = createCpuTrackedWorker(workerUrl, {
    execArgv: resolveRuntimeWorkerThreadExecArgv(workerUrl),
    workerData: {
      caDir: params.caDir,
      allowedHosts: params.allowedHosts,
      bypassHosts: params.bypassHosts,
      authority,
      decryptionKey,
    } satisfies SecretEgressWorkerData,
    stdout: true,
    stderr: true,
  });
  decryptionKey.fill(0);
  // Only the typed audit protocol may reach Gateway logs.
  worker.stdout.resume();
  worker.stderr.resume();
  const ready = createDeferredCore<SecretEgressWorkerReady>();
  const exited = createDeferredCore();
  const pending = new Map<number, Deferred<SecretEgressWorkerReply>>();
  let nextId = 0;
  let failure: Error | undefined;
  let stopping: Promise<void> | undefined;
  const fail = () => {
    if (failure) {
      return;
    }
    failure = new Error("Secret egress proxy Worker is unavailable; restart the Gateway.");
    Atomics.store(authority, 0, 1);
    ready.reject(failure);
    for (const request of pending.values()) {
      request.reject(failure);
    }
    pending.clear();
    if (!stopping) {
      params.onFailure?.();
    }
  };
  worker.on("error", fail);
  worker.once("exit", (code) => {
    if (!stopping || code !== 0 || pending.size > 0) {
      fail();
    }
    exited.resolve();
  });
  worker.on("message", (message: SecretEgressWorkerMessage) => {
    if (message.kind === "ready") {
      ready.resolve(message);
    } else if (message.kind === "fatal") {
      fail();
    } else if (message.kind === "audit") {
      params.onAudit(message.event);
    } else {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.kind === "failed") {
        request?.reject(new Error("Secret egress proxy operation failed."));
      } else {
        request?.resolve(message);
      }
    }
  });
  const request = (command: SecretEgressWorkerCommand) => {
    if (failure) {
      return Promise.reject(failure);
    }
    const deferred = createDeferredCore<SecretEgressWorkerReply>();
    pending.set(command.id, deferred);
    try {
      worker.postMessage(command, []);
    } catch {
      fail();
    }
    return deferred.promise;
  };
  let address: SecretEgressWorkerReady;
  try {
    address = await ready.promise;
  } catch (error) {
    await exited.promise;
    throw error;
  }
  return {
    caCertPath: address.caCertPath,
    proxyOrigin: address.proxyOrigin,
    registerProcess: async (bindings = []) => {
      if (Atomics.load(authority, 0) !== 0) {
        throw failure ?? new Error("Secret egress proxy has stopped");
      }
      const grantAuthority = new Int32Array(new SharedArrayBuffer(4));
      const id = ++nextId;
      const reply = await request({ kind: "register", id, bindings, authority: grantAuthority });
      if (reply.kind !== "registered" || Atomics.load(authority, 0) !== 0) {
        throw failure ?? new Error("Secret egress proxy has stopped");
      }
      return {
        env: reply.env,
        revoke: () => {
          // Fence egress synchronously, even while the Worker is busy before cleanup delivery.
          if (Atomics.exchange(grantAuthority, 0, 1) === 0 && !failure && !stopping) {
            worker.postMessage({ kind: "revoke", id } satisfies SecretEgressWorkerCommand, []);
          }
        },
      };
    },
    getCertificateStatus: async () => {
      if (stopping) {
        throw new Error("Secret egress proxy has stopped");
      }
      const reply = await request({ kind: "status", id: ++nextId });
      if (reply.kind !== "status") {
        throw new Error("Secret egress proxy health unavailable");
      }
      return reply.status;
    },
    stop: () => {
      Atomics.store(authority, 0, 1);
      return (stopping ??= (async () => {
        try {
          if (!failure) {
            await request({ kind: "stop", id: ++nextId });
          }
        } finally {
          // Certificate issuance and native thread exit precede CA directory removal.
          await exited.promise;
        }
      })());
    },
  };
}
