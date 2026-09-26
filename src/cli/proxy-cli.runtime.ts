// Debug proxy runtime commands for capture sessions, validation, coverage, and blob reads.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { expectDefined } from "@openclaw/normalization-core";
import { colorize, isRich, theme } from "../../packages/terminal-core/src/theme.js";
import { loadPinnedRuntimeConfigAsync } from "../config/runtime-snapshot.js";
import {
  runProxyValidation,
  type ProxyValidationResult,
} from "../infra/net/proxy/proxy-validation.js";
import { ensureDebugProxyCa } from "../proxy-capture/ca.js";
import { buildDebugProxyCoverageReport } from "../proxy-capture/coverage.js";
import { resolveDebugProxySettings, applyDebugProxyEnv } from "../proxy-capture/env.js";
import { startDebugProxyServer } from "../proxy-capture/proxy-server.js";
import {
  finalizeDebugProxyCaptureAsync,
  initializeDebugProxyCaptureAsync,
} from "../proxy-capture/runtime.js";
import { acquireDebugProxyCaptureStoreAsync } from "../proxy-capture/store.async.js";
import type { CaptureQueryPreset } from "../proxy-capture/types.js";
import { defaultRuntime, writeRuntimeJson } from "../runtime.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { resolveSubprocessExitCode } from "./subprocess-exit-code.js";

async function finalizeProxyCommand(errors: unknown[], finalizers: Array<() => Promise<void>>) {
  for (const finalize of finalizers) {
    try {
      await finalize();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "Debug proxy command and capture cleanup failed.");
  }
}

export async function runDebugProxyStartCommand(opts: { host?: string; port?: number }) {
  const settings = resolveDebugProxySettings();
  const { environment: env } = captureOpenClawStateWorkerContext();
  const errors: unknown[] = [];
  const finalizers: Array<() => Promise<void>> = [];
  try {
    if (settings.enabled) {
      finalizers.push(() => finalizeDebugProxyCaptureAsync(settings));
      await initializeDebugProxyCaptureAsync("proxy-start", settings);
    }
    const lease = await acquireDebugProxyCaptureStoreAsync({ env });
    const { store } = lease;
    finalizers.push(lease.release);
    if (!settings.enabled) {
      finalizers.unshift(() => store.endSession(settings.sessionId));
      await store.upsertSession({
        id: settings.sessionId,
        startedAt: Date.now(),
        mode: "proxy-start",
        sourceScope: "openclaw",
        sourceProcess: "openclaw",
        proxyUrl: settings.proxyUrl,
      });
    }
    const ca = await ensureDebugProxyCa(settings.certDir);
    const server = await startDebugProxyServer({
      host: opts.host,
      port: opts.port,
      settings,
      env,
    });
    finalizers.unshift(() => server.stop());
    process.stdout.write(`Debug proxy: ${server.proxyUrl}\n`);
    process.stdout.write(`CA cert: ${ca.certPath}\n`);
    process.stdout.write(`Capture DB: ${store.dbPath}\n`);
    process.stdout.write("Press Ctrl+C to stop.\n");
    await new Promise<void>((resolve) => {
      const onSignal = () => {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
        resolve();
      };
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
    });
  } catch (error) {
    errors.push(error);
  }
  await finalizeProxyCommand(errors, finalizers);
  process.exit(0);
}

export async function runDebugProxyRunCommand(opts: {
  host?: string;
  port?: number;
  commandArgs: string[];
}) {
  // Each proxied child command gets its own capture session id for later query/filtering.
  if (opts.commandArgs.length === 0) {
    throw new Error("proxy run requires a command after --");
  }
  const sessionId = randomUUID();
  const baseSettings = resolveDebugProxySettings();
  const settings = {
    ...baseSettings,
    sessionId,
  };
  const { environment: env } = captureOpenClawStateWorkerContext();
  const lease = await acquireDebugProxyCaptureStoreAsync({ env });
  const { store } = lease;
  const errors: unknown[] = [];
  const finalizers = [() => store.endSession(sessionId), lease.release];
  try {
    await store.upsertSession({
      id: sessionId,
      startedAt: Date.now(),
      mode: "proxy-run",
      sourceScope: "openclaw",
      sourceProcess: "openclaw",
      proxyUrl: undefined,
    });
    const server = await startDebugProxyServer({
      host: opts.host,
      port: opts.port,
      settings,
      env,
    });
    finalizers.unshift(() => server.stop());
    const [command, ...args] = opts.commandArgs;
    const childEnv = applyDebugProxyEnv(process.env, {
      proxyUrl: server.proxyUrl,
      sessionId,
      certDir: settings.certDir,
    });
    await new Promise<void>((resolve, reject) => {
      const child = spawn(expectDefined(command, "proxy cli.runtime command"), args, {
        stdio: "inherit",
        env: childEnv,
        cwd: process.cwd(),
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        process.exitCode = resolveSubprocessExitCode(code, signal);
        resolve();
      });
    });
  } catch (error) {
    errors.push(error);
  }
  await finalizeProxyCommand(errors, finalizers);
}

function redactProxyUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = "redacted";
      url.password = "redacted";
    }
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "<invalid proxy URL>";
  }
}

function getProxyValidationTextColors() {
  const rich = isRich();
  const apply = (color: (value: string) => string) => (value: string) =>
    colorize(rich, color, value);
  return {
    heading: apply(theme.heading),
    success: apply(theme.success),
    error: apply(theme.error),
    muted: apply(theme.muted),
    warn: apply(theme.warn),
  };
}

