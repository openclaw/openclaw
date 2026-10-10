import { AsyncLocalStorage } from "node:async_hooks";
import { statSync } from "node:fs";
import path from "node:path";
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { GATEWAY_SERVER_CAPS } from "../../packages/gateway-protocol/src/server-capabilities.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.js";
import type { OperatorScope } from "../gateway/operator-scopes.js";
import { resolveIdentityPathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { GatewayLockIdentity } from "../infra/gateway-lock.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { OpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-maintenance-context.js";
import { registerSignalExitGate } from "./signal-exit-barrier.js";

type LocalMutationScope = {
  env: NodeJS.ProcessEnv;
  config: OpenClawConfig;
  signal: AbortSignal;
  assertCurrent: () => void;
  /** Already accepted compensation retains custody after interruption. */
  assertSettlementCurrent: () => void;
  runSettlement: <U>(run: () => Promise<U>) => Promise<U>;
};

type LocalOwnerScope = {
  assertCurrent: () => void;
  assertSettlementCurrent: () => void;
  ownerLockPath: string;
  configPath: string;
  settling?: true;
};
const localOwnerAssertions = resolveGlobalSingleton(
  Symbol.for("openclaw.localStateOwnerAssertions"),
  () => new AsyncLocalStorage<LocalOwnerScope>(),
);
const offlineOwnerResources = resolveGlobalSingleton(
  Symbol.for("openclaw.localStateOwnerResources"),
  () =>
    new Map<
      string,
      {
        ownerId: string | undefined;
        resources: OpenClawDatabaseMaintenanceScope;
        uncertainCleanup: boolean;
      }
    >(),
);

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
  /** Explicit configuration targets retain their own selector environment. */
  env?: NodeJS.ProcessEnv;
  params: Record<string, unknown>;
  target: string;
  recoveryCommand?: string;
  requiredCapabilities?: readonly string[];
  scopes?: readonly OperatorScope[];
  timeoutMs?: number;
  expectFinal?: boolean;
  /** Local inspection must stay read-only and must not load mutation-capable runtime config. */
  onForeignOwner?:
    | "refuse"
    | ((scope: Omit<LocalMutationScope, "config" | "runSettlement">) => Promise<T>);
  assertTargetCurrent?: () => void;
  runLocal: (scope: LocalMutationScope) => Promise<T>;
}): Promise<T> {
  const parent = localOwnerAssertions.getStore();
  if (parent?.settling) {
    parent.assertSettlementCurrent();
  } else {
    parent?.assertCurrent();
  }
  const sourceEnv = params.env ?? process.env;
  const selectedEnv = { ...sourceEnv };
  const selectedStateDir = resolveStateDir(selectedEnv);
  const stateDir = resolveIdentityPathViaExistingAncestorSync(selectedStateDir);
  const rootIdentity = statSync(stateDir, { bigint: true, throwIfNoEntry: false });
  const env = {
    ...selectedEnv,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: resolveConfigPath(selectedEnv, selectedStateDir),
  };
  const input = structuredClone(params.params);
  const scopes: OperatorScope[] = [...(params.scopes ?? ["operator.admin"])];
  const [
    {
      acquireGatewayLock,
      isGatewayLifecycleContentionError,
      isSameGatewayLockIdentity,
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
  if (
    parent &&
    (parent.ownerLockPath !== paths.ownerLockPath || parent.configPath !== paths.configPath)
  ) {
    throw new LocalStateOwnerError(
      "OWNER_UNAVAILABLE",
      "Nested operation changed the selected state root or config path; rerun the command.",
    );
  }
  const databasePath = path.join(paths.stateDir, "state", "openclaw.sqlite");
  const controller = new AbortController();
  const finished = createDeferredCore();
  const releaseExitGate = registerSignalExitGate(finished.promise, () => controller.abort());
  const assertTargetCurrent = (settlement = false) => {
    if (settlement) {
      parent?.assertSettlementCurrent();
    } else {
      if (parent?.settling) {
        parent.assertSettlementCurrent();
      } else {
        parent?.assertCurrent();
      }
      controller.signal.throwIfAborted();
    }
    const ambientPaths = resolveGatewayLockPaths(sourceEnv);
    const currentRoot = rootIdentity
      ? statSync(stateDir, { bigint: true, throwIfNoEntry: false })
      : undefined;
    if (
      paths.stateDir !== stateDir ||
      ambientPaths.ownerLockPath !== paths.ownerLockPath ||
      ambientPaths.configPath !== paths.configPath ||
      resolveIdentityPathViaExistingAncestorSync(selectedStateDir) !== stateDir ||
      (rootIdentity &&
        (currentRoot?.dev !== rootIdentity.dev || currentRoot?.ino !== rootIdentity.ino)) ||
      resolveGatewayLockPaths(selectedEnv).ownerLockPath !== paths.ownerLockPath
    ) {
      throw new LocalStateOwnerError(
        "OWNER_UNAVAILABLE",
        "Selected state root changed; rerun the command.",
      );
    }
    params.assertTargetCurrent?.();
  };
  const guidance = `Update the Gateway or fix authentication and retry. To run offline, stop the Gateway through its service owner, wait for ownership to release, then rerun this exact command.`;
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
    const assertSettlementCurrent = () => {
      assertTargetCurrent(true);
      assertOwnerCurrent();
    };
    const assertCurrent = () => {
      assertTargetCurrent();
      assertOwnerCurrent();
    };
    assertCurrent();
    const { getRuntimeConfig } = await import("../config/config.js");
    assertCurrent();
    let config: OpenClawConfig | undefined;
    const selectedScope: LocalOwnerScope = {
      assertCurrent,
      assertSettlementCurrent,
      ownerLockPath: paths.ownerLockPath,
      configPath: paths.configPath,
    };
    const runSettlement = async <U>(run: () => Promise<U>): Promise<U> => {
      assertSettlementCurrent();
      let active = true;
      const assertRetainedSettlement = () => {
        assertSettlementCurrent();
        if (!active) {
          throw new Error("Local state settlement scope has completed");
        }
      };
      return await localOwnerAssertions.run(
        { ...selectedScope, assertSettlementCurrent: assertRetainedSettlement, settling: true },
        async () => {
          try {
            return await run();
          } finally {
            active = false;
            assertSettlementCurrent();
          }
        },
      );
    };
    return await localOwnerAssertions.run(selectedScope, () =>
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
        assertSettlementCurrent,
        runSettlement,
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
        assertSettlementCurrent: () => assertTargetCurrent(true),
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
    try {
      assertTargetCurrent();
      // The transport owns reduced connection config; full runtime loading can write state.
      return await callGateway<T>({
        method: params.method,
        configPath: paths.configPath,
        params: { ...input, expectedOwnerId: owner.ownerId },
        localPortOverride: port,
        ignoreEnvUrlOverride: true,
        requiredMethods: [params.method],
        requiredCapabilities: [
          GATEWAY_SERVER_CAPS.LOCAL_STATE_OWNER_ROUTING,
          ...(params.requiredCapabilities ?? []),
        ],
        timeoutMs: params.timeoutMs ?? 600_000,
        expectFinal: params.expectFinal,
        signal: controller.signal,
        scopes,
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
        prepareDispatchCurrent: async () => {
          const current = await discover();
          if (
            !current ||
            current.port === undefined ||
            !isSameGatewayLockIdentity({ ...owner, port }, { ...current, port: current.port })
          ) {
            refuse(new Error("Gateway owner changed before dispatch"));
          }
        },
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
      const offline = offlineOwnerResources.get(paths.ownerLockPath);
      if (offline && offline.ownerId === hosted.ownerId) {
        return await offline.resources.run(async () => {
          try {
            return await runLocal(hosted.assertCurrent);
          } catch (error) {
            offline.uncertainCleanup ||= hasCommandProcessCleanupError(error);
            throw error;
          }
        });
      }
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
    const offline = {
      ownerId: captureGatewayStateOwner(databasePath)?.ownerId,
      resources,
      uncertainCleanup: false,
    };
    offlineOwnerResources.set(paths.ownerLockPath, offline);
    try {
      return await resources.run(() => runLocal(lock.assertCurrent));
    } catch (error) {
      offline.uncertainCleanup ||= hasCommandProcessCleanupError(error);
      throw error;
    } finally {
      // Failed cleanup keeps physical custody; release cannot race accepted worker/native work.
      await resources.close();
      // Unknown child settlement keeps physical custody after the process owner stops lending.
      const retained = offline.uncertainCleanup
        ? tryBorrowGatewayStateOwner(databasePath)
        : undefined;
      await lock.release();
      retained?.assertCurrent();
      if (offlineOwnerResources.get(paths.ownerLockPath) === offline) {
        offlineOwnerResources.delete(paths.ownerLockPath);
      }
    }
  } finally {
    finished.resolve();
    releaseExitGate();
  }
}
