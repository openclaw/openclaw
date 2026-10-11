import { randomUUID } from "node:crypto";
import process from "node:process";
import { expectDefined } from "@openclaw/normalization-core";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { loadPinnedRuntimeConfigAsync } from "../config/runtime-snapshot.js";
import {
  runProxyValidation,
  type ProxyValidationResult,
} from "../infra/net/proxy/proxy-validation.js";
import { spawnCommand } from "../process/exec-spawn.js";
import { ensureDebugProxyCa } from "../proxy-capture/ca.js";
import { buildDebugProxyCoverageReport } from "../proxy-capture/coverage.js";
import { resolveDebugProxySettings, applyDebugProxyEnv } from "../proxy-capture/env.js";
import { startDebugProxyServer } from "../proxy-capture/proxy-server.js";
import type { CaptureQueryPreset } from "../proxy-capture/types.js";
import { defaultRuntime, writeRuntimeJson } from "../runtime.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { withProxyCaptureOwner } from "./proxy-capture-owner.js";
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
  let releaseSignals: (() => void) | undefined;
  try {
    await withProxyCaptureOwner(async (store, ownerSignal) => {
      const workSignal = getAsyncWorkSignal();
      const signal = workSignal ? AbortSignal.any([ownerSignal, workSignal]) : ownerSignal;
      const settings = resolveDebugProxySettings();
      const errors: unknown[] = [];
      const finalizers: Array<() => Promise<void>> = [];
      try {
        finalizers.unshift(() => store.endSession(settings.sessionId));
        await store.upsertSession({
          id: settings.sessionId,
          startedAt: Date.now(),
          mode: "proxy-start",
          sourceScope: "openclaw",
          sourceProcess: "openclaw",
          proxyUrl: settings.proxyUrl,
        });
        const ca = await ensureDebugProxyCa(settings.certDir);
        signal.throwIfAborted();
        const server = await startDebugProxyServer({
          host: opts.host,
          port: opts.port,
          settings,
          captureStore: store,
        });
        finalizers.unshift(() => server.stop());
        signal.throwIfAborted();
        process.stdout.write(`Debug proxy: ${server.proxyUrl}\n`);
        process.stdout.write(`CA cert: ${ca.certPath}\n`);
        process.stdout.write(`Capture DB: ${store.dbPath}\n`);
        process.stdout.write("Press Ctrl+C to stop.\n");
        await new Promise<void>((resolve) => {
          const onSignal = () => resolve();
          releaseSignals = () => {
            process.off("SIGINT", onSignal);
            process.off("SIGTERM", onSignal);
            signal.removeEventListener("abort", onSignal);
          };
          process.on("SIGINT", onSignal);
          process.on("SIGTERM", onSignal);
          signal.addEventListener("abort", onSignal, { once: true });
          if (signal.aborted) {
            onSignal();
          }
        });
      } catch (error) {
        errors.push(error);
      }
      await finalizeProxyCommand(errors, finalizers);
    });
  } finally {
    // Signal custody lasts through capture writes and native lease retirement.
    releaseSignals?.();
  }
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
  let releaseSignals: (() => void) | undefined;
  try {
    await withProxyCaptureOwner(async (store, ownerSignal) => {
      const workSignal = getAsyncWorkSignal();
      const signal = workSignal ? AbortSignal.any([ownerSignal, workSignal]) : ownerSignal;
      const sessionId = randomUUID();
      const baseSettings = resolveDebugProxySettings();
      const settings = {
        ...baseSettings,
        sessionId,
      };
      const errors: unknown[] = [];
      const finalizers = [() => store.endSession(sessionId)];
      try {
        await store.upsertSession({
          id: sessionId,
          startedAt: Date.now(),
          mode: "proxy-run",
          sourceScope: "openclaw",
          sourceProcess: "openclaw",
          proxyUrl: undefined,
        });
        signal.throwIfAborted();
        const server = await startDebugProxyServer({
          host: opts.host,
          port: opts.port,
          settings,
          captureStore: store,
        });
        finalizers.unshift(() => server.stop());
        signal.throwIfAborted();
        const [command, ...args] = opts.commandArgs;
        const childEnv = {
          ...applyDebugProxyEnv(process.env, {
            proxyUrl: server.proxyUrl,
            sessionId,
            certDir: settings.certDir,
          }),
          ...server.captureEnv,
        };
        // The command owner cancels this child and joins its exit/stdio before
        // the proxy and capture lease are retired. Keep inherited terminal I/O.
        const child = spawnCommand([expectDefined(command, "proxy cli.runtime command"), ...args], {
          stdio: "inherit",
          env: childEnv,
          cwd: process.cwd(),
          cancelSignal: signal,
          reject: false,
        });
        let childSettled = false;
        const onSigint = () => {
          if (!childSettled) {
            child.kill("SIGINT");
          }
        };
        const onSigterm = () => {
          if (!childSettled) {
            child.kill("SIGTERM");
          }
        };
        releaseSignals = () => {
          process.off("SIGINT", onSigint);
          process.off("SIGTERM", onSigterm);
        };
        process.on("SIGINT", onSigint);
        process.on("SIGTERM", onSigterm);
        try {
          const result = await child;
          if (result.failed && result.exitCode === undefined && result.signal === undefined) {
            throw toErrorObject(result, "Proxy child failed during launch or output capture");
          }
          process.exitCode = resolveSubprocessExitCode(result.exitCode, result.signal);
        } finally {
          childSettled = true;
        }
      } catch (error) {
        errors.push(error);
      }
      await finalizeProxyCommand(errors, finalizers);
    });
  } finally {
    // Signal custody lasts through capture writes and native lease retirement.
    releaseSignals?.();
  }
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