function formatProxyCheckLine(
  check: ProxyValidationResult["checks"][number],
  colors: ReturnType<typeof getProxyValidationTextColors>,
): string {
  const icon = check.ok ? colors.success("✓") : colors.error("✗");
  const paddedKind = colors.muted(check.kind.padEnd(7, " "));
  const status =
    check.status === undefined
      ? ""
      : ` ${check.ok ? colors.success(`HTTP ${check.status}`) : colors.error(`HTTP ${check.status}`)}`;
  const detail = check.error
    ? ` — ${check.ok ? colors.muted(check.error) : colors.error(check.error)}`
    : "";
  return `  ${icon} ${paddedKind} ${check.url}${status}${detail}`;
}

function formatProxyValidationNextSteps(result: ProxyValidationResult): string[] {
  if (result.ok) {
    return [];
  }
  if (result.config.errors.some((error) => error.includes("proxy CA file could not be read"))) {
    return [
      "Confirm proxy.tls.caFile or --proxy-ca-file points to a readable PEM CA file for the HTTPS proxy endpoint.",
    ];
  }
  if (result.config.errors.length > 0) {
    return [
      "Fix proxy.proxyUrl, OPENCLAW_PROXY_URL, or --proxy-url so it uses a reachable http:// or https:// proxy.",
    ];
  }
  if (result.checks.some((check) => !check.ok && check.kind === "allowed")) {
    return [
      "Confirm the proxy is reachable from this deployment context and permits the allowed destinations.",
    ];
  }
  if (result.checks.some((check) => !check.ok && check.kind === "denied")) {
    return [
      "Update the proxy ACL so denied destinations are blocked, or pass the expected --denied-url values.",
    ];
  }
  return [
    "Review the failed checks above and update proxy configuration or validation destinations.",
  ];
}

function formatProxyValidationText(result: ProxyValidationResult): string {
  const colors = getProxyValidationTextColors();
  const redactedProxyUrl = redactProxyUrl(result.config.proxyUrl);
  const lines = [
    result.ok ? colors.success("Proxy validation passed") : colors.error("Proxy validation failed"),
    "",
    colors.heading("Proxy"),
    `  Source: ${colors.muted(result.config.source)}`,
    `  URL:    ${redactedProxyUrl ?? colors.muted("not configured")}`,
  ];

  if (result.config.errors.length > 0) {
    lines.push("", colors.heading("Problems"));
    for (const error of result.config.errors) {
      lines.push(`  - ${colors.error(error)}`);
    }
  }

  if (result.checks.length > 0) {
    lines.push("", colors.heading("Checks"));
    for (const check of result.checks) {
      lines.push(formatProxyCheckLine(check, colors));
    }
  }

  const nextSteps = formatProxyValidationNextSteps(result);
  if (nextSteps.length > 0) {
    lines.push("", colors.heading("Next steps"));
    for (const nextStep of nextSteps) {
      lines.push(`  ${colors.warn(nextStep)}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export async function runProxyValidateCommand(opts: {
  json?: boolean;
  proxyUrl?: string;
  proxyCaFile?: string;
  allowedUrls?: string[];
  deniedUrls?: string[];
  apnsReachability?: boolean;
  apnsAuthority?: string;
  timeoutMs?: number;
}) {
  const config = await loadPinnedRuntimeConfigAsync(async (assertCurrent) => {
    const { getRuntimeConfig } = await import("../config/config.js");
    assertCurrent();
    return { config: getRuntimeConfig() };
  });
  const result = await runProxyValidation({
    config: config?.proxy,
    env: process.env,
    proxyUrlOverride: opts.proxyUrl,
    proxyCaFileOverride: opts.proxyCaFile,
    allowedUrls: opts.allowedUrls,
    deniedUrls: opts.deniedUrls,
    apnsReachability: opts.apnsReachability,
    apnsAuthority: opts.apnsAuthority,
    timeoutMs: opts.timeoutMs,
  });
  const outputResult = {
    ...result,
    config: { ...result.config, proxyUrl: redactProxyUrl(result.config.proxyUrl) },
  };
  process.stdout.write(
    opts.json === true
      ? `${JSON.stringify(outputResult, null, 2)}\n`
      : formatProxyValidationText(outputResult),
  );
  if (!result.ok) {
    process.exitCode = 1;
  }
}

export async function runDebugProxySessionsCommand(opts: { json?: boolean; limit?: number }) {
  const lease = await acquireDebugProxyCaptureStoreAsync();
  try {
    const sessions = await lease.store.listSessions(opts.limit ?? 20);
    writeRuntimeJson(defaultRuntime, opts.json ? { sessions } : sessions);
  } finally {
    await lease.release();
  }
}

export async function runDebugProxyQueryCommand(opts: {
  json?: boolean;
  preset: CaptureQueryPreset;
  sessionId?: string;
}) {
  const lease = await acquireDebugProxyCaptureStoreAsync();
  try {
    const rows = await lease.store.queryPreset(opts.preset, opts.sessionId);
    writeRuntimeJson(defaultRuntime, opts.json ? { rows } : rows);
  } finally {
    await lease.release();
  }
}

export async function runDebugProxyCoverageCommand() {
  const report = buildDebugProxyCoverageReport();
  writeRuntimeJson(defaultRuntime, report);
}

export async function runDebugProxyPurgeCommand() {
  const lease = await acquireDebugProxyCaptureStoreAsync();
  try {
    const result = await lease.store.purgeAll();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await lease.release();
  }
}

export async function readDebugProxyBlobCommand(opts: { blobId: string }) {
  const lease = await acquireDebugProxyCaptureStoreAsync();
  try {
    const content = await lease.store.readBlob(opts.blobId);
    if (content == null) {
      throw new Error(`Unknown blob: ${opts.blobId}`);
    }
    process.stdout.write(content);
  } finally {
    await lease.release();
  }
}
