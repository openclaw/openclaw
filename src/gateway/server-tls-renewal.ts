import fs from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import { Server as HttpsServer } from "node:https";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { root } from "@openclaw/fs-safe/root";
import { watch, type WatchScope, type WatchSubscription } from "@openclaw/fs-safe/watch";
import {
  resolveFsObservationIntervalMs,
  resolveFsObservationMode,
} from "../infra/fs-observation-mode.js";
import { loadGatewayTlsServerRuntime, type GatewayTlsRuntime } from "../infra/tls/gateway.js";

/** TLS explicitly follows configured links; observe each link as well as its current target. */
async function resolveTlsObservationScopes(paths: readonly string[], signal: AbortSignal) {
  const entries = new Set<string>();
  for (const configured of paths) {
    const target = path.resolve(configured);
    let parent = path.parse(target).root;
    const components = path.relative(parent, target).split(path.sep).filter(Boolean).toReversed();
    let links = 0;
    while (components.length > 0) {
      signal.throwIfAborted();
      const component = components.pop()!;
      if (component === "." || component === "..") {
        parent = component === ".." ? path.dirname(parent) : parent;
        continue;
      }
      const candidate = path.join(parent, component);
      const metadata = await fs.lstat(candidate).catch((error: unknown) => {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          (error.code === "ENOENT" || error.code === "ENOTDIR")
        ) {
          return undefined;
        }
        throw error;
      });
      if (metadata?.isSymbolicLink()) {
        entries.add(candidate);
        if (++links > 40) {
          throw new Error(`Too many symbolic links in gateway TLS path: ${configured}`);
        }
        const link = await fs.readlink(candidate);
        if (path.isAbsolute(link)) {
          parent = path.parse(link).root;
        }
        const remainder = path.isAbsolute(link) ? link.slice(parent.length) : link;
        // Consume the link target before the remaining path without copying the pending stack.
        for (const linkComponent of remainder.split(path.sep).filter(Boolean).toReversed()) {
          components.push(linkComponent);
        }
        continue;
      }
      if (!metadata?.isDirectory() || components.length === 0) {
        entries.add(candidate);
        break;
      }
      parent = candidate;
    }
  }
  const groups = new Map<string, WatchScope[]>();
  for (const entry of [...entries].toSorted()) {
    const directory = path.dirname(entry);
    const scopes = groups.get(directory) ?? [];
    scopes.push({ path: path.basename(entry), kind: "entry" });
    groups.set(directory, scopes);
  }
  return groups;
}

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
  const lifetime = new AbortController();
  const observations = new Map<string, { subscription: WatchSubscription; scopes: string }>();
  let observationWork: Promise<void> | undefined;
  let observationRequested = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
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
  const retryObservation = (error: unknown) => {
    if (stopped || retryTimer) {
      return;
    }
    params.log.warn(`gateway TLS observation failed; keeping accepted material: ${String(error)}`);
    // The former stat poll retried inaccessible paths every second. Keep recovery
    // in this owner and the selected mode; never silently downgrade the transport.
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      requestObservation();
      requestRefresh();
    }, 1_000);
    retryTimer.unref?.();
  };
  const updateObservation = async () => {
    const groups = await resolveTlsObservationScopes(paths, lifetime.signal);
    for (const [directory, current] of observations) {
      if (!groups.has(directory) || current.subscription.health().state === "unavailable") {
        await current.subscription.close();
        observations.delete(directory);
      }
    }
    for (const [directory, scopes] of groups) {
      lifetime.signal.throwIfAborted();
      const key = JSON.stringify(scopes);
      const current = observations.get(directory);
      if (current) {
        if (current.scopes !== key) {
          await current.subscription.setScopes(scopes);
          current.scopes = key;
        }
        continue;
      }
      // TLS authorizes the configured path on every read, including replacement
      // parent identities. Root loss retries admission without broad recursive roots.
      const authority = await root(directory, { symlinks: "reject" });
      lifetime.signal.throwIfAborted();
      const mode = resolveFsObservationMode();
      const subscription = watch(authority, {
        scopes,
        mode,
        intervalMs:
          process.env.CHOKIDAR_INTERVAL === undefined ? 1_000 : resolveFsObservationIntervalMs(),
        signal: lifetime.signal,
        onInvalidate(invalidation) {
          if (stopped) {
            return;
          }
          if (
            !invalidation.changes ||
            invalidation.changes.some((change) => change.type === "structural")
          ) {
            requestObservation();
          }
          requestRefresh();
        },
        onHealth(health) {
          if (health.state === "unavailable") {
            retryObservation(health.failure?.error);
          }
        },
      });
      observations.set(directory, { subscription, scopes: key });
      await subscription.ready;
    }
  };
  const requestObservation = () => {
    if (stopped) {
      return;
    }
    observationRequested = true;
    if (observationWork) {
      return;
    }
    const work = (async () => {
      while (observationRequested) {
        observationRequested = false;
        await updateObservation();
      }
    })()
      .catch(retryObservation)
      .finally(() => {
        if (observationWork === work) {
          observationWork = undefined;
          if (observationRequested && !retryTimer) {
            requestObservation();
          }
        }
      });
    observationWork = work;
  };
  requestObservation();
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
      // Stop owns queued admission; producers cannot request more work after this fence.
      observationRequested = false;
      epoch += 1;
      clearTimeout(timer);
      clearTimeout(retryTimer);
      lifetime.abort();
      await Promise.all([pending, observationWork]);
      const retired = await Promise.allSettled(
        [...observations.values()].map(({ subscription }) => subscription.close()),
      );
      const failures = retired.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, "Gateway TLS observation retirement failed");
      }
      observations.clear();
    },
  };
}
