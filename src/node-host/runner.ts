import { AsyncLocalStorage } from "node:async_hooks";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { CloudflareAccessCredentials } from "../../packages/gateway-client/src/cloudflare-access.js";
import { startGatewayClientWhenEventLoopReady } from "../../packages/gateway-client/src/readiness.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { ConnectErrorDetailCodes } from "../../packages/gateway-protocol/src/connect-error-details.js";
import { requestExitAfterOneShotOutput } from "../cli/one-shot-exit.js";
import { getRuntimeConfig, type OpenClawConfig } from "../config/config.js";
import { copyConfigResolutionFactsExcept } from "../config/resolution-facts.js";
import { GatewayClientRequestError } from "../gateway/client.js";
import { resolveGatewayCredentialsWithSecretInputs } from "../gateway/credentials-secret-inputs.js";
import { resolveExplicitGatewayAuth } from "../gateway/credentials.js";
import {
  loadDeviceIdentityIfPresent,
  loadOrCreateDeviceIdentity,
} from "../infra/device-identity.js";
import { formatErrorMessage } from "../infra/errors.js";
import { getMachineDisplayName } from "../infra/machine-name.js";
import { logInfo } from "../logger.js";
import { createDeferredCore } from "../shared/deferred.js";
import { VERSION } from "../version.js";
import { throwNodeHostCleanupErrors } from "./cleanup-errors.js";
import { configureNodeHost, loadNodeHostConfig, type NodeHostGatewayConfig } from "./config.js";
import { startNodeHostConnection } from "./connection.js";
import { canReuseNodeHostDeviceToken } from "./gateway-auth.js";
import { createNodeHostGatewayCandidateConnection } from "./gateway-candidate-connection.js";
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
  watchNodeHostParentStdin,
} from "./launcher-client.js";
import { prepareNodeHostRuntime } from "./runtime.js";
import { ensureNodeHostStateReady } from "./startup-state-readiness.js";

