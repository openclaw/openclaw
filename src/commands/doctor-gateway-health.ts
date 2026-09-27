/** Gateway health probes used by doctor before deeper daemon and memory diagnostics. */
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { GatewayProtocolRequestTimeoutError } from "../../packages/gateway-client/src/protocol-request.js";
import { note } from "../../packages/terminal-core/src/note.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { formatCliCommand } from "../cli/command-format.js";
import { probeGatewayStatus } from "../cli/daemon-cli/probe.js";
import { DEFAULT_RESTART_HEALTH_TIMEOUT_MS } from "../cli/daemon-cli/restart-health.constants.js";
import {
  compareCliGatewayStateDirs,
  GATEWAY_SERVICE_PATHS_UNVERIFIED,
  inspectInstalledGatewayStatePaths,
  type GatewayHello,
} from "../cli/state-dir-gateway-check.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { scrubDoctorErrorMessage } from "../flows/doctor-error-message.js";
import { hasActiveGatewayExecCredential } from "../flows/doctor-gateway-exec-credential.js";
import type { HealthCheckContext, HealthFinding } from "../flows/health-checks.js";
import {
  buildGatewayConnectionDetails,
  buildGatewayProbeConnectionDetails,
  callGateway,
  isGatewayCredentialsRequiredError,
} from "../gateway/call.js";
import { isGatewaySecretRefUnavailableError } from "../gateway/credentials.js";
import { isLoopbackGatewayUrl } from "../gateway/net.js";
import type {
  DoctorMemoryEmbeddingRuntimePayload,
  DoctorMemoryStatusPayload,
} from "../gateway/server-methods/doctor.js";
import { collectChannelStatusIssues } from "../infra/channels-status-issues.js";
import { formatErrorMessage } from "../infra/errors.js";
import { formatDurationSeconds } from "../infra/format-time/format-duration.js";
import { readGatewayLastInstallationReplacement } from "../infra/gateway-boot-lifecycle.js";
import type { RuntimeEnv } from "../runtime.js";
import type { StatusSummary } from "../status/summary.js";
import { VERSION } from "../version.js";
import { projectDoctorSecretRuntimeDegradations } from "./doctor-secret-runtime-degradation.js";
import { waitForGatewayDiagnostic } from "./gateway-diagnostic-readiness.js";
import {
  GATEWAY_HEALTH_CREDENTIALS_REQUIRED_MESSAGE,
  GATEWAY_HEALTH_CREDENTIALS_REQUIRED_TITLE,
  GATEWAY_HEALTH_RATE_LIMITED_MESSAGE,
  GATEWAY_HEALTH_RATE_LIMITED_TITLE,
  gatewayConnectErrorWasRateLimited,
  gatewayProbeResultSawGateway,
  gatewayProbeResultWasRateLimited,
} from "./gateway-health-auth-diagnostic.js";
import {
  formatGatewayClosedDiagnostic,
  formatHealthCheckFailure,
  formatHealthDiagnosticNote,
} from "./health-format.js";
import { formatSqliteWalHealthWarning } from "./sqlite-wal-health.js";
import { formatTelemetryExporterSummary } from "./telemetry-exporter-summary.js";

function formatGatewayHealthDiagnostic(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  return scrubDoctorErrorMessage(sanitizeTerminalText(redactSensitiveUrlLikeString(raw)));
}

function readLocalInstallationReplacement(
  cfg: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): string | undefined {
  const replacement =
    cfg.gateway?.mode === "remote" ? undefined : readGatewayLastInstallationReplacement(env);
  return replacement
    ? `Previous installation replacement (${new Date(replacement.completedAtMs).toISOString()}): ${formatGatewayHealthDiagnostic(replacement.reason)}`
    : undefined;
}

