import { unwatchFile, watchFile } from "node:fs";
import type { Server as HttpServer } from "node:http";
import { Server as HttpsServer } from "node:https";
import { isDeepStrictEqual } from "node:util";
import { loadGatewayTlsServerRuntime, type GatewayTlsRuntime } from "../infra/tls/gateway.js";

/** Renew only the running listener's accepted paths; TLS topology remains startup-owned. */
export function startGatewayTlsRenewal(params: {
  runtime: GatewayTlsRuntime;
  servers: readonly HttpServer[];
  enabled: boolean;
  isClosing: () => boolean;
  onRenewed: () => Promise<void>;
  log: { info: (message: string) => void; warn: (message: string) => void };
}) {
  const { runtime } = params;
  const options = runtime.tlsOptions;
  if (!runtime.enabled || !options || params.isClosing()) {
    return undefined;
  }
  const paths = [runtime.certPath, runtime.keyPath, runtime.caPath].filter(
    (value): value is string => Boolean(value),
  );
  let enabled = params.enabled;
  let stopped = false;
  let epoch = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = Promise.resolve();
  const isCurrent = (expected: number) =>
    !stopped && enabled && !params.isClosing() && epoch === expected;
  const requestRefresh = () => {
    const expected = ++epoch;
    clearTimeout(timer);
    if (!isCurrent(expected)) {
      if (!stopped && !enabled && !params.isClosing()) {
        params.log.info("gateway TLS renewal deferred (gateway.reload.mode=off)");
      }
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      pending = pending
        .then(async () => {
          if (!isCurrent(expected)) {
            return;
          }
          const next = await loadGatewayTlsServerRuntime({
            enabled: true,
            autoGenerate: false,
            certPath: runtime.certPath,
            keyPath: runtime.keyPath,
            caPath: runtime.caPath,
          });
          if (!isCurrent(expected)) {
            return;
          }
          if (!next.enabled || !next.tlsOptions) {
            throw new Error(next.error ?? "TLS renewal did not produce listener material");
          }
          if (isDeepStrictEqual(options, next.tlsOptions)) {
            return;
          }
          // No await between ownership validation and publication. Every HTTPS
          // sibling and future listener must use the same accepted material.
          for (const server of params.servers) {
            if (server instanceof HttpsServer) {
              server.setSecureContext(next.tlsOptions);
            }
          }
          Object.assign(options, next.tlsOptions);
          runtime.fingerprintSha256 = next.fingerprintSha256;
          await params.onRenewed().catch((error: unknown) => {
            params.log.warn(`gateway TLS renewed but discovery refresh failed: ${String(error)}`);
          });
          params.log.info("gateway TLS certificate renewed without restarting listeners");
        })
        .catch((error: unknown) => {
          if (isCurrent(expected)) {
            params.log.warn(
              `gateway TLS renewal failed; keeping accepted material: ${String(error)}`,
            );
          }
        });
    }, 300);
    timer.unref?.();
  };
  // Inode watches miss certificate symlinks and projected-secret directory swaps.
  // Poll only these accepted paths outside request handling, at most once a second.
  for (const path of paths) {
    watchFile(path, { interval: 1000, persistent: false }, requestRefresh);
  }
  requestRefresh();
  return {
    setEnabled: (next: boolean) => {
      if (enabled !== next) {
        enabled = next;
        requestRefresh();
      }
    },
    async stop() {
      stopped = true;
      epoch += 1;
      clearTimeout(timer);
      for (const path of paths) {
        unwatchFile(path, requestRefresh);
      }
      await pending;
    },
  };
}
