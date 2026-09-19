/** CLI runner for node-host stdin/stdout command dispatch. */
import { AsyncLocalStorage } from "node:async_hooks";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { CloudflareAccessCredentials } from "../../packages/gateway-client/src/cloudflare-access.js";
import { gatewayOriginScope } from "../../packages/gateway-client/src/gateway-origin-scope.js";
import { startGatewayClientWhenEventLoopReady } from "../../packages/gateway-client/src/readiness.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { ConnectErrorDetailCodes } from "../../packages/gateway-protocol/src/connect-error-details.js";
import { requestExitAfterOneShotOutput } from "../cli/one-shot-exit.js";
import { getRuntimeConfig, type OpenClawConfig } from "../config/config.js";
import { copyConfigResolutionFactsExcept } from "../config/resolution-facts.js";
import { GatewayClientRequestError, type GatewayReconnectPausedInfo } from "../gateway/client.js";
import { resolveGatewayCredentialsWithSecretInputs } from "../gateway/credentials-secret-inputs.js";
import { resolveExplicitGatewayAuth } from "../gateway/credentials.js";
import { loadDeviceAuthTokenReadOnly } from "../infra/device-auth-store.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { getMachineDisplayName } from "../infra/machine-name.js";
import { logInfo } from "../logger.js";
import { getExistingOpenClawStateSchemaPath } from "../state/openclaw-state-db-schema-policy.js";
import { VERSION } from "../version.js";
import { configureNodeHost, loadNodeHostConfig, type NodeHostGatewayConfig } from "./config.js";
import { startNodeHostConnection } from "./connection.js";
import {
  createNodeHostGatewayCandidateConnection,
  formatGatewayCandidateUrl,
} from "./gateway-candidate-connection.js";
import {
  resolveNodeHostCloudflareAccess,
  type NodeHostCloudflareAccessConfig,
} from "./gateway-cloudflare-access.js";
import { resolveNodeHostGatewayPlatformIdentity } from "./gateway-platform-identity.js";
import {
  coerceNodeInvokeCancelPayload,
  coerceNodeInvokeInputPayload,
  coerceNodeInvokePayload,
} from "./invoke-payload.js";
import {
  isNodeHostLauncherChild,
  notifyNodeHostLauncherReady,
  setNodeHostLauncherRestartArguments,
} from "./launcher-client.js";
import { prepareNodeHostRuntime } from "./runtime.js";
import { runStartupMigrations } from "./startup-state-migrations.js";

type NodeHostRunOptions = {
  gatewayHost: string;
  gatewayPort: number;
  gatewayTls?: boolean;
  gatewayTlsFingerprint?: string;
  gatewayCloudflareAccess?: NodeHostCloudflareAccessConfig;
  gatewayCandidates?: NodeHostGatewayConfig[];
  gatewayBootstrapToken?: string;
  preferGatewayBootstrapToken?: boolean;
  /** Stop cleanly after the first authenticated hello (used before service install). */
  stopAfterFirstConnect?: boolean;
  /** Host worker sessions for this process even when durable node config is disabled. */
  forceWorkerRuns?: boolean;
  /** Disposable cloud host: computer control stays on the private environment carrier. */
  ephemeral?: boolean;
  /** Optional WebSocket context path (e.g. "/openclaw-gw"). */
  gatewayContextPath?: string;
  nodeId?: string;
  displayName?: string;
  installedAppsSharing?: boolean;
  commands?: string[];
  allCommands?: boolean;
};

function writeStderrLine(message: string): void {
  process.stderr.write(`${message}\n`);
}

const NODE_HOST_EXIT_ON_RECONNECT_PAUSE_CODES: ReadonlySet<string> = new Set([
  ConnectErrorDetailCodes.AUTH_TOKEN_MISSING,
  ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH,
  ConnectErrorDetailCodes.AUTH_BOOTSTRAP_TOKEN_INVALID,
  ConnectErrorDetailCodes.AUTH_PASSWORD_MISSING,
  ConnectErrorDetailCodes.AUTH_PASSWORD_MISMATCH,
  ConnectErrorDetailCodes.AUTH_IDENTITY_HEADER_REQUIRED,
  ConnectErrorDetailCodes.CLIENT_VERSION_MISMATCH,
]);