export async function collectGatewayHealthFindings(
  ctx: Pick<HealthCheckContext, "cfg" | "configPath" | "env" | "allowExecSecretRefs">,
): Promise<readonly HealthFinding[]> {
  const mode = ctx.cfg.gateway?.mode === "remote" ? "remote" : "local";
  const gatewayPath = mode === "remote" ? "gateway.remote.url" : "gateway.mode";
  const replacement = readLocalInstallationReplacement(ctx.cfg, ctx.env);
  const historyFindings: HealthFinding[] = replacement
    ? [
        {
          checkId: "core/doctor/gateway-health",
          severity: "info",
          message: replacement,
          path: "gateway.mode",
        },
      ]
    : [];
  let probeDetails: Awaited<ReturnType<typeof buildGatewayProbeConnectionDetails>> | undefined;
  const warning = (message: string, fixHint: string): HealthFinding => ({
    checkId: "core/doctor/gateway-health",
    severity: "warning",
    message,
    path: probeDetails || mode === "remote" ? gatewayPath : "gateway",
    ...(probeDetails ? { target: formatGatewayHealthDiagnostic(probeDetails.url) } : {}),
    fixHint,
  });
  try {
    probeDetails = await buildGatewayProbeConnectionDetails({
      config: ctx.cfg,
      configPath: ctx.configPath,
    });
    if (
      ctx.allowExecSecretRefs !== true &&
      (await hasActiveGatewayExecCredential({
        cfg: ctx.cfg,
        env: ctx.env,
        targetUrl: probeDetails.url,
      }))
    ) {
      return [
        ...historyFindings,
        warning(
          "Authenticated Gateway health inspection was intentionally skipped because an active credential uses an exec SecretRef.",
          "Rerun `openclaw doctor --lint --only core/doctor/gateway-health --allow-exec` to permit configured secret execution.",
        ),
      ];
    }
    const status = await callGateway<StatusSummary>({
      method: "status",
      params: { includeChannelSummary: false },
      timeoutMs: 3000,
      sharedStateMode: "read-only",
      config: ctx.cfg,
      configPath: ctx.configPath,
      tlsFingerprint: probeDetails.tlsFingerprint,
      preauthHandshakeTimeoutMs: probeDetails.preauthHandshakeTimeoutMs,
    });
    const findings: HealthFinding[] = projectDoctorSecretRuntimeDegradations(status).map(
      (owner) => ({
        checkId: "core/doctor/gateway-health",
        severity: "warning",
        message: `Secret runtime degradation: ${owner.message}`,
        path: owner.path,
        target: owner.target,
        fixHint: `Retry: ${owner.retryHint}`,
      }),
    );
    const sqliteWalWarning = formatSqliteWalHealthWarning(status.sqliteWal);
    if (sqliteWalWarning) {
      findings.push(
        warning(`SQLite WAL: ${sqliteWalWarning}`, "Inspect openclaw status --deep output."),
      );
    }
    if (status.installationReplacementWarning) {
      findings.push(
        warning(
          formatGatewayHealthDiagnostic(status.installationReplacementWarning),
          "Wait for the service manager to restart the Gateway; for a foreground Gateway, run `openclaw gateway run` again after it exits.",
        ),
      );
    }
    return [...historyFindings, ...findings];
  } catch (error) {
    if (!probeDetails) {
      return [
        ...historyFindings,
        warning(
          `Gateway health inspection could not be prepared: ${formatGatewayHealthDiagnostic(error)}`,
          "Fix Gateway connection configuration, then rerun `openclaw doctor --lint --only core/doctor/gateway-health`.",
        ),
      ];
    }
    const diagnostic = gatewayConnectErrorWasRateLimited(error)
      ? {
          message: GATEWAY_HEALTH_RATE_LIMITED_MESSAGE,
          fixHint: "Wait for the temporary authentication lockout to expire, then rerun doctor.",
        }
      : isGatewayCredentialsRequiredError(error) || isGatewaySecretRefUnavailableError(error)
        ? {
            message:
              "Gateway status could not be inspected because this CLI has no usable token/password or paired device token for read-scope RPCs.",
            fixHint:
              "Configure the Gateway token/password or pair this device, then rerun the selected health check.",
          }
        : {
            message: `Gateway status could not be inspected: ${formatGatewayHealthDiagnostic(error)}`,
            fixHint:
              mode === "remote"
                ? "Verify the remote Gateway URL, network path, TLS settings, and credentials."
                : "Inspect the service with `openclaw gateway status --deep`, or run `openclaw doctor` for guided checks.",
          };
    return [...historyFindings, warning(diagnostic.message, diagnostic.fixHint)];
  }
}

type GatewayMemoryProbe = {
  checked: boolean;
  ready: boolean;
  error?: string;
  runtimeFacts?: DoctorMemoryEmbeddingRuntimePayload;
  /**
   * True when the probe was intentionally skipped by the gateway (probe: false
   * path). Distinct from checked: false caused by a network timeout or
   * unavailable gateway. Renderers should suppress warnings only for skipped
   * probes, not for transport failures.
   */
  skipped: boolean;
};

