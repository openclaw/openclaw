import fs from "node:fs";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { createConfigIO } from "../config/io.js";
import { resolveGatewayAuthForConfig } from "../gateway/auth-resolve.js";
import { callGateway } from "../gateway/call.js";
import { resolveIdentityPathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { readGatewayLockProcessStartTime } from "../infra/gateway-lock-process.js";
import {
  readActiveGatewayLockIdentity,
  readLockPayloadSync,
  resolveGatewayLockPaths,
  type GatewayLockIdentity,
} from "../infra/gateway-lock.js";
import { isPidAlive } from "../shared/pid-alive.js";

const RPC_TIMEOUT_MS = 10_000;
const RENEWAL_MARGIN_MS = 2_000;
const RENEW_AFTER_MS = 30_000;
const LEASE_TTL_MS = 120_000;

export type GatewayMigrationQuiescenceScope = {
  signal: AbortSignal;
  assertCurrent(this: void): void;
  revalidate(this: void): Promise<void>;
  owner: GatewayLockIdentity & { ownerId: string };
  readonly expiresAtMs: number;
};

type SuspensionStatus = {
  status?: string;
  ownerId?: string;
  expiresAtMs?: number;
  writeCustody?: { phase: string; count: number }[];
};
type SuspensionPrepared = SuspensionStatus & {
  suspensionId?: string;
  activeCount?: number;
  blockers?: unknown[];
};

function sameOwner(left: GatewayLockIdentity, right: GatewayLockIdentity): boolean {
  return (
    left.ownerId === right.ownerId &&
    left.pid === right.pid &&
    left.startTime === right.startTime &&
    left.createdAt === right.createdAt &&
    left.port === right.port
  );
}

/** Borrow an existing controller suspension; never resume or retire its owner. */
export async function withGatewayMigrationQuiescence<T>(options: {
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  assertCurrent(): void;
  requestId: string;
  suspensionId: string;
  run(scope: GatewayMigrationQuiescenceScope): Promise<T>;
}): Promise<T> {
  const env = { ...options.env };
  if (!options.requestId.trim() || !options.suspensionId.trim()) {
    throw new Error("Migration requires the existing controller request and suspension IDs.");
  }
  const controller = new AbortController();
  const abort = (error: unknown) => {
    controller.abort(error);
    return error;
  };
  const onAbort = () => controller.abort(options.signal.reason);
  options.signal.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;
  let stopped = false;
  let expiresAtMs = 0;
  let monotonicExpiry = 0;
  try {
    options.signal.throwIfAborted();
    options.assertCurrent();
    const paths = resolveGatewayLockPaths(env);
    const selectedConfig = resolveIdentityPathViaExistingAncestorSync(paths.configPath);
    const owner = await readActiveGatewayLockIdentity({
      env,
      requireInspection: true,
      signal: controller.signal,
      timeoutMs: RPC_TIMEOUT_MS,
    });
    if (!owner?.ownerId || !Number.isFinite(owner.startTime)) {
      throw new Error("Migration requires an inspected local Gateway owner and process identity.");
    }
    const ownerIdentity = { ...owner, ownerId: owner.ownerId };
    const lockPath = [paths.ownerLockPath, paths.configLockPath, paths.stateLockPath].find(
      (file) => {
        const payload = readLockPayloadSync(file, true);
        return payload?.port !== undefined && sameOwner(owner, { ...payload, port: payload.port });
      },
    );
    if (!lockPath) {
      throw new Error("Migration Gateway physical owner lock is unavailable.");
    }
    const lockIdentity = fs.lstatSync(lockPath, { bigint: true });
    if (!lockIdentity.isFile() || lockIdentity.isSymbolicLink()) {
      throw new Error("Migration requires a regular physical Gateway owner lock.");
    }
    const assertPhysicalOwner = () => {
      controller.signal.throwIfAborted();
      options.signal.throwIfAborted();
      options.assertCurrent();
      const currentPaths = resolveGatewayLockPaths(env);
      if (
        currentPaths.stateDir !== paths.stateDir ||
        resolveIdentityPathViaExistingAncestorSync(currentPaths.configPath) !== selectedConfig
      ) {
        throw new Error("Migration selected state/config identity changed.");
      }
      const stat = fs.lstatSync(lockPath, { bigint: true });
      const payload = readLockPayloadSync(lockPath, true);
      if (
        !stat.isFile() ||
        stat.dev !== lockIdentity.dev ||
        stat.ino !== lockIdentity.ino ||
        !payload?.port ||
        !sameOwner(owner, { ...payload, port: payload.port }) ||
        (payload.role !== undefined && payload.role !== "gateway") ||
        resolveIdentityPathViaExistingAncestorSync(payload.configPath) !== selectedConfig ||
        (payload.stateDir !== undefined &&
          resolveIdentityPathViaExistingAncestorSync(payload.stateDir) !== paths.stateDir) ||
        !isPidAlive(owner.pid) ||
        readGatewayLockProcessStartTime(owner.pid, process.platform, 1_000) !== owner.startTime
      ) {
        throw new Error("Migration Gateway owner identity changed or cannot be verified.");
      }
    };
    const assertCurrent = () => {
      try {
        assertPhysicalOwner();
        if (Date.now() >= expiresAtMs || performance.now() >= monotonicExpiry) {
          throw new Error("Migration Gateway suspension expired.");
        }
      } catch (error) {
        throw abort(error);
      }
    };
    assertPhysicalOwner();
    const snapshot = await createConfigIO({
      env,
      configPath: paths.configPath,
      observe: false,
      pluginValidation: "core-only",
    }).readConfigFileSnapshot({ observe: false, isolateEnv: true });
    assertPhysicalOwner();
    if (!snapshot.valid || snapshot.config.gateway?.mode === "remote") {
      throw new Error("Migration requires valid selected local Gateway configuration.");
    }
    const auth = resolveGatewayAuthForConfig({ config: snapshot.config, env });
    const credentials =
      auth.mode === "token" && auth.token
        ? { token: auth.token }
        : (auth.mode === "password" || auth.mode === "trusted-proxy") && auth.password
          ? { password: auth.password }
          : undefined;
    if (!credentials) {
      throw new Error("Migration requires private local backend shared authentication.");
    }
    const rpc = <R>(method: string, params: unknown) =>
      callGateway<R>({
        method,
        params,
        config: snapshot.config,
        configPath: paths.configPath,
        localPortOverride: owner.port,
        ignoreEnvUrlOverride: true,
        ...credentials,
        skipImplicitAuth: true,
        deviceIdentity: null,
        sharedStateMode: "read-only",
        clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
        mode: GATEWAY_CLIENT_MODES.BACKEND,
        requireLocalBackendSharedAuth: true,
        scopes: ["operator.admin"],
        timeoutMs: RPC_TIMEOUT_MS,
        signal: controller.signal,
        assertDispatchCurrent: () => {
          if (expiresAtMs) {
            assertCurrent();
            if (
              method === "gateway.suspend.prepare" &&
              Math.min(expiresAtMs - Date.now(), monotonicExpiry - performance.now()) <
                RPC_TIMEOUT_MS + RENEWAL_MARGIN_MS
            ) {
              throw abort(new Error("Migration suspension renewal lacks safe dispatch runway."));
            }
          } else {
            assertPhysicalOwner();
          }
        },
      });
    const acceptLease = (result: SuspensionStatus, startedAt: number) => {
      if (
        result.status !== "ready" ||
        !Number.isSafeInteger(result.expiresAtMs) ||
        !Array.isArray(result.writeCustody) ||
        result.writeCustody.some((entry) => !Number.isSafeInteger(entry.count) || entry.count !== 0)
      ) {
        throw new Error("Migration suspension is not ready with verified zero write custody.");
      }
      const expiry = result.expiresAtMs!;
      const remaining = expiry - Date.now();
      if (
        remaining < RPC_TIMEOUT_MS + RENEWAL_MARGIN_MS ||
        remaining > LEASE_TTL_MS ||
        performance.now() - startedAt >= remaining
      ) {
        throw new Error("Migration suspension has insufficient or invalid bounded lease runway.");
      }
      // Remote expiry is capped by elapsed monotonic time, including the RPC.
      monotonicExpiry =
        expiry <= expiresAtMs
          ? Math.min(monotonicExpiry, startedAt + remaining)
          : startedAt + remaining;
      expiresAtMs = expiry;
      assertCurrent();
    };
    const renew = async () => {
      try {
        assertPhysicalOwner();
        const statusStarted = performance.now();
        const status = await rpc<SuspensionStatus>("gateway.suspend.status", {
          suspensionId: options.suspensionId,
          includeLifecycle: true,
        });
        assertPhysicalOwner();
        if (status.ownerId !== options.requestId) {
          throw new Error("Migration suspension is not held by the supplied controller request.");
        }
        acceptLease(status, statusStarted);
        const prepareStarted = performance.now();
        const prepared = await rpc<SuspensionPrepared>("gateway.suspend.prepare", {
          requestId: options.requestId,
          drain: false,
          terminalPolicy: "preserve",
        });
        assertCurrent();
        if (
          prepared.suspensionId !== options.suspensionId ||
          prepared.activeCount !== 0 ||
          !Array.isArray(prepared.blockers) ||
          prepared.blockers.length !== 0
        ) {
          // Old Gateways lack renewal CAS. Preserve any discrepancy for the
          // original controller; this helper must never resume/stop that owner.
          throw new Error("Migration suspension renewal changed identity or retained active work.");
        }
        acceptLease(prepared, prepareStarted);
      } catch (error) {
        throw abort(error);
      }
    };
    const revalidate = (): Promise<void> => {
      if (stopped) {
        return Promise.reject(new Error("Migration quiescence scope has completed."));
      }
      if (!pending) {
        pending = renew().finally(() => {
          pending = undefined;
        });
      }
      return pending;
    };
    const schedule = () => {
      timer = setTimeout(() => {
        void revalidate().then(
          () => {
            if (!stopped) {
              schedule();
            }
          },
          () => {}, // The linked signal preserves the actual renewal failure.
        );
      }, RENEW_AFTER_MS);
      timer.unref?.();
    };
    await revalidate();
    schedule();
    const value = await options.run({
      signal: controller.signal,
      assertCurrent() {
        if (stopped) {
          throw new Error("Migration quiescence scope has completed.");
        }
        assertCurrent();
      },
      revalidate,
      owner: ownerIdentity,
      get expiresAtMs() {
        return expiresAtMs;
      },
    });
    stopped = true;
    clearTimeout(timer);
    await pending;
    assertCurrent();
    return value;
  } catch (error) {
    throw abort(error);
  } finally {
    stopped = true;
    clearTimeout(timer);
    await pending?.catch(() => {});
    options.signal.removeEventListener("abort", onAbort);
  }
}