type NodeHostReconnectPausedDeps = {
  writeLine?: (message: string) => void;
  exit?: (code: number) => void;
};

function shouldExitNodeHostOnReconnectPaused(detailCode: string | null): boolean {
  return detailCode !== null && NODE_HOST_EXIT_ON_RECONNECT_PAUSE_CODES.has(detailCode);
}

function formatNodeHostReconnectPausedMessage(
  info: GatewayReconnectPausedInfo,
  params?: { exiting?: boolean },
): string {
  const detail = info.detailCode ? ` detail=${info.detailCode}` : "";
  const reason = info.reason.trim() || "no close reason";
  const action = params?.exiting ? "exiting for supervisor restart" : "waiting for operator action";
  return `node host gateway reconnect paused after close (${info.code}): ${reason}${detail}; ${action}`;
}

function handleNodeHostReconnectPaused(
  info: GatewayReconnectPausedInfo,
  deps: NodeHostReconnectPausedDeps = {},
): void {
  const shouldExit = shouldExitNodeHostOnReconnectPaused(info.detailCode);
  const writeLine = deps.writeLine ?? writeStderrLine;
  writeLine(formatNodeHostReconnectPausedMessage(info, { exiting: shouldExit }));
  if (!shouldExit) {
    return;
  }
  const exit = deps.exit ?? ((code: number): never => process.exit(code));
  exit(1);
}

