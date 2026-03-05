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
import { resolveSecretInputRef } from "../../config/types.secrets.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { resolveGatewayAuth } from "../../gateway/auth.js";
import { defaultRuntime } from "../../runtime.js";
import { secretRefKey } from "../../secrets/ref-contract.js";
import { resolveSecretRefValues } from "../../secrets/resolve.js";
import { formatCliCommand } from "../command-format.js";
import {
  buildDaemonServiceSnapshot,
  createDaemonActionContext,
  installDaemonServiceAndEmit,
} from "./response.js";
import { parsePort } from "./shared.js";
import type { DaemonInstallOptions } from "./types.js";

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
  const tokenRef = resolveSecretInputRef({
    value: cfg.gateway?.auth?.token,
    defaults: cfg.secrets?.defaults,
  }).ref;
  const configToken =
    tokenRef || typeof cfg.gateway?.auth?.token !== "string"
      ? undefined
      : cfg.gateway.auth.token.trim() || undefined;

  const resolveConfiguredTokenRef = async (): Promise<string | undefined> => {
    if (!tokenRef) {
      return undefined;
    }
    const resolved = await resolveSecretRefValues([tokenRef], {
      config: cfg,
      env: process.env,
    });
    const value = resolved.get(secretRefKey(tokenRef));
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error("gateway.auth.token resolved to an empty or non-string value.");
    }
    return value.trim();
  };

  let token: string | undefined =
    opts.token?.trim() ||
    configToken ||
    (tokenRef
      ? undefined
      : process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || process.env.CLAWDBOT_GATEWAY_TOKEN?.trim());

  if (tokenRef && !token) {
    try {
      await resolveConfiguredTokenRef();
      const warning =
        "gateway.auth.token is SecretRef-managed; install will not persist a resolved token in service environment. Ensure the SecretRef is resolvable in the daemon runtime context.";
      if (json) {
        warnings.push(warning);
      } else {
        defaultRuntime.log(warning);
      }
    } catch (err) {
      if (needsToken) {
        fail(
          `Gateway install blocked: gateway.auth.token SecretRef is configured but unresolved (${String(
            err,
          )}). Resolve the SecretRef or provide --token.`,
        );
        return;
      }
      const warning = `Warning: gateway.auth.token SecretRef could not be resolved for install (${String(err)}).`;
      if (json) {
        warnings.push(warning);
      } else {
        defaultRuntime.log(warning);
      }
    }
  }

  if (!token && needsToken && !tokenRef) {
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
        const existingTokenRef = resolveSecretInputRef({
          value: baseConfig.gateway?.auth?.token,
          defaults: baseConfig.secrets?.defaults,
        }).ref;
        const baseConfigToken =
          typeof baseConfig.gateway?.auth?.token === "string"
            ? baseConfig.gateway.auth.token.trim()
            : undefined;
        if (!existingTokenRef && !baseConfigToken) {
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
        } else if (baseConfigToken) {
          // Another process wrote a token between loadConfig() and now.
          token = baseConfigToken;
        } else {
          // Preserve configured SecretRef and avoid writing plaintext over it.
          const msg =
            "Warning: gateway.auth.token is SecretRef-managed; skipping plaintext token persistence.";
          if (json) {
            warnings.push(msg);
          } else {
            defaultRuntime.log(msg);
          }
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
}
