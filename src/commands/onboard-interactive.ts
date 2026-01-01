import path from "node:path";

import {
  confirm,
  intro,
  note,
  outro,
  select,
  spinner,
  text,
} from "@clack/prompts";
import { loginAnthropic, type OAuthCredentials } from "@mariozechner/pi-ai";

import type { ClawdisConfig } from "../config/config.js";
import {
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
import {
  applyMinimaxConfig,
  setAnthropicApiKey,
  writeOAuthCredentials,
} from "./onboard-auth.js";
import {
  DEFAULT_WORKSPACE,
  ensureWorkspaceAndSessions,
  guardCancel,
  handleReset,
  openUrl,
  randomToken,
  summarizeExistingConfig,
} from "./onboard-helpers.js";
import { setupProviders } from "./onboard-providers.js";
import { setupSkills } from "./onboard-skills.js";
import type {
  AuthChoice,
  GatewayAuthChoice,
  OnboardMode,
  OnboardOptions,
  ResetScope,
} from "./onboard-types.js";

export async function runInteractiveOnboarding(
  opts: OnboardOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const header = [
    "  _____ _      ___    _    _      ____ ___ ____ ",
    " / ____| |    / _ \\  | |  | |    |  _ \\_ _/ __|",
    "| |    | |   | | | | | |  | |    | | | | |\\__ \\",
    "| |___ | |___| |_| | | |__| |___ | |_| | |___) |",
    " \\_____|_____|\\___/   \\____/_____|____/___/____/ ",
  ].join("\n");
  runtime.log(header);
  intro("Clawdis onboarding");

  const snapshot = await readConfigFileSnapshot();
  let baseConfig: ClawdisConfig = snapshot.valid ? snapshot.config : {};

  if (snapshot.exists) {
    const title = snapshot.valid
      ? "Existing config detected"
      : "Invalid config";
    note(summarizeExistingConfig(baseConfig), title);
    if (!snapshot.valid && snapshot.issues.length > 0) {
      note(
        snapshot.issues
          .map((iss) => `- ${iss.path}: ${iss.message}`)
          .join("\n"),
        "Config issues",
      );
    }

    const action = guardCancel(
      await select({
        message: "Config handling",
        options: [
          { value: "keep", label: "Use existing values" },
          { value: "modify", label: "Update values" },
          { value: "reset", label: "Reset" },
        ],
      }),
      runtime,
    );

    if (action === "reset") {
      const workspaceDefault = baseConfig.agent?.workspace ?? DEFAULT_WORKSPACE;
      const resetScope = guardCancel(
        await select({
          message: "Reset scope",
          options: [
            { value: "config", label: "Config only" },
            {
              value: "config+creds+sessions",
              label: "Config + creds + sessions",
            },
            {
              value: "full",
              label: "Full reset (config + creds + sessions + workspace)",
            },
          ],
        }),
        runtime,
      ) as ResetScope;
      await handleReset(resetScope, resolveUserPath(workspaceDefault), runtime);
      baseConfig = {};
    } else if (action === "keep" && !snapshot.valid) {
      baseConfig = {};
    }
  }

  const mode =
    opts.mode ??
    (guardCancel(
      await select({
        message: "Where will the Gateway run?",
        options: [
          { value: "local", label: "Local (this machine)" },
          { value: "remote", label: "Remote (info-only)" },
        ],
      }),
      runtime,
    ) as OnboardMode);

  if (mode === "remote") {
    note(
      [
        "Run on the gateway host:",
        "- clawdis setup",
        "- clawdis gateway-daemon --port 18789",
        "- OAuth creds: ~/.clawdis/credentials/oauth.json",
        "- Workspace: ~/clawd",
      ].join("\n"),
      "Remote setup",
    );
    outro("Done. Local config unchanged.");
    return;
  }

  const workspaceInput =
    opts.workspace ??
    (guardCancel(
      await text({
        message: "Workspace directory",
        initialValue: baseConfig.agent?.workspace ?? DEFAULT_WORKSPACE,
      }),
      runtime,
    ) as string);

  const workspaceDir = resolveUserPath(
    workspaceInput.trim() || DEFAULT_WORKSPACE,
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

  const authChoice = guardCancel(
    await select({
      message: "Model/auth choice",
      options: [
        { value: "oauth", label: "Anthropic OAuth (Claude Pro/Max)" },
        { value: "apiKey", label: "Anthropic API key" },
        { value: "minimax", label: "Minimax M2.1 (LM Studio)" },
        { value: "skip", label: "Skip for now" },
      ],
    }),
    runtime,
  ) as AuthChoice;

  if (authChoice === "oauth") {
    note(
      "Browser will open. Paste the code shown after login (code#state).",
      "Anthropic OAuth",
    );
    const spin = spinner();
    spin.start("Waiting for authorization…");
    let oauthCreds: OAuthCredentials | null = null;
    try {
      oauthCreds = await loginAnthropic(
        async (url) => {
          await openUrl(url);
          runtime.log(`Open: ${url}`);
        },
        async () => {
          const code = guardCancel(
            await text({
              message: "Paste authorization code (code#state)",
              validate: (value) => (value?.trim() ? undefined : "Required"),
            }),
            runtime,
          );
          return String(code);
        },
      );
      spin.stop("OAuth complete");
      if (oauthCreds) {
        await writeOAuthCredentials("anthropic", oauthCreds);
      }
    } catch (err) {
      spin.stop("OAuth failed");
      runtime.error(String(err));
    }
  } else if (authChoice === "apiKey") {
    const key = guardCancel(
      await text({
        message: "Enter Anthropic API key",
        validate: (value) => (value?.trim() ? undefined : "Required"),
      }),
      runtime,
    );
    await setAnthropicApiKey(String(key).trim());
  } else if (authChoice === "minimax") {
    nextConfig = applyMinimaxConfig(nextConfig);
  }

  const portRaw = guardCancel(
    await text({
      message: "Gateway port",
      initialValue: "18789",
      validate: (value) =>
        Number.isFinite(Number(value)) ? undefined : "Invalid port",
    }),
    runtime,
  );
  const port = Number.parseInt(String(portRaw), 10);

  let bind = guardCancel(
    await select({
      message: "Gateway bind",
      options: [
        { value: "loopback", label: "Loopback (127.0.0.1)" },
        { value: "lan", label: "LAN" },
        { value: "tailnet", label: "Tailnet" },
        { value: "auto", label: "Auto" },
      ],
    }),
    runtime,
  ) as "loopback" | "lan" | "tailnet" | "auto";

  let authMode = guardCancel(
    await select({
      message: "Gateway auth",
      options: [
        { value: "off", label: "Off (loopback only)" },
        { value: "token", label: "Token" },
        { value: "password", label: "Password" },
      ],
    }),
    runtime,
  ) as GatewayAuthChoice;

  const tailscaleMode = guardCancel(
    await select({
      message: "Tailscale exposure",
      options: [
        { value: "off", label: "Off" },
        { value: "serve", label: "Serve" },
        { value: "funnel", label: "Funnel" },
      ],
    }),
    runtime,
  ) as "off" | "serve" | "funnel";

  let tailscaleResetOnExit = false;
  if (tailscaleMode !== "off") {
    tailscaleResetOnExit = Boolean(
      guardCancel(
        await confirm({
          message: "Reset Tailscale serve/funnel on exit?",
          initialValue: false,
        }),
        runtime,
      ),
    );
  }

  if (tailscaleMode !== "off" && bind !== "loopback") {
    note(
      "Tailscale requires bind=loopback. Adjusting bind to loopback.",
      "Note",
    );
    bind = "loopback";
  }

  if (authMode === "off" && bind !== "loopback") {
    note("Non-loopback bind requires auth. Switching to token auth.", "Note");
    authMode = "token";
  }

  if (tailscaleMode === "funnel" && authMode !== "password") {
    note("Tailscale funnel requires password auth.", "Note");
    authMode = "password";
  }

  let gatewayToken: string | undefined;
  if (authMode === "token") {
    const tokenInput = guardCancel(
      await text({
        message: "Gateway token (blank to generate)",
        initialValue: randomToken(),
      }),
      runtime,
    );
    gatewayToken = String(tokenInput).trim() || randomToken();
  }

  if (authMode === "password") {
    const password = guardCancel(
      await text({
        message: "Gateway password",
        validate: (value) => (value?.trim() ? undefined : "Required"),
      }),
      runtime,
    );
    nextConfig = {
      ...nextConfig,
      gateway: {
        ...nextConfig.gateway,
        auth: {
          ...nextConfig.gateway?.auth,
          mode: "password",
          password: String(password).trim(),
        },
      },
    };
  } else if (authMode === "token") {
    nextConfig = {
      ...nextConfig,
      gateway: {
        ...nextConfig.gateway,
        auth: { ...nextConfig.gateway?.auth, mode: "token" },
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

  nextConfig = await setupProviders(nextConfig, runtime);

  await writeConfigFile(nextConfig);
  runtime.log(`Updated ${CONFIG_PATH_CLAWDIS}`);
  await ensureWorkspaceAndSessions(workspaceDir, runtime);

  nextConfig = await setupSkills(nextConfig, workspaceDir, runtime);
  await writeConfigFile(nextConfig);

  const installDaemon = guardCancel(
    await confirm({
      message: "Install Gateway daemon (recommended)",
      initialValue: true,
    }),
    runtime,
  );

  if (installDaemon) {
    const service = resolveGatewayService();
    const loaded = await service.isLoaded({ env: process.env });
    if (loaded) {
      const action = guardCancel(
        await select({
          message: "Gateway service already installed",
          options: [
            { value: "restart", label: "Restart" },
            { value: "reinstall", label: "Reinstall" },
            { value: "skip", label: "Skip" },
          ],
        }),
        runtime,
      );
      if (action === "restart") {
        await service.restart({ stdout: process.stdout });
      } else if (action === "reinstall") {
        await service.uninstall({ env: process.env, stdout: process.stdout });
      }
    }

    if (
      !loaded ||
      (loaded && (await service.isLoaded({ env: process.env })) === false)
    ) {
      const devMode =
        process.argv[1]?.includes(`${path.sep}src${path.sep}`) &&
        process.argv[1]?.endsWith(".ts");
      const { programArguments, workingDirectory } =
        await resolveGatewayProgramArguments({ port, dev: devMode });
      const environment: Record<string, string | undefined> = {
        PATH: process.env.PATH,
        CLAWDIS_GATEWAY_TOKEN: gatewayToken,
        CLAWDIS_LAUNCHD_LABEL:
          process.platform === "darwin"
            ? GATEWAY_LAUNCH_AGENT_LABEL
            : undefined,
      };
      await service.install({
        env: process.env,
        stdout: process.stdout,
        programArguments,
        workingDirectory,
        environment,
      });
    }
  }

  await sleep(1500);
  try {
    await healthCommand({ json: false, timeoutMs: 10_000 }, runtime);
  } catch (err) {
    runtime.error(`Health check failed: ${String(err)}`);
  }

  note(
    [
      "Add nodes for extra features:",
      "- macOS app (system + notifications)",
      "- iOS app (camera/canvas)",
      "- Android app (camera/canvas)",
    ].join("\n"),
    "Optional apps",
  );

  outro("Onboarding complete.");
}
