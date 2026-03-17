import fs from "node:fs";
import path from "node:path";
import { buildGatewayInstallPlan } from "../../commands/daemon-install-helpers.js";
import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  isGatewayDaemonRuntime,
} from "../../commands/daemon-runtime.js";
import { resolveGatewayInstallToken } from "../../commands/gateway-install-token.js";
import { readBestEffortConfig, resolveGatewayPort } from "../../config/config.js";
import { resolveGatewayStateDir } from "../../daemon/paths.js";
import { isNvmNode } from "../../daemon/service-env.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { isNonFatalSystemdInstallProbeError } from "../../daemon/systemd.js";
import { defaultRuntime } from "../../runtime.js";
import { formatCliCommand } from "../command-format.js";
import { buildDaemonServiceSnapshot, installDaemonServiceAndEmit } from "./response.js";
import {
  createDaemonInstallActionContext,
  failIfNixDaemonInstallMode,
  parsePort,
} from "./shared.js";
import type { DaemonInstallOptions } from "./types.js";

export async function runDaemonInstall(opts: DaemonInstallOptions) {
  const { json, stdout, warnings, emit, fail } = createDaemonInstallActionContext(opts.json);
  if (failIfNixDaemonInstallMode(fail)) {
    return;
  }

  const cfg = await readBestEffortConfig();
  const portOverride = parsePort(opts.port);
  if (opts.port !== undefined && portOverride === null) {
    fail("Invalid port");
    return;
  }
  const port = portOverride ?? resolveGatewayPort(cfg);
  if (!Number.isFinite(port) || port <= 0) {
    fail("Invalid port");
    return;
  }
  const runtimeRaw = opts.runtime ? String(opts.runtime) : DEFAULT_GATEWAY_DAEMON_RUNTIME;
  if (!isGatewayDaemonRuntime(runtimeRaw)) {
    fail('Invalid --runtime (use "node" or "bun")');
    return;
  }

  const service = resolveGatewayService();
  let loaded = false;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch (err) {
    if (isNonFatalSystemdInstallProbeError(err)) {
      loaded = false;
    } else {
      fail(`Gateway service check failed: ${String(err)}`);
      return;
    }
  }
  if (loaded) {
    if (!opts.force) {
      emit({
        ok: true,
        result: "already-installed",
        message: `Gateway service already ${service.loadedText}.`,
        service: buildDaemonServiceSnapshot(service, loaded),
      });
      if (!json) {
        defaultRuntime.log(`Gateway service already ${service.loadedText}.`);
        defaultRuntime.log(
          `Reinstall with: ${formatCliCommand("openclaw gateway install --force")}`,
        );
      }
      return;
    }
  }

  const tokenResolution = await resolveGatewayInstallToken({
    config: cfg,
    env: process.env,
    explicitToken: opts.token,
    autoGenerateWhenMissing: true,
    persistGeneratedToken: true,
  });
  if (tokenResolution.unavailableReason) {
    fail(`Gateway install blocked: ${tokenResolution.unavailableReason}`);
    return;
  }
  for (const warning of tokenResolution.warnings) {
    if (json) {
      warnings.push(warning);
    } else {
      defaultRuntime.log(warning);
    }
  }

  const { programArguments, workingDirectory, environment } = await buildGatewayInstallPlan({
    env: process.env,
    port,
    runtime: runtimeRaw,
    warn: (message) => {
      if (json) {
        warnings.push(message);
      } else {
        defaultRuntime.log(message);
      }
    },
    config: cfg,
  });

  await installDaemonServiceAndEmit({
    serviceNoun: "Gateway",
    service,
    warnings,
    emit,
    fail,
    install: async () => {
      await service.install({
        env: process.env,
        stdout,
        programArguments,
        workingDirectory,
        environment,
      });
    },
  });

  // On Linux with nvm-installed Node, ensure NODE_EXTRA_CA_CERTS is in ~/.openclaw/.env
  // so manual `openclaw gateway run` also picks up the system CA bundle via dotenv.
  ensureNvmCaCertsInDotEnv({ env: process.env, json, warnings });
}

/**
 * When Node.js is installed via nvm on Linux, write NODE_EXTRA_CA_CERTS to
 * the global .env file so non-service runs (e.g. `openclaw gateway run`)
 * also get the system CA bundle. The service environment already handles this
 * via buildServiceEnvironment, but dotenv covers the manual-start path.
 */
function ensureNvmCaCertsInDotEnv(params: {
  env: Record<string, string | undefined>;
  json: boolean;
  warnings: string[];
}): void {
  if (process.platform !== "linux" || !isNvmNode(params.env, process.execPath)) {
    return;
  }
  if (params.env.NODE_EXTRA_CA_CERTS) {
    return;
  }

  try {
    const stateDir = resolveGatewayStateDir(params.env);
    const envFile = path.join(stateDir, ".env");
    const existing = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
    if (existing.includes("NODE_EXTRA_CA_CERTS")) {
      return;
    }
    const line = "NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt\n";
    const content = existing.endsWith("\n") || !existing ? existing + line : `${existing}\n${line}`;
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(envFile, content, "utf8");

    const message =
      "nvm detected: wrote NODE_EXTRA_CA_CERTS to ~/.openclaw/.env for TLS compatibility";
    if (params.json) {
      params.warnings.push(message);
    } else {
      defaultRuntime.log(message);
    }
  } catch {
    // Best-effort; the service environment already has the var via buildServiceEnvironment.
  }
}
