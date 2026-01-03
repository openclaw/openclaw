import path from "node:path";

import {
  type ClawdisConfig,
  CONFIG_PATH_CLAWDIS,
  readConfigFileSnapshot,
  writeConfigFile,
} from "../config/config.js";
import { GATEWAY_LAUNCH_AGENT_LABEL } from "../daemon/constants.js";
import { resolveGatewayProgramArguments } from "../daemon/program-args.js";
import { resolveGatewayService } from "../daemon/service.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { resolveUserPath, sleep } from "../utils.js";
import { healthCommand } from "./health.js";
import { applyMinimaxConfig, setAnthropicApiKey } from "./onboard-auth.js";
import {
  applyWizardMetadata,
  DEFAULT_WORKSPACE,
  ensureWorkspaceAndSessions,
  randomToken,
} from "./onboard-helpers.js";
import type {
  AuthChoice,
  OnboardMode,
  OnboardOptions,
} from "./onboard-types.js";

export async function runNonInteractiveOnboarding(
  opts: OnboardOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const snapshot = await readConfigFileSnapshot();
  const baseConfig: ClawdisConfig = snapshot.valid ? snapshot.config : {};
  const mode: OnboardMode = opts.mode ?? "local";

  if (mode === "remote") {
    const remoteUrl = opts.remoteUrl?.trim();
    if (!remoteUrl) {
      runtime.error("Missing --remote-url for remote mode.");
      runtime.exit(1);
      return;
    }

    let nextConfig: ClawdisConfig = {
      ...baseConfig,
      gateway: {
        ...baseConfig.gateway,
        mode: "remote",
        remote: {
          url: remoteUrl,
          token: opts.remoteToken?.trim() || undefined,
        },
      },
    };
    nextConfig = applyWizardMetadata(nextConfig, { command: "onboard", mode });
    await writeConfigFile(nextConfig);
    runtime.log(`Updated ${CONFIG_PATH_CLAWDIS}`);

    const payload = {
      mode,
      remoteUrl,
      auth: opts.remoteToken ? "token" : "none",
    };
    if (opts.json) {
      runtime.log(JSON.stringify(payload, null, 2));
    } else {
      runtime.log(`Remote gateway: ${remoteUrl}`);
      runtime.log(`Auth: ${payload.auth}`);
    }
    return;
  }

  const workspaceDir = resolveUserPath(
    (opts.workspace ?? baseConfig.agent?.workspace ?? DEFAULT_WORKSPACE).trim(),
  );

  let nextConfig: ClawdisConfig = {
    ...baseConfig,
    agent: {
      ...baseConfig.agent,
      workspace: workspaceDir,
    },
    gateway: {
      ...baseConfig.gateway,
      mode: "local",
    },
  };

  const authChoice: AuthChoice = opts.authChoice ?? "skip";
  if (authChoice === "apiKey") {
    const key = opts.anthropicApiKey?.trim();
    if (!key) {
      runtime.error("Missing --anthropic-api-key");
      runtime.exit(1);
      return;
    }
    await setAnthropicApiKey(key);
  } else if (authChoice === "minimax") {
    nextConfig = applyMinimaxConfig(nextConfig);
  } else if (authChoice === "oauth" || authChoice === "antigravity") {
    runtime.error(
      `${authChoice === "oauth" ? "OAuth" : "Antigravity"} requires interactive mode.`,
    );
    runtime.exit(1);
    return;
  }

  const port = opts.gatewayPort ?? 18789;
  if (!Number.isFinite(port) || port <= 0) {
    runtime.error("Invalid --gateway-port");
    runtime.exit(1);
    return;
  }
  let bind = opts.gatewayBind ?? "loopback";
  let authMode = opts.gatewayAuth ?? "off";
  const tailscaleMode = opts.tailscale ?? "off";
  const tailscaleResetOnExit = Boolean(opts.tailscaleResetOnExit);

  if (tailscaleMode !== "off" && bind !== "loopback") {
    bind = "loopback";
  }
  if (authMode === "off" && bind !== "loopback") {
    authMode = "token";
  }
  if (tailscaleMode === "funnel" && authMode !== "password") {
    authMode = "password";
  }

  let gatewayToken = opts.gatewayToken?.trim() || undefined;
  if (authMode === "token") {
    if (!gatewayToken) gatewayToken = randomToken();
    nextConfig = {
      ...nextConfig,
      gateway: {
        ...nextConfig.gateway,
        auth: { ...nextConfig.gateway?.auth, mode: "token" },
      },
    };
  }
  if (authMode === "password") {
    const password = opts.gatewayPassword?.trim();
    if (!password) {
      runtime.error("Missing --gateway-password for password auth.");
      runtime.exit(1);
      return;
    }
    nextConfig = {
      ...nextConfig,
      gateway: {
        ...nextConfig.gateway,
        auth: {
          ...nextConfig.gateway?.auth,
          mode: "password",
          password,
        },
      },
    };
  }

  nextConfig = {
    ...nextConfig,
    gateway: {
      ...nextConfig.gateway,
      bind,
      tailscale: {
        ...nextConfig.gateway?.tailscale,
        mode: tailscaleMode,
        resetOnExit: tailscaleResetOnExit,
      },
    },
  };

  if (!opts.skipSkills) {
    const nodeManager = opts.nodeManager ?? "npm";
    if (!["npm", "pnpm", "bun"].includes(nodeManager)) {
      runtime.error("Invalid --node-manager (use npm, pnpm, or bun)");
      runtime.exit(1);
      return;
    }
    nextConfig = {
      ...nextConfig,
      skills: {
        ...nextConfig.skills,
        install: {
          ...nextConfig.skills?.install,
          nodeManager,
        },
      },
    };
  }

  nextConfig = applyWizardMetadata(nextConfig, { command: "onboard", mode });
  await writeConfigFile(nextConfig);
  runtime.log(`Updated ${CONFIG_PATH_CLAWDIS}`);
  await ensureWorkspaceAndSessions(workspaceDir, runtime);

  if (opts.installDaemon) {
    const service = resolveGatewayService();
    const devMode =
      process.argv[1]?.includes(`${path.sep}src${path.sep}`) &&
      process.argv[1]?.endsWith(".ts");
    const { programArguments, workingDirectory } =
      await resolveGatewayProgramArguments({ port, dev: devMode });
    const environment: Record<string, string | undefined> = {
      PATH: process.env.PATH,
      CLAWDIS_GATEWAY_TOKEN: gatewayToken,
      CLAWDIS_LAUNCHD_LABEL:
        process.platform === "darwin" ? GATEWAY_LAUNCH_AGENT_LABEL : undefined,
    };
    await service.install({
      env: process.env,
      stdout: process.stdout,
      programArguments,
      workingDirectory,
      environment,
    });
  }

  if (!opts.skipHealth) {
    await sleep(1000);
    await healthCommand({ json: false, timeoutMs: 10_000 }, runtime);
  }

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          mode,
          workspace: workspaceDir,
          authChoice,
          gateway: { port, bind, authMode, tailscaleMode },
          installDaemon: Boolean(opts.installDaemon),
          skipSkills: Boolean(opts.skipSkills),
          skipHealth: Boolean(opts.skipHealth),
        },
        null,
        2,
      ),
    );
  }
}