async function resolveNodeHostGatewayCredentials(params: {
  config: OpenClawConfig;
  savedGateway?: NodeHostGatewayConfig;
  gatewayCandidates: readonly NodeHostGatewayConfig[];
  deviceId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ token?: string; password?: string }> {
  const env = params.env ?? process.env;
  const savedGatewayScope = params.savedGateway
    ? gatewayOriginScope(formatGatewayCandidateUrl(params.savedGateway))
    : undefined;
  if (
    savedGatewayScope &&
    params.gatewayCandidates.every(
      (candidate) => gatewayOriginScope(formatGatewayCandidateUrl(candidate)) === savedGatewayScope,
    ) &&
    (await loadDeviceAuthTokenReadOnly({ deviceId: params.deviceId, role: "node", env }))?.token
  ) {
    // A co-located Gateway's shared password must not displace the paired node
    // credential. GatewayClient rereads the current token when connecting.
    return resolveExplicitGatewayAuth({
      token: env.OPENCLAW_GATEWAY_TOKEN,
      password: env.OPENCLAW_GATEWAY_PASSWORD,
    });
  }
  const mode = params.config.gateway?.mode === "remote" ? "remote" : "local";
  const configForResolution =
    mode === "local" ? buildNodeHostLocalAuthConfig(params.config) : params.config;
  return await resolveGatewayCredentialsWithSecretInputs({
    config: configForResolution,
    env,
    localPrecedence: "env-first",
    remoteTokenPrecedence: "env-first",
    remotePasswordPrecedence: "env-first", // pragma: allowlist secret
  });
}

function buildNodeHostLocalAuthConfig(config: OpenClawConfig): OpenClawConfig {
  if (!config.gateway?.remote?.token && !config.gateway?.remote?.password) {
    return config;
  }
  const nextConfig = structuredClone(config);
  copyConfigResolutionFactsExcept(config, nextConfig, [
    "gateway.remote.token",
    "gateway.remote.password",
  ]);
  if (nextConfig.gateway?.remote) {
    // Local node-host must not inherit gateway.remote.* auth material, which can
    // suppress GatewayClient device-token fallback and cause local token mismatches.
    nextConfig.gateway.remote.token = undefined;
    nextConfig.gateway.remote.password = undefined;
  }
  return nextConfig;
}

export async function runNodeHost(opts: NodeHostRunOptions): Promise<void> {
  // Operator-approved startup is a second authorized entry point for Doctor-owned
  // state migrators. Runtime invokes those owners here and never migrates inline.
  if (!getExistingOpenClawStateSchemaPath()) {
    await runStartupMigrations({ log: { info: writeStderrLine, warn: writeStderrLine } });
  }
  const cfg = getRuntimeConfig();
  const savedConfig = await loadNodeHostConfig();
  const plannedGateway: NodeHostGatewayConfig = {
    host: opts.gatewayHost,
    port: opts.gatewayPort,
    tls: opts.gatewayTls ?? cfg.gateway?.tls?.enabled ?? false,
    tlsFingerprint: opts.gatewayTlsFingerprint,
    contextPath: opts.gatewayContextPath,
    cloudflareAccess: opts.gatewayCloudflareAccess,
  };
  const fallbackDisplayName = await getMachineDisplayName();
  const config = await configureNodeHost({
    nodeId: opts.nodeId,
    displayName: opts.displayName,
    fallbackDisplayName,
    gateway: plannedGateway,
    installedAppsSharing: opts.installedAppsSharing,
    commands: opts.commands,
    allCommands: opts.allCommands,
  });
  const nodeId = config.nodeId;
  const displayName = config.displayName ?? fallbackDisplayName;
  const gateway = config.gateway ?? plannedGateway;
  const gatewayCandidates = opts.gatewayCandidates?.length
    ? opts.gatewayCandidates.map((candidate, index) =>
        index === 0 && gateway.cloudflareAccess && !candidate.cloudflareAccess
          ? { ...candidate, cloudflareAccess: gateway.cloudflareAccess }
          : candidate,
      )
    : [gateway];

  const plaintextAccessCandidate = gatewayCandidates.find(
    (candidate) => candidate.cloudflareAccess && candidate.tls !== true,
  );
  if (plaintextAccessCandidate) {
    throw new Error("Cloudflare Access credentials require a TLS Gateway connection");
  }

  const resolvedCloudflareAccess = await Promise.all(
    gatewayCandidates.map(
      async (candidate) =>
        await resolveNodeHostCloudflareAccess({
          value: candidate.cloudflareAccess,
          config: cfg,
          env: process.env,
        }),
    ),
  );
  const cloudflareAccessByCandidate = new Map<NodeHostGatewayConfig, CloudflareAccessCredentials>();
  gatewayCandidates.forEach((candidate, index) => {
    const credentials = resolvedCloudflareAccess[index];
    if (credentials) {
      cloudflareAccessByCandidate.set(candidate, credentials);
    }
  });
  const preparedRuntime = await prepareNodeHostRuntime({
    config: cfg,
    env: process.env,
    enableAgentRuns: true,
    enableWorkerRuns: true,
    forceWorkerRuns: opts.forceWorkerRuns,
    ephemeral: opts.ephemeral,
    installedAppsSharingEnabled: config.installedAppsSharing,
    commands: config.commands,
  });
  logInfo(`node-host: advertised commands: ${preparedRuntime.manifest.commands.join(", ")}`);
  const deviceIdentity = loadOrCreateDeviceIdentity();
  const { token, password } = opts.gatewayBootstrapToken
    ? {}
    : await resolveNodeHostGatewayCredentials({
        config: cfg,
        savedGateway: savedConfig?.gateway,
        gatewayCandidates,
        deviceId: deviceIdentity.deviceId,
        env: process.env,
      });

  let consecutivePermanentGatewayRejections = 0;
  const autoUpdateAbort = new AbortController();
  let autoUpdateStart: Promise<void> | undefined;
  let autoUpdater: { stop: () => Promise<void> } | undefined;
  const persistWinningGateway = (winningGateway: NodeHostGatewayConfig) => {
    void configureNodeHost({
      nodeId,
      displayName,
      fallbackDisplayName,
      gateway: winningGateway,
      installedAppsSharing: config.installedAppsSharing,
    }).catch((error: unknown) => {
      writeStderrLine(`node host gateway endpoint persistence failed: ${String(error)}`);
    });
  };

  const client = createNodeHostGatewayCandidateConnection({
    candidates: gatewayCandidates,
    cloudflareAccessByCandidate,
    clientOptions: {
      token: token || undefined,
      bootstrapToken: opts.gatewayBootstrapToken,
      preferBootstrapToken: opts.preferGatewayBootstrapToken,
      password: password || undefined,
      instanceId: nodeId,
      clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
      clientDisplayName: displayName,
      clientVersion: VERSION,
      ...resolveNodeHostGatewayPlatformIdentity(process.platform),
      mode: GATEWAY_CLIENT_MODES.NODE,
      role: "node",
      scopes: [],
      // Pair the built-in MCP command family up front. Server inventory is
      // restart-scoped availability, not a capability upgrade requiring re-pairing.
      caps: preparedRuntime.manifest.caps,
      commands: preparedRuntime.manifest.commands,
      computerUse: preparedRuntime.manifest.computerUse,
      pathEnv: preparedRuntime.manifest.pathEnv,
      permissions: undefined,
      deviceIdentity,
    },
    onEvent: (evt) => {
      if (evt.event === "node.pair.resolved") {
        if (
          isRecord(evt.payload) &&
          evt.payload.nodeId === deviceIdentity.deviceId &&
          evt.payload.decision === "approved"
        ) {
          activeRuntime.refreshRunnerInventory();
        }
        return;
      }
      if (evt.event === "node.invoke.cancel") {
        const payload = coerceNodeInvokeCancelPayload(evt.payload);
        if (payload) {
          activeRuntime.cancel(payload.invokeId);
        }
        return;
      }
      if (evt.event === "node.invoke.input") {
        const payload = coerceNodeInvokeInputPayload(evt.payload);
        if (payload) {
          activeRuntime.handleInput(payload.invokeId, payload.seq, payload.payloadJSON);
        }
        return;
      }
      if (evt.event !== "node.invoke.request") {
        return;
      }
      const payload = coerceNodeInvokePayload(evt.payload);
      if (payload) {
        void activeRuntime.invoke(payload);
      }
    },
    onHelloOk: (hello, url, tlsFingerprint, cloudflareAccess) => {
      consecutivePermanentGatewayRejections = 0;
      writeStderrLine(`node host gateway connected: ${url}`);
      if (opts.stopAfterFirstConnect) {
        void finish(0);
        return;
      }
      activeRuntime.connect({
        url,
        protocol: hello.protocol,
        capabilities: hello.features?.capabilities ?? [],
        ...(tlsFingerprint ? { tlsFingerprint } : {}),
        ...(cloudflareAccess ? { cloudflareAccess } : {}),
      });
      void announceLauncherReady(url, tlsFingerprint).catch((error: unknown) => {
        writeStderrLine(`node host update supervisor readiness failed: ${String(error)}`);
      });
    },
    onConnectError: (error) => {
      writeStderrLine(`node host gateway connect failed: ${error.message}`);
      const rejection =
        error instanceof GatewayClientRequestError && isRecord(error.details)
          ? error.details
          : undefined;
      if (
        rejection?.reason !== "websocket-upgrade-rejected" ||
        rejection.httpStatus !== 403 ||
        rejection.gatewayErrorType !== "proxy_attribution_required"
      ) {
        consecutivePermanentGatewayRejections = 0;
        return;
      }
      if (++consecutivePermanentGatewayRejections < 3) {
        return;
      }
      const remediation =
        typeof rejection.gatewayErrorMessage === "string"
          ? rejection.gatewayErrorMessage
          : error.message;
      writeStderrLine(
        `node host gateway permanently rejected connection (${rejection.gatewayErrorType}): ${remediation}; exiting`,
      );
      void finish(1);
    },
    onReconnectPaused: (info) => {
      handleNodeHostReconnectPaused(info, {
        exit: (code) => {
          // Terminal auth/version pauses restart under a supervisor; close MCP
          // subprocesses first so restart loops cannot orphan server processes.
          void finish(code).finally(() => requestExitAfterOneShotOutput(undefined, code));
        },
      });
    },
    onClose: (code, reason) => {
      activeRuntime.disconnect();
      writeStderrLine(`node host gateway closed (${code}): ${reason}`);
    },
    onWinningCandidate: persistWinningGateway,
  });
  const activeRuntime = startNodeHostConnection({
    prepared: preparedRuntime,
    client,
    writeStderrLine,
    onManifestChanged: (manifest) => client.updateNodeManifest(manifest),
  });

  async function announceLauncherReady(url: string, tlsFingerprint?: string) {
    if (!isNodeHostLauncherChild() || opts.ephemeral || autoUpdateAbort.signal.aborted) {
      return;
    }
    const endpoint = new URL(url);
    const args = [
      "node",
      "run",
      "--host",
      endpoint.hostname.replace(/^\[|\]$/g, ""),
      "--port",
      endpoint.port || (endpoint.protocol === "wss:" ? "443" : "80"),
      "--node-id",
      nodeId,
      "--display-name",
      displayName,
      endpoint.protocol === "wss:" ? "--tls" : "--no-tls",
      config.installedAppsSharing ? "--share-installed-apps" : "--no-share-installed-apps",
    ];
    if (endpoint.pathname !== "/") {
      args.push("--context-path", endpoint.pathname);
    }
    if (tlsFingerprint) {
      args.push("--tls-fingerprint", tlsFingerprint);
    }
    if (config.commands) {
      args.push("--commands", config.commands.join(","));
    }
    if (opts.forceWorkerRuns) {
      args.push("--session-host");
    }
    // One-use pairing credentials are replaced by the authenticated device state.
    await setNodeHostLauncherRestartArguments(args);
    if (autoUpdateAbort.signal.aborted) {
      return;
    }
    await notifyNodeHostLauncherReady(VERSION);
    autoUpdateStart ??= import("./auto-update.js").then(({ startNodeHostAutoUpdate }) => {
      if (!autoUpdateAbort.signal.aborted) {
        autoUpdater = startNodeHostAutoUpdate({
          runtime: activeRuntime,
          signal: autoUpdateAbort.signal,
          log: writeStderrLine,
          onRestartAccepted: () => {
            void finish(0);
          },
        });
      }
    });
    await autoUpdateStart;
  }

  let stopping = false;
  let resolveStopped: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });
  // A pending Promise alone does not keep Node alive. Pairing pauses can close
  // the last socket, so retain a handle until a signal finishes the foreground host.
  const lifetimeInterval = setInterval(() => {}, 1_000_000);
  const removeSignalHandlers = () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };
  const stopClientAndMcp = async () => {
    try {
      autoUpdateAbort.abort();
      // A failed lazy import was already reported by the hello handler; shutdown
      // still owns client and runtime cleanup.
      await autoUpdateStart?.catch(() => undefined);
      await autoUpdater?.stop();
      client.stop();
      await activeRuntime.close();
    } finally {
      clearInterval(lifetimeInterval);
    }
  };
  const finish = async (exitCode: number) => {
    if (stopping) {
      return;
    }
    stopping = true;
    let finalExitCode = exitCode;
    try {
      await stopClientAndMcp();
    } catch (error) {
      finalExitCode = 1;
      writeStderrLine(`node host shutdown failed: ${String(error)}`);
    } finally {
      removeSignalHandlers();
      process.exitCode = finalExitCode;
      resolveStopped?.();
    }
  };
  const onSigint = AsyncLocalStorage.bind(() => void finish(130));
  const onSigterm = AsyncLocalStorage.bind(() => void finish(143));
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  const readinessPromise = startGatewayClientWhenEventLoopReady(client);
  let readiness;
  try {
    readiness = await readinessPromise;
  } catch (error) {
    if (stopping) {
      await stopped;
      return;
    }
    removeSignalHandlers();
    await stopClientAndMcp();
    throw error;
  }
  if (!readiness.ready) {
    if (stopping) {
      await stopped;
      return;
    }
    removeSignalHandlers();
    await stopClientAndMcp();
    throw new Error("node host gateway event loop readiness timeout");
  }
  await stopped;
}