function isGatewayCallTimeout(message: string): boolean {
  return /^gateway timeout after \d+ms(?:\n|$)/.test(message);
}

function resolveGatewayDiagnosticsTimeouts(timeoutMs: number, statusElapsedMs: number) {
  // Preserve five seconds of channel work, plus the measured round-trip and result-delivery margin.
  const transportMs = Math.ceil(statusElapsedMs) + 1_000;
  const diagnosticsTimeoutMs = Math.min(
    30_000,
    Math.max(timeoutMs, 5_000 + transportMs, Math.ceil(statusElapsedMs * 3)),
  );
  return {
    diagnosticsTimeoutMs,
    channelProbeTimeoutMs: Math.max(1, diagnosticsTimeoutMs - transportMs),
  };
}

function isGatewayHealthAuthUnavailableError(error: unknown): boolean {
  return isGatewayCredentialsRequiredError(error) || isGatewaySecretRefUnavailableError(error);
}

function noteCliGatewayVersionSkew(status: StatusSummary | undefined): void {
  const gatewayVersion = status?.runtimeVersion?.trim();
  if (!gatewayVersion || gatewayVersion === VERSION) {
    return;
  }
  note(
    [
      `This command is OpenClaw ${VERSION}; the running Gateway is OpenClaw ${gatewayVersion}.`,
      "Check `openclaw --version`, `which openclaw`, and `openclaw gateway status --deep`.",
      "If this mismatch is unexpected, update PATH so `openclaw` points to the version you want, or reinstall the Gateway service from that same OpenClaw install.",
    ].join("\n"),
    "OpenClaw version mismatch",
  );
}

function noteGatewayStateDirectory(
  snapshot: Pick<GatewayHello["snapshot"], "stateDir" | "configPath">,
  source: "live Gateway" | "installed Gateway service",
): void {
  if (!snapshot.stateDir) {
    return;
  }
  const comparison = compareCliGatewayStateDirs({
    cliStateDir: resolveStateDir(process.env),
    cliConfigPath: resolveConfigPath(process.env),
    gatewayStateDir: snapshot.stateDir,
    gatewayConfigPath: snapshot.configPath,
    source,
    mode: "warn",
  });
  if (comparison.kind === "warn") {
    note(
      `${comparison.message}\nRun plugin inspection and doctor --fix with the Gateway's OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH. To change the managed service, run \`openclaw gateway install --force\` from the intended profile and review operator-owned service overrides.`,
      "Gateway state directory mismatch",
    );
  }
}

async function noteInstalledGatewayStateDirectory(cfg: OpenClawConfig, timeoutMs: number) {
  // A remote Gateway can use a loopback tunnel or have no configured URL.
  // Neither case makes the local installed service authoritative.
  if (cfg.gateway?.mode === "remote") {
    return;
  }
  try {
    if (!isLoopbackGatewayUrl(buildGatewayConnectionDetails({ config: cfg }).url)) {
      return;
    }
    const paths = await inspectInstalledGatewayStatePaths(Math.min(timeoutMs, 3_000));
    if (paths.kind === "known") {
      noteGatewayStateDirectory(paths, "installed Gateway service");
    } else if (paths.kind === "unknown") {
      note(GATEWAY_SERVICE_PATHS_UNVERIFIED, "Gateway state directory");
    }
  } catch {
    note(GATEWAY_SERVICE_PATHS_UNVERIFIED, "Gateway state directory");
  }
}

/**
 * Probes gateway status and reports user-facing connection/auth/channel warnings.
 *
 * A credentials-required gateway still counts as healthy but unauthenticated when the preauth
 * probe confirms the server is reachable.
 */