function formatProxyCheckLine(check: ProxyValidationResult["checks"][number]): string {
  const icon = check.ok ? theme.success("✓") : theme.error("✗");
  const paddedKind = theme.muted(check.kind.padEnd(7, " "));
  const status =
    check.status === undefined
      ? ""
      : ` ${check.ok ? theme.success(`HTTP ${check.status}`) : theme.error(`HTTP ${check.status}`)}`;
  const detail = check.error
    ? ` — ${check.ok ? theme.muted(check.error) : theme.error(check.error)}`
    : "";
  return `  ${icon} ${paddedKind} ${check.url}${status}${detail}`;
}

function formatProxyValidationNextStep(result: ProxyValidationResult): string | undefined {
  if (result.ok) {
    return undefined;
  }
  if (result.config.errors.some((error) => error.includes("proxy CA file could not be read"))) {
    return "Confirm proxy.tls.caFile or --proxy-ca-file points to a readable PEM CA file for the HTTPS proxy endpoint.";
  }
  if (result.config.errors.length > 0) {
    return "Fix proxy.proxyUrl, OPENCLAW_PROXY_URL, or --proxy-url so it uses a reachable http:// or https:// proxy.";
  }
  if (result.checks.some((check) => !check.ok && check.kind === "allowed")) {
    return "Confirm the proxy is reachable from this deployment context and permits the allowed destinations.";
  }
  if (result.checks.some((check) => !check.ok && check.kind === "denied")) {
    return "Update the proxy ACL so denied destinations are blocked, or pass the expected --denied-url values.";
  }
  return "Review the failed checks above and update proxy configuration or validation destinations.";
}

function formatProxyValidationText(result: ProxyValidationResult): string {
  const lines = [
    result.ok ? theme.success("Proxy validation passed") : theme.error("Proxy validation failed"),
    "",
    theme.heading("Proxy"),
    `  Source: ${theme.muted(result.config.source)}`,
    `  URL:    ${result.config.proxyUrl ?? theme.muted("not configured")}`,
  ];

  if (result.config.errors.length > 0) {
    lines.push("", theme.heading("Problems"));
    for (const error of result.config.errors) {
      lines.push(`  - ${theme.error(error)}`);
    }
  }

  if (result.checks.length > 0) {
    lines.push("", theme.heading("Checks"));
    for (const check of result.checks) {
      lines.push(formatProxyCheckLine(check));
    }
  }

  const nextStep = formatProxyValidationNextStep(result);
  if (nextStep) {
    lines.push("", theme.heading("Next steps"), `  ${theme.warn(nextStep)}`);
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
  await withProxyCaptureOwner(async (store) => {
    const sessions = await store.listSessions(opts.limit ?? 20);
    writeRuntimeJson(defaultRuntime, opts.json ? { sessions } : sessions);
  });
}

export async function runDebugProxyQueryCommand(opts: {
  json?: boolean;
  preset: CaptureQueryPreset;
  sessionId?: string;
}) {
  await withProxyCaptureOwner(async (store) => {
    const rows = await store.queryPreset(opts.preset, opts.sessionId);
    writeRuntimeJson(defaultRuntime, opts.json ? { rows } : rows);
  });
}

export async function runDebugProxyCoverageCommand() {
  const report = buildDebugProxyCoverageReport();
  writeRuntimeJson(defaultRuntime, report);
}

export async function runDebugProxyPurgeCommand() {
  await withProxyCaptureOwner(async (store) => {
    const result = await store.purgeAll();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });
}

export async function readDebugProxyBlobCommand(opts: { blobId: string }) {
  await withProxyCaptureOwner(async (store) => {
    const content = await store.readBlob(opts.blobId);
    if (content == null) {
      throw new Error(`Unknown blob: ${opts.blobId}`);
    }
    process.stdout.write(content);
  });
}
