import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { GATEWAY_SERVER_CAPS } from "../../packages/gateway-protocol/src/server-capabilities.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.js";
import type { GatewayRequestFunction } from "../gateway/call.js";
import type { OperatorScope } from "../gateway/operator-scopes.js";
import { resolveIdentityPathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { GatewayLockIdentity } from "../infra/gateway-lock.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { createDeferredCore } from "../shared/deferred.js";
import { registerSignalExitGate } from "./signal-exit-barrier.js";

const localOwnerAssertion = new AsyncLocalStorage<() => void>();

type LocalMutationScope = {
  env: NodeJS.ProcessEnv;
  config: OpenClawConfig;
  signal: AbortSignal;
  assertCurrent: () => void;
};

class LocalStateOwnerError extends Error {
  constructor(
    readonly code: "OWNER_UNAVAILABLE" | "OWNER_REFUSED" | "OUTCOME_UNKNOWN",
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "LocalStateOwnerError";
  }
}

/** Select one owner before domain admission and retain offline custody through resource settlement. */
export async function runWithLocalStateOwner<T>(params: {
  method: string;
  /** Lazy input is collected only for Gateway dispatch, never for the local path. */
  params: Record<string, unknown> | ((signal: AbortSignal) => Promise<Record<string, unknown>>);
  target: string;
  recoveryCommand?: string;
  requiredCapabilities?: readonly string[];
  scopes?: readonly OperatorScope[];
  timeoutMs?: number;
  expectFinal?: boolean;
  requireLocalBackendSharedAuth?: boolean;
  onGatewayResponse?: (request: GatewayRequestFunction, signal: AbortSignal) => Promise<void>;
  onGatewaySignalAbort?: (request: GatewayRequestFunction) => Promise<void>;
  /** Local inspection must stay read-only and must not load mutation-capable runtime config. */
  onForeignOwner?: "refuse" | ((scope: Omit<LocalMutationScope, "config">) => Promise<T>);
  assertTargetCurrent?: () => void;
  runLocal: (scope: LocalMutationScope) => Promise<T>;
}): Promise<T> {
  localOwnerAssertion.getStore()?.();
  const selectedEnv = { ...process.env };
  const selectedStateDir = resolveStateDir(selectedEnv);
  const stateDir = resolveIdentityPathViaExistingAncestorSync(selectedStateDir);
  const env = {
    ...selectedEnv,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: resolveConfigPath(selectedEnv, selectedStateDir),
  };
  const input =
    typeof params.params === "function" ? params.params : structuredClone(params.params);
  const scopes: OperatorScope[] = [...(params.scopes ?? ["operator.admin"])];
  const [
    {
      acquireGatewayLock,
      isGatewayLifecycleContentionError,
      readActiveGatewayLockIdentity,
      readLockPayloadSync,
      resolveGatewayLockPaths,
    },
    { captureGatewayStateOwner, tryBorrowGatewayStateOwner },
    { createOpenClawDatabaseMaintenanceScope },
  ] = await Promise.all([
    import("../infra/gateway-lock.js"),
    import("../infra/gateway-state-owner.js"),
    import("../state/openclaw-state-db-async-lifecycle.js"),
  ]);
  const paths = resolveGatewayLockPaths(env);
  const databasePath = path.join(paths.stateDir, "state", "openclaw.sqlite");
  const controller = new AbortController();
  const finished = createDeferredCore();
  const releaseExitGate = registerSignalExitGate(finished.promise, () => controller.abort());
  const assertTargetCurrent = () => {
    controller.signal.throwIfAborted();
    params.assertTargetCurrent?.();
  };
  const guidance =
    "Update the Gateway or fix authentication and retry. " +
    (params.requireLocalBackendSharedAuth
      ? "Provide the Gateway's shared secret through OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_PASSWORD in this CLI process; device pairing is not a substitute. "
      : "") +
    "To run offline, stop the Gateway through its service owner, wait for ownership to release, then rerun this exact command.";
  const refuse = (cause: unknown): never => {
    throw new LocalStateOwnerError(
      "OWNER_UNAVAILABLE",
      `Cannot admit ${params.method} for ${params.target} in state root ${paths.stateDir}: ${redactSensitiveUrlLikeString(formatErrorMessage(cause))}. No local mutation was attempted. Inspect openclaw gateway status. ${guidance}`,
      cause,
    );
  };
  const discover = async () => {
    try {
      assertTargetCurrent();
      const options = {
        env,
        requireInspection: true,
        signal: controller.signal,
      };
      return params.onForeignOwner
        ? await readActiveGatewayLockIdentity({ ...options, includeEmbedded: true })
        : await readActiveGatewayLockIdentity(options);
    } catch (error) {
      return refuse(error);
    }
  };
  const runLocal = async (assertOwnerCurrent: () => void): Promise<T> => {
    const assertCurrent = () => {
      assertTargetCurrent();
      assertOwnerCurrent();
    };
    assertCurrent();
    const { getRuntimeConfig } = await import("../config/config.js");
    assertCurrent();
    let config: OpenClawConfig | undefined;
    return await localOwnerAssertion.run(assertCurrent, () =>
      params.runLocal({
        env,
        // Loading config can write state. Config-free owners must reach their own admission first.
        get config() {
          assertCurrent();
          config ??= getRuntimeConfig();
          assertCurrent();
          return config;
        },
        signal: controller.signal,
        assertCurrent,
      }),
    );
  };
  const route = async (
    owner: Omit<GatewayLockIdentity, "port"> & { port?: number },
  ): Promise<T> => {
    if (typeof params.onForeignOwner === "function") {
      assertTargetCurrent();
      const result = await params.onForeignOwner({
        env,
        signal: controller.signal,
        assertCurrent: assertTargetCurrent,
      });
      assertTargetCurrent();
      return result;
    }
    if (params.onForeignOwner === "refuse") {
      return refuse(new Error("This operation requires exclusive offline state ownership"));
    }
    if (!owner.ownerId) {
      return refuse(new Error("Gateway lacks the expected-owner contract; update the Gateway."));
    }
    const port = owner.port;
    if (port === undefined) {
      return refuse(new Error("The state owner has no Gateway listener"));
    }
    const { callGateway, isGatewayClientRequestError } = await import("../gateway/call.js");
    let dispatched = false;
    const gatewayInput =
      typeof input === "function" ? structuredClone(await input(controller.signal)) : input;
    try {
      assertTargetCurrent();
      // The transport owns reduced connection config; full runtime loading can write state.
      return await callGateway<T>({
        method: params.method,
        configPath: paths.configPath,
        params: { ...gatewayInput, expectedOwnerId: owner.ownerId },
        localPortOverride: port,
        ignoreEnvUrlOverride: true,
        requireLocalBackendSharedAuth: params.requireLocalBackendSharedAuth,
        allowLocalBackendAuthNone: params.requireLocalBackendSharedAuth,
        requiredMethods: [params.method],
        requiredCapabilities: [
          GATEWAY_SERVER_CAPS.LOCAL_STATE_OWNER_ROUTING,
          ...(params.requiredCapabilities ?? []),
        ],
        timeoutMs: params.timeoutMs ?? 600_000,
        expectFinal: params.expectFinal,
        signal: controller.signal,
        scopes,
        onSignalAbort: params.onGatewaySignalAbort,
        onResponse: params.onGatewayResponse
          ? async (request, connectionSignal) => {
              const guardedRequest: GatewayRequestFunction = (method, input, options) => {
                assertTargetCurrent();
                const current = readLockPayloadSync(paths.ownerLockPath, true);
                if (!current || current.ownerId !== owner.ownerId || current.pid !== owner.pid) {
                  refuse(new Error("Gateway owner changed during the operation"));
                }
                return request(method, input, options);
              };
              await params.onGatewayResponse!(
                guardedRequest,
                AbortSignal.any([controller.signal, connectionSignal]),
              );
            }
          : undefined,
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
        assertDispatchCurrent: () => {
          assertTargetCurrent();
          const current = readLockPayloadSync(paths.ownerLockPath, true);
          if (!current || current.ownerId !== owner.ownerId || current.pid !== owner.pid) {
            refuse(new Error("Gateway owner changed before dispatch"));
          }
          // From this point a failure may follow an accepted effect. Never replay it.
          dispatched = true;
        },
      });
    } catch (error) {
      const refused =
        isGatewayClientRequestError(error) &&
        typeof error.details === "object" &&
        error.details !== null &&
        "mutationAccepted" in error.details &&
        error.details.mutationAccepted === false;
      throw new LocalStateOwnerError(
        dispatched && !refused ? "OUTCOME_UNKNOWN" : "OWNER_REFUSED",
        `Gateway owning ${paths.stateDir} on local port ${owner.port} could not complete ${params.method} for ${params.target}: ${redactSensitiveUrlLikeString(formatErrorMessage(error))}. ` +
          (dispatched && !refused
            ? `The outcome may be partial; inspect ${params.recoveryCommand ?? "the operation's status"} and the target before retrying. No local fallback was attempted.`
            : `No local mutation was attempted. ${guidance}`),
        error,
      );
    }
  };
  try {
    assertTargetCurrent();
    const hosted = captureGatewayStateOwner(databasePath);
    if (hosted) {
      return await runLocal(hosted.assertCurrent);
    }
    const owner = await discover();
    if (owner) {
      return await route(owner);
    }
    let lock;
    try {
      // A losing acquisition has not entered the domain or opened a writable database.
      lock = await acquireGatewayLock({ env, role: "agent-embedded", allowInTests: true });
    } catch (error) {
      if (isGatewayLifecycleContentionError(error)) {
        const winner = await discover();
        if (winner) {
          return await route(winner);
        }
      }
      return refuse(error);
    }
    if (!lock) {
      return refuse(new Error("Offline state ownership was not acquired"));
    }
    const resources = createOpenClawDatabaseMaintenanceScope({
      assertOwnerCurrent: () => lock.assertCurrent(),
      assertDatabaseAccess: lock.assertDatabaseAccess,
    });
    let uncertainCleanup = false;
    try {
      return await resources.run(() => runLocal(lock.assertCurrent));
    } catch (error) {
      uncertainCleanup = hasCommandProcessCleanupError(error);
      throw error;
    } finally {
      // Failed cleanup keeps physical custody; release cannot race accepted worker/native work.
      await resources.close();
      // Stop lending this owner, but keep physical custody until uncertain children exit.
      const retained = uncertainCleanup ? tryBorrowGatewayStateOwner(databasePath) : undefined;
      await lock.release();
      retained?.assertCurrent();
    }
  } finally {
    finished.resolve();
    releaseExitGate();
  }
}