export async function checkGatewayHealth(params: {
  runtime: RuntimeEnv;
  cfg: OpenClawConfig;
  timeoutMs?: number;
}): Promise<{ healthOk: boolean; authenticated: boolean; status?: StatusSummary }> {
  const replacement = readLocalInstallationReplacement(params.cfg);
  if (replacement) {
    note(replacement, "Previous Gateway installation replacement");
  }
  const { bindAgentToolGatewayRequest } = await import("../agents/tools/in-process-gateway.js");
  const requestGateway = bindAgentToolGatewayRequest({ hostedOnly: true });
  const timeoutMs =
    typeof params.timeoutMs === "number" && params.timeoutMs > 0
      ? params.timeoutMs
      : DEFAULT_RESTART_HEALTH_TIMEOUT_MS;
  let healthOk = false;
  let status: StatusSummary | undefined;
  let gatewaySnapshot: GatewayHello["snapshot"] | undefined;
  try {
    const remainingMs = await waitForGatewayDiagnostic(
      { config: params.cfg, timeoutMs },
      params.runtime,
    );
    if (remainingMs === undefined) {
      return { healthOk: true, authenticated: false };
    }
    const statusStartedAt = performance.now();
    status = await callGateway<StatusSummary>({
      method: "status",
      params: { includeChannelSummary: false },
      timeoutMs: remainingMs,
      config: params.cfg,
      onHelloOk: ({ snapshot }: GatewayHello) => {
        gatewaySnapshot = snapshot;
        noteGatewayStateDirectory(snapshot, "live Gateway");
      },
    });
    const statusElapsedMs = performance.now() - statusStartedAt;
    const { diagnosticsTimeoutMs, channelProbeTimeoutMs } = resolveGatewayDiagnosticsTimeouts(
      timeoutMs,
      statusElapsedMs,
    );
    const slowDiagnosticNote = (diagnostic: string) =>
      `Gateway answered status in ${formatDurationSeconds(statusElapsedMs)}; ${diagnostic} diagnostics did not finish within ${formatDurationSeconds(diagnosticsTimeoutMs)}. The host may be slow; this does not mark the Gateway unhealthy.`;
    healthOk = true;
    noteCliGatewayVersionSkew(status);
    if (status.startupMigrationWarning) {
      note(sanitizeTerminalText(status.startupMigrationWarning), "Startup migration warnings");
    }
    const sqliteWalWarning = formatSqliteWalHealthWarning(status.sqliteWal);
    if (sqliteWalWarning) {
      note(sqliteWalWarning, "SQLite WAL");
    }
    if (status.startupRecoveryWarning) {
      note(sanitizeTerminalText(status.startupRecoveryWarning), "Startup session recovery");
    }
    if (status.installationReplacementWarning) {
      note(sanitizeTerminalText(status.installationReplacementWarning), "Installation replaced");
    }
    const secretDegradations = projectDoctorSecretRuntimeDegradations(status);
    if (secretDegradations.length > 0) {
      note(
        secretDegradations
          .map((owner) => `- ${owner.message}\n  Retry: ${owner.retryHint}`)
          .join("\n"),
        "Secret runtime degradation",
      );
    }
    if (status.degradedPlugins && status.degradedPlugins.length > 0) {
      note(
        status.degradedPlugins
          .map(
            (plugin) =>
              `- ${plugin.pluginId} (${plugin.diagnostic.reason}): ${plugin.diagnostic.detail}`,
          )
          .join("\n"),
        "Plugins configured unavailable",
      );
    }
    const [channelsResult, exporterResult] = await Promise.allSettled([
      callGateway({
        method: "channels.status",
        params: { probe: true, timeoutMs: channelProbeTimeoutMs },
        timeoutMs: diagnosticsTimeoutMs,
        config: params.cfg,
      }),
      requestGateway({
        method: "diagnostics.stability",
        params: { type: "telemetry.exporter", limit: 1000 },
        timeoutMs: diagnosticsTimeoutMs,
        config: params.cfg,
      }),
    ]);
    if (channelsResult.status === "fulfilled") {
      const issues = collectChannelStatusIssues(channelsResult.value);
      if (issues.length > 0) {
        note(
          issues
            .map(
              (issue) =>
                `- ${issue.channel} ${issue.accountId}: ${issue.message}${
                  issue.fix ? ` (${issue.fix})` : ""
                }`,
            )
            .join("\n"),
          "Channel warnings",
        );
      }
    } else {
      note(
        [
          isGatewayCallTimeout(formatErrorMessage(channelsResult.reason))
            ? slowDiagnosticNote("channel")
            : `Channel status probe failed: ${sanitizeTerminalText(formatErrorMessage(channelsResult.reason))}`,
          `Retry: ${formatCliCommand("openclaw channels status --probe")}`,
        ].join("\n"),
        "Channel warnings",
      );
    }
    if (exporterResult.status === "fulfilled") {
      const exporterSummary = formatTelemetryExporterSummary(exporterResult.value);
      if (exporterSummary) {
        note(exporterSummary.lines.join("\n"), exporterSummary.title);
      }
    } else {
      note(
        [
          exporterResult.reason instanceof GatewayProtocolRequestTimeoutError ||
          isGatewayCallTimeout(formatErrorMessage(exporterResult.reason))
            ? slowDiagnosticNote("exporter")
            : `Exporter diagnostics failed: ${sanitizeTerminalText(formatErrorMessage(exporterResult.reason))}`,
          `Retry: ${formatCliCommand("openclaw gateway stability --type telemetry.exporter")}`,
        ].join("\n"),
        "Telemetry exporters",
      );
    }
    return { healthOk, authenticated: true, status };
  } catch (err) {
    if (!gatewaySnapshot?.stateDir) {
      await noteInstalledGatewayStateDirectory(params.cfg, timeoutMs);
    }
    if (gatewayConnectErrorWasRateLimited(err)) {
      note(GATEWAY_HEALTH_RATE_LIMITED_MESSAGE, GATEWAY_HEALTH_RATE_LIMITED_TITLE);
      return { healthOk: true, authenticated: false };
    }
    if (isGatewayHealthAuthUnavailableError(err)) {
      const probeDetails = await buildGatewayProbeConnectionDetails({ config: params.cfg });
      const probe = await probeGatewayStatus({
        url: probeDetails.url,
        timeoutMs,
        tlsFingerprint: probeDetails.tlsFingerprint,
        preauthHandshakeTimeoutMs: probeDetails.preauthHandshakeTimeoutMs,
        config: params.cfg,
        json: true,
      });
      if (gatewayProbeResultSawGateway(probe)) {
        if (gatewayProbeResultWasRateLimited(probe)) {
          note(GATEWAY_HEALTH_RATE_LIMITED_MESSAGE, GATEWAY_HEALTH_RATE_LIMITED_TITLE);
        } else {
          note(
            GATEWAY_HEALTH_CREDENTIALS_REQUIRED_MESSAGE,
            GATEWAY_HEALTH_CREDENTIALS_REQUIRED_TITLE,
          );
        }
        healthOk = true;
        return { healthOk, authenticated: false };
      }
    }
    const closedDiagnostic = formatGatewayClosedDiagnostic(err);
    if (closedDiagnostic) {
      const gatewayDetails = buildGatewayConnectionDetails({ config: params.cfg });
      note(closedDiagnostic, "Gateway");
      note(formatHealthDiagnosticNote(gatewayDetails.message), "Gateway connection");
    } else {
      params.runtime.error(formatHealthCheckFailure(err));
    }
  }

  return { healthOk, authenticated: false, status };
}