type NodeHostRunOptions = {
  gatewayHost: string;
  gatewayPort: number;
  gatewayTls?: boolean;
  gatewayTlsFingerprint?: string;
  gatewayCloudflareAccess?: NodeHostCloudflareAccessConfig;
  gatewayCandidates?: NodeHostGatewayConfig[];
  gatewayBootstrapToken?: string;
  gatewayBootstrapExpiresAtMs?: number;
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
  desktopSharingEnabled?: boolean;
  gatewayAuthFromEnv?: boolean;
  parentStdin?: boolean;
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

async function resolveNodeHostGatewayCredentials(params: {
  config: OpenClawConfig;
  savedGateway?: NodeHostGatewayConfig;
  gatewayCandidates: readonly NodeHostGatewayConfig[];
  deviceId: string;
  envOnly?: boolean;
}): Promise<{ token?: string; password?: string }> {
  const env = process.env;
  const canReuseDeviceToken = await canReuseNodeHostDeviceToken(params);
  if (params.envOnly) {
    const auth = resolveExplicitGatewayAuth({
      token: env.OPENCLAW_GATEWAY_TOKEN,
      password: env.OPENCLAW_GATEWAY_PASSWORD,
    });
    if (canReuseDeviceToken && (auth.token || auth.password)) {
      const sources = [
        ...(auth.token ? ["OPENCLAW_GATEWAY_TOKEN"] : []),
        ...(auth.password ? ["OPENCLAW_GATEWAY_PASSWORD"] : []),
      ];
      writeStderrLine(
        `node host: --auth-from-env selects ${sources.join(" and ")} instead of the paired device token`,
      );
    }
    return auth;
  }
  if (canReuseDeviceToken) {
    // GatewayClient rereads the current paired token when connecting.
    return {};
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

/**
 * The saved Gateway endpoint when a node credential exists to reconnect without a setup code.
 * Node tokens are not bound to an endpoint, so callers must present the reconnect as conditional.
 */
export async function loadResumableNodeHostGateway(): Promise<NodeHostGatewayConfig | undefined> {
  // A failed first enrollment saves the endpoint before any device token exists.
  const gateway = (await loadNodeHostConfig())?.gateway;
  const identity = gateway ? loadDeviceIdentityIfPresent() : null;
  return gateway &&
    identity &&
    (await canReuseNodeHostDeviceToken({
      savedGateway: gateway,
      gatewayCandidates: [gateway],
      deviceId: identity.deviceId,
    }))
    ? gateway
    : undefined;
}

export async function runNodeHost(opts: NodeHostRunOptions): Promise<void> {
  const { initializeSqliteRuntimeCapabilities } = await import("../infra/bun-sqlite-library.js");
  await initializeSqliteRuntimeCapabilities();
  ensureNodeHostStateReady();
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
  let gatewayBootstrapToken = opts.gatewayBootstrapToken;
  let reuseDeviceTokenOnly = false;
  if (
    gatewayBootstrapToken &&
    opts.gatewayBootstrapExpiresAtMs !== undefined &&
    opts.gatewayBootstrapExpiresAtMs <= Date.now()
  ) {
    const identity = loadDeviceIdentityIfPresent();
    if (
      opts.preferGatewayBootstrapToken ||
      opts.gatewayAuthFromEnv ||
      !identity ||
      !(await canReuseNodeHostDeviceToken({
        savedGateway: savedConfig?.gateway,
        gatewayCandidates: opts.gatewayCandidates?.length
          ? opts.gatewayCandidates
          : [plannedGateway],
        deviceId: identity.deviceId,
      }))
    ) {
      throw new Error("Pairing setup code has expired.");
    }
    // The existing pairing can reconnect; never submit its expired fallback bearer.
    gatewayBootstrapToken = undefined;
    reuseDeviceTokenOnly = true;
  }
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
    forceWorkerRuns: opts.forceWorkerRuns,
    ephemeral: opts.ephemeral,
    installedAppsSharingEnabled: config.installedAppsSharing,
    desktopSharingEnabled: opts.desktopSharingEnabled,
    commands: config.commands,
  });
  logInfo(`node-host: advertised commands: ${preparedRuntime.manifest.commands.join(", ")}`);
  const deviceIdentity = loadOrCreateDeviceIdentity();
  const { token, password } =
    gatewayBootstrapToken || reuseDeviceTokenOnly
      ? {}
      : await resolveNodeHostGatewayCredentials({
          config: cfg,
          envOnly: opts.gatewayAuthFromEnv,
          savedGateway: savedConfig?.gateway,
          gatewayCandidates,
          deviceId: deviceIdentity.deviceId,
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
      bootstrapToken: gatewayBootstrapToken,
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
      const shouldExit =
        info.detailCode !== null && NODE_HOST_EXIT_ON_RECONNECT_PAUSE_CODES.has(info.detailCode);
      const detail = info.detailCode ? ` detail=${info.detailCode}` : "";
      const reason = info.reason.trim() || "no close reason";
      const action = shouldExit ? "exiting for supervisor restart" : "waiting for operator action";
      writeStderrLine(
        `node host gateway reconnect paused after close (${info.code}): ${reason}${detail}; ${action}`,
      );
      if (shouldExit) {
        // Terminal auth/version pauses restart under a supervisor; close MCP
        // subprocesses first so restart loops cannot orphan server processes.
        void finish(1).finally(() => requestExitAfterOneShotOutput(undefined, 1));
      }
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
    if (opts.desktopSharingEnabled !== undefined) {
      args.push(opts.desktopSharingEnabled ? "--desktop-sharing" : "--no-desktop-sharing");
    }
    if (opts.gatewayAuthFromEnv) {
      args.push("--auth-from-env");
    }
    if (opts.parentStdin) {
      args.push("--parent-stdin");
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
  const { promise: stopped, resolve: resolveStopped } = createDeferredCore();
  // A pending Promise alone does not keep Node alive. Pairing pauses can close
  // the last socket, so retain a handle until a signal finishes the foreground host.
  const lifetimeInterval = setInterval(() => {}, 1_000_000);
  let stopWatchingParent = () => {};
  const removeSignalHandlers = () => {
    stopWatchingParent();
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };
  const stopClientAndMcp = async () => {
    stopping = true;
    try {
      autoUpdateAbort.abort();
      // A failed lazy import was already reported by the hello handler; shutdown
      // still owns client and runtime cleanup.
      await autoUpdateStart?.catch(() => undefined);
      await autoUpdater?.stop();
      const failures: unknown[] = [];
      for (const close of [() => client.stop(), () => activeRuntime.close()]) {
        try {
          await close();
        } catch (error) {
          failures.push(error);
        }
      }
      throwNodeHostCleanupErrors(failures, "node host shutdown cleanup failed");
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
      writeStderrLine(`node host shutdown failed: ${formatErrorMessage(error)}`);
    } finally {
      removeSignalHandlers();
      process.exitCode = finalExitCode;
      resolveStopped();
    }
  };
  const onSigint = AsyncLocalStorage.bind(() => void finish(130));
  const onSigterm = AsyncLocalStorage.bind(() => void finish(143));
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  if (opts.parentStdin && !isNodeHostLauncherChild()) {
    stopWatchingParent = watchNodeHostParentStdin(onSigterm);
  }

  const readinessPromise = startGatewayClientWhenEventLoopReady(client);
  try {
    const readiness = await readinessPromise;
    if (!readiness.ready) {
      throw new Error("node host gateway event loop readiness timeout");
    }
  } catch (error) {
    if (stopping) {
      await stopped;
      return;
    }
    removeSignalHandlers();
    await stopClientAndMcp();
    throw error;
  }
  await stopped;
}
