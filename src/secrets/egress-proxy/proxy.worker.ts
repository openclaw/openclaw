import { parentPort, workerData } from "node:worker_threads";
import { resolveSecretSentinel } from "../sentinel.js";
import { startSecretEgressProxyServer, type SecretEgressProcessGrant } from "./proxy-server.js";
import type {
  SecretEgressWorkerCommand,
  SecretEgressWorkerData,
  SecretEgressWorkerMessage,
} from "./proxy-worker.types.js";

const port = parentPort!;
// SAFETY: The sole launcher in proxy-worker.ts supplies typed, process-owned Worker data.
const data = workerData as SecretEgressWorkerData;
const send = (message: SecretEgressWorkerMessage) => port.postMessage(message);

try {
  const proxy = await startSecretEgressProxyServer({
    caDir: data.caDir,
    allowedHosts: data.allowedHosts,
    bypassHosts: data.bypassHosts,
    resolveSentinel: (sentinel) => resolveSecretSentinel(sentinel, data.decryptionKey),
    onAudit: (event) => send({ kind: "audit", event }),
  });
  const grants = new Map<number, SecretEgressProcessGrant>();
  port.on("message", (command: SecretEgressWorkerCommand) => {
    void (async () => {
      switch (command.kind) {
        case "register": {
          const grant = proxy.registerProcess(
            command.bindings,
            () => Atomics.load(data.authority, 0) === 0 && Atomics.load(command.authority, 0) === 0,
          );
          grants.set(command.id, grant);
          send({ kind: "registered", id: command.id, env: grant.env });
          break;
        }
        case "revoke":
          grants.get(command.id)?.revoke();
          grants.delete(command.id);
          break;
        case "status":
          send({ kind: "status", id: command.id, status: proxy.getCertificateStatus() });
          break;
        case "stop":
          await proxy.stop();
          grants.clear();
          data.decryptionKey.fill(0);
          send({ kind: "stopped", id: command.id });
          port.close();
          break;
      }
    })().catch(() => send({ kind: "failed", id: command.id }));
  });
  send({ kind: "ready", caCertPath: proxy.caCertPath, proxyOrigin: proxy.proxyOrigin });
} catch {
  // Never serialize provider errors, request URLs, OpenSSL output, or key material.
  send({ kind: "fatal" });
  port.close();
}
