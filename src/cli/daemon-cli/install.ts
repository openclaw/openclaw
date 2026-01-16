import path from "node:path";
import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  isGatewayDaemonRuntime,
} from "../../commands/daemon-runtime.js";
import { loadConfig, resolveGatewayPort } from "../../config/config.js";
import { resolveIsNixMode } from "../../config/paths.js";
import { resolveGatewayLaunchAgentLabel } from "../../daemon/constants.js";
import { resolveGatewayProgramArguments } from "../../daemon/program-args.js";
import {
  renderSystemNodeWarning,
  resolvePreferredNodePath,
  resolveSystemNodeInfo,
} from "../../daemon/runtime-paths.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { buildServiceEnvironment } from "../../daemon/service-env.js";
import { defaultRuntime } from "../../runtime.js";
import { buildDaemonServiceSnapshot, createNullWriter, emitDaemonActionJson } from "./response.js";
import { parsePort } from "./shared.js";
import type { DaemonInstallOptions } from "./types.js";

export async function runDaemonInstall(opts: DaemonInstallOptions) {
  const json = Boolean(opts.json);
  const warnings: string[] = [];
  const stdout = json ? createNullWriter() : process.stdout;
  const emit = (payload: {
    ok: boolean;
    result?: string;
    message?: string;
    error?: string;
    service?: {
      label: string;
      loaded: boolean;
      loadedText: string;
      notLoadedText: string;
    };
    hints?: string[];
    warnings?: string[];
  }) => {
    if (!json) return;
    emitDaemonActionJson({ action: "install", ...payload });
  };
  const fail = (message: string) => {
    if (json) {
      emit({ ok: false, error: message, warnings: warnings.length ? warnings : undefined });
    } else {
      defaultRuntime.error(message);
    }
    defaultRuntime.exit(1);
  };

  if (resolveIsNixMode(process.env)) {
    fail("Nix mode detected; daemon install is disabled.");
    return;
  }

  const cfg = loadConfig();
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
    fail(`Gateway service check failed: ${String(err)}`);
    return;
  }
  if (loaded) {
    if (!opts.force) {
      emit({
        ok: true,
        result: "already-installed",
        message: `Gateway service already ${service.loadedText}.`,
        service: buildDaemonServiceSnapshot(service, loaded),
        warnings: warnings.length ? warnings : undefined,
      });
      if (!json) {
        defaultRuntime.log(`Gateway service already ${service.loadedText}.`);
        defaultRuntime.log("Reinstall with: clawdbot daemon install --force");
      }
      return;
    }
  }

  const devMode =
    process.argv[1]?.includes(`${path.sep}src${path.sep}`) && process.argv[1]?.endsWith(".ts");
  const nodePath = await resolvePreferredNodePath({
    env: process.env,
    runtime: runtimeRaw,
  });
  const { programArguments, workingDirectory } = await resolveGatewayProgramArguments({
    port,
    dev: devMode,
    runtime: runtimeRaw,
    nodePath,
  });
  if (runtimeRaw === "node") {
    const systemNode = await resolveSystemNodeInfo({ env: process.env });
    const warning = renderSystemNodeWarning(systemNode, programArguments[0]);
    if (warning) {
      if (json) warnings.push(warning);
      else defaultRuntime.log(warning);
    }
  }
  const environment = buildServiceEnvironment({
    env: process.env,
    port,
    token: opts.token || cfg.gateway?.auth?.token || process.env.CLAWDBOT_GATEWAY_TOKEN,
    launchdLabel:
      process.platform === "darwin"
        ? resolveGatewayLaunchAgentLabel(process.env.CLAWDBOT_PROFILE)
        : undefined,
  });

  try {
    await service.install({
      env: process.env,
      stdout,
      programArguments,
      workingDirectory,
      environment,
    });
  } catch (err) {
    fail(`Gateway install failed: ${String(err)}`);
    return;
  }

  let installed = true;
  try {
    installed = await service.isLoaded({ env: process.env });
  } catch {
    installed = true;
  }
  emit({
    ok: true,
    result: "installed",
    service: buildDaemonServiceSnapshot(service, installed),
    warnings: warnings.length ? warnings : undefined,
  });
}