/** Probes gateway memory readiness without forcing deep embedding checks. */
export async function probeGatewayMemoryStatus(params: {
  cfg: OpenClawConfig;
  timeoutMs?: number;
}): Promise<GatewayMemoryProbe> {
  const { bindAgentToolGatewayRequest } = await import("../agents/tools/in-process-gateway.js");
  const requestGateway = bindAgentToolGatewayRequest({ hostedOnly: true });
  const timeoutMs =
    typeof params.timeoutMs === "number" && params.timeoutMs > 0 ? params.timeoutMs : 8_000;
  try {
    const payload = await requestGateway<DoctorMemoryStatusPayload>({
      method: "doctor.memory.status",
      params: { probe: false },
      timeoutMs,
      config: params.cfg,
    });
    // Propagate the gateway's checked flag. When the gateway skips the embedding
    // probe (probe: false path), it returns checked: false to signal that no
    // readiness determination was made. Mapping that to checked: true here would
    // cause the renderer to treat a skipped probe as a checked-but-not-ready
    // failure and emit a false-positive warning for key-optional providers.
    // We also carry skipped: true so renderers can distinguish an intentional
    // non-deep skip from a transport timeout (which also returns checked: false).
    const gatewayChecked = payload.embedding.checked !== false;
    return {
      checked: gatewayChecked,
      ready: payload.embedding.ok,
      error: payload.embedding.error,
      ...(payload.embeddingRuntime ? { runtimeFacts: payload.embeddingRuntime } : {}),
      skipped: !gatewayChecked,
    };
  } catch (err) {
    const message = formatErrorMessage(err);
    if (isGatewayCallTimeout(message)) {
      return {
        checked: false,
        ready: false,
        error: `gateway memory probe timed out: ${message}`,
        skipped: false,
      };
    }
    return {
      checked: true,
      ready: false,
      error: `gateway memory probe unavailable: ${message}`,
      skipped: false,
    };
  }
}
