import type { DaemonInstallOptions } from "./types.js";
import { buildGatewayInstallPlan } from "../../commands/daemon-install-helpers.js";
import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  isGatewayDaemonRuntime,
} from "../../commands/daemon-runtime.js";
import { randomToken } from "../../commands/onboard-helpers.js";
import {
  loadConfig,
  readConfigFileSnapshot,
  resolveGatewayPort,
  writeConfigFile,
} from "../../config/config.js";
import { resolveIsNixMode } from "../../config/paths.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { resolveGatewayAuth } from "../../gateway/auth.js";
import { defaultRuntime } from "../../runtime.js";
import { formatCliCommand } from "../command-format.js";
import { buildDaemonServiceSnapshot, createDaemonActionContext } from "./response.js";
import { parsePort } from "./shared.js";

export async function runDaemonInstall(opts: DaemonInstallOptions) {
  const json = Boolean(opts.json);
  const { stdout, warnings, emit, fail } = createDaemonActionContext({ action: "install", json });

  if (resolveIsNixMode(process.env)) {
    fail("Nix mode detected; service install is disabled.");
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

  // Resolve effective auth mode to determine if token auto-generation is needed.
  // Password-mode and Tailscale-only installs do not need a token.
  const resolvedAuth = resolveGatewayAuth({
    authConfig: cfg.gateway?.auth,
    tailscaleMode: cfg.gateway?.tailscale?.mode ?? "off",
  });
  const needsToken =
    resolvedAuth.mode === "token" && !resolvedAuth.token && !resolvedAuth.allowTailscale;

  let token: string | undefined =
    opts.token ||
    cfg.gateway?.auth?.token ||
    process.env.OPENCLAW_GATEWAY_TOKEN ||
    process.env.CLAWDBOT_GATEWAY_TOKEN;

  if (!token && needsToken) {
    token = randomToken();
    const warnMsg = "No gateway token found. Auto-generated one and saving to config.";
    if (json) {
      warnings.push(warnMsg);
    } else {
      defaultRuntime.log(warnMsg);
    }

    // Persist to config file so the gateway reads it at runtime
    // (launchd does not inherit shell env vars, and CLI tools also
    // read gateway.auth.token from config for gateway calls).
    try {
      const snapshot = await readConfigFileSnapshot();
      if (snapshot.exists && !snapshot.valid) {
        // Config file exists but is corrupt/unparseable — don't risk overwriting.
        // Token is still embedded in the plist EnvironmentVariables.
        const msg = "Warning: config file exists but is invalid; skipping token persistence.";
        if (json) {
          warnings.push(msg);
        } else {
          defaultRuntime.log(msg);
        }
      } else {
        const baseConfig = snapshot.exists ? snapshot.config : {};
        if (!baseConfig.gateway?.auth?.token) {
          await writeConfigFile({
            ...baseConfig,
            gateway: {
              ...baseConfig.gateway,
              auth: {
                ...baseConfig.gateway?.auth,
                mode: baseConfig.gateway?.auth?.mode ?? "token",
                token,
              },
            },
          });
        } else {
          // Another process wrote a token between loadConfig() and now.
          token = baseConfig.gateway.auth.token;
        }
      }
    } catch (err) {
      // Non-fatal: token is still embedded in the plist EnvironmentVariables.
      const msg = `Warning: could not persist token to config: ${String(err)}`;
      if (json) {
        warnings.push(msg);
      } else {
        defaultRuntime.log(msg);
      }
    }
  }

  const { programArguments, workingDirectory, environment } = await buildGatewayInstallPlan({
    env: process.env,
    port,
    token,
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
