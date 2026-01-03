import path from "node:path";

import {
  confirm,
  intro,
  multiselect,
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
import {
  isRemoteEnvironment,
  loginAntigravityVpsAware,
} from "./antigravity-oauth.js";
import { healthCommand } from "./health.js";
import {
  applyMinimaxConfig,
  setAnthropicApiKey,
  writeOAuthCredentials,
} from "./onboard-auth.js";
import {
  applyWizardMetadata,
  DEFAULT_WORKSPACE,
  ensureWorkspaceAndSessions,
  guardCancel,
  openUrl,
  printWizardHeader,
  probeGatewayReachable,
  randomToken,
  resolveControlUiLinks,
  summarizeExistingConfig,
} from "./onboard-helpers.js";
import { setupProviders } from "./onboard-providers.js";
import { promptRemoteGatewayConfig } from "./onboard-remote.js";
import { setupSkills } from "./onboard-skills.js";

type WizardSection =
  | "model"
  | "providers"
  | "gateway"
  | "daemon"
  | "workspace"
  | "skills"
  | "health";

type ConfigureWizardParams = {
  command: "configure" | "update";
  sections?: WizardSection[];
};

async function promptGatewayConfig(
  cfg: ClawdisConfig,
  runtime: RuntimeEnv,
): Promise<{
  config: ClawdisConfig;
  port: number;
  token?: string;
}> {
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
  ) as "off" | "token" | "password";

  const tailscaleMode = guardCancel(
    await select({
      message: "Tailscale exposure",
      options: [
        { value: "off", label: "Off", hint: "No Tailscale exposure" },
        {
          value: "serve",
          label: "Serve",
          hint: "Private HTTPS for your tailnet (devices on Tailscale)",
        },
        {
          value: "funnel",
          label: "Funnel",
          hint: "Public HTTPS via Tailscale Funnel (internet)",
        },
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
  let next = cfg;

  if (authMode === "token") {
    const tokenInput = guardCancel(
      await text({
        message: "Gateway token (blank to generate)",
        initialValue: randomToken(),
      }),
      runtime,
    );
    gatewayToken = String(tokenInput).trim() || randomToken();
    next = {
      ...next,
      gateway: {
        ...next.gateway,
        auth: { ...next.gateway?.auth, mode: "token" },
      },
    };
  }

  if (authMode === "password") {
    const password = guardCancel(
      await text({
        message: "Gateway password",
        validate: (value) => (value?.trim() ? undefined : "Required"),
      }),
      runtime,
    );
    next = {
      ...next,
      gateway: {
        ...next.gateway,
        auth: {
          ...next.gateway?.auth,
          mode: "password",
          password: String(password).trim(),
        },
      },
    };
  }

  next = {
    ...next,
    gateway: {
      ...next.gateway,
      mode: "local",
      bind,
      tailscale: {
        ...next.gateway?.tailscale,
        mode: tailscaleMode,
        resetOnExit: tailscaleResetOnExit,
      },
    },
  };

  return { config: next, port, token: gatewayToken };
}

async function promptAuthConfig(
  cfg: ClawdisConfig,
  runtime: RuntimeEnv,
): Promise<ClawdisConfig> {
  const authChoice = guardCancel(
    await select({
      message: "Model/auth choice",
      options: [
        { value: "oauth", label: "Anthropic OAuth (Claude Pro/Max)" },
        {
          value: "antigravity",
          label: "Google Antigravity (Claude Opus 4.5, Gemini 3, etc.)",
        },
        { value: "apiKey", label: "Anthropic API key" },
        { value: "minimax", label: "Minimax M2.1 (LM Studio)" },
        { value: "skip", label: "Skip for now" },
      ],
    }),
    runtime,
  ) as "oauth" | "antigravity" | "apiKey" | "minimax" | "skip";

  let next = cfg;

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
  } else if (authChoice === "antigravity") {
    const isRemote = isRemoteEnvironment();
    note(
      isRemote
        ? [
            "You are running in a remote/VPS environment.",
            "A URL will be shown for you to open in your LOCAL browser.",
            "After signing in, copy the redirect URL and paste it back here.",
          ].join("\n")
        : [
            "Browser will open for Google authentication.",
            "Sign in with your Google account that has Antigravity access.",
            "The callback will be captured automatically on localhost:51121.",
          ].join("\n"),
      "Google Antigravity OAuth",
    );
    const spin = spinner();
    spin.start("Starting OAuth flow…");
    let oauthCreds: OAuthCredentials | null = null;
    try {
      oauthCreds = await loginAntigravityVpsAware(
        async (url) => {
          if (isRemote) {
            spin.stop("OAuth URL ready");
            runtime.log(`\nOpen this URL in your LOCAL browser:\n\n${url}\n`);
          } else {
            spin.message("Complete sign-in in browser…");
            await openUrl(url);
            runtime.log(`Open: ${url}`);
          }
        },
        (msg) => spin.message(msg),
      );
      spin.stop("Antigravity OAuth complete");
      if (oauthCreds) {
        await writeOAuthCredentials("google-antigravity", oauthCreds);
        // Set default model to Claude Opus 4.5 via Antigravity
        next = {
          ...next,
          agent: {
            ...next.agent,
            model: "google-antigravity/claude-opus-4-5-thinking",
          },
        };
        note(
          "Default model set to google-antigravity/claude-opus-4-5-thinking",
          "Model configured",
        );
      }
    } catch (err) {
      spin.stop("Antigravity OAuth failed");
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
    next = applyMinimaxConfig(next);
  }

  const modelInput = guardCancel(
    await text({
      message: "Default model (blank to keep)",
      initialValue: next.agent?.model ?? "",
    }),
    runtime,
  );
  const model = String(modelInput ?? "").trim();
  if (model) {
    next = {
      ...next,
      agent: {
        ...next.agent,
        model,
      },
    };
  }

  return next;
}

async function maybeInstallDaemon(params: {
  runtime: RuntimeEnv;
  port: number;
  gatewayToken?: string;
}) {
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
      params.runtime,
    );
    if (action === "restart") {
      await service.restart({ stdout: process.stdout });
      return;
    }
    if (action === "skip") return;
    if (action === "reinstall") {
      await service.uninstall({ env: process.env, stdout: process.stdout });
    }
  }

  const devMode =
    process.argv[1]?.includes(`${path.sep}src${path.sep}`) &&
    process.argv[1]?.endsWith(".ts");
  const { programArguments, workingDirectory } =
    await resolveGatewayProgramArguments({ port: params.port, dev: devMode });
  const environment: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    CLAWDIS_GATEWAY_TOKEN: params.gatewayToken,
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

export async function runConfigureWizard(
  opts: ConfigureWizardParams,
  runtime: RuntimeEnv = defaultRuntime,
) {
  printWizardHeader(runtime);
  intro(
    opts.command === "update" ? "Clawdis update wizard" : "Clawdis configure",
  );

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
    if (!snapshot.valid) {
      const reset = guardCancel(
        await confirm({
          message: "Config invalid. Start fresh?",
          initialValue: true,
        }),
        runtime,
      );
      if (reset) baseConfig = {};
    }
  }

  const localUrl = "ws://127.0.0.1:18789";
  const localProbe = await probeGatewayReachable({
    url: localUrl,
    token: process.env.CLAWDIS_GATEWAY_TOKEN,
    password:
      baseConfig.gateway?.auth?.password ??
      process.env.CLAWDIS_GATEWAY_PASSWORD,
  });
  const remoteUrl = baseConfig.gateway?.remote?.url?.trim() ?? "";
  const remoteProbe = remoteUrl
    ? await probeGatewayReachable({
        url: remoteUrl,
        token: baseConfig.gateway?.remote?.token,
      })
    : null;

  const mode = guardCancel(
    await select({
      message: "Where will the Gateway run?",
      options: [
        {
          value: "local",
          label: "Local (this machine)",
          hint: localProbe.ok
            ? `Gateway reachable (${localUrl})`
            : `No gateway detected (${localUrl})`,
        },
        {
          value: "remote",
          label: "Remote (info-only)",
          hint: !remoteUrl
            ? "No remote URL configured yet"
            : remoteProbe?.ok
              ? `Gateway reachable (${remoteUrl})`
              : `Configured but unreachable (${remoteUrl})`,
        },
      ],
    }),
    runtime,
  ) as "local" | "remote";

  if (mode === "remote") {
    let remoteConfig = await promptRemoteGatewayConfig(baseConfig, runtime);
    remoteConfig = applyWizardMetadata(remoteConfig, {
      command: opts.command,
      mode,
    });
    await writeConfigFile(remoteConfig);
    runtime.log(`Updated ${CONFIG_PATH_CLAWDIS}`);
    outro("Remote gateway configured.");
    return;
  }

  const selected = opts.sections
    ? opts.sections
    : (guardCancel(
        await multiselect({
          message: "Select sections to configure",
          options: [
            { value: "workspace", label: "Workspace" },
            { value: "model", label: "Model/auth" },
            { value: "gateway", label: "Gateway config" },
            { value: "daemon", label: "Gateway daemon" },
            { value: "providers", label: "Providers" },
            { value: "skills", label: "Skills" },
            { value: "health", label: "Health check" },
          ],
        }),
        runtime,
      ) as WizardSection[]);

  if (!selected || selected.length === 0) {
    outro("No changes selected.");
    return;
  }

  let nextConfig = { ...baseConfig };
  let workspaceDir =
    nextConfig.agent?.workspace ??
    baseConfig.agent?.workspace ??
    DEFAULT_WORKSPACE;
  let gatewayPort = 18789;
  let gatewayToken: string | undefined;

  if (selected.includes("workspace")) {
    const workspaceInput = guardCancel(
      await text({
        message: "Workspace directory",
        initialValue: workspaceDir,
      }),
      runtime,
    );
    workspaceDir = resolveUserPath(
      String(workspaceInput ?? "").trim() || DEFAULT_WORKSPACE,
    );
    nextConfig = {
      ...nextConfig,
      agent: {
        ...nextConfig.agent,
        workspace: workspaceDir,
      },
    };
    await ensureWorkspaceAndSessions(workspaceDir, runtime);
  }

  if (selected.includes("model")) {
    nextConfig = await promptAuthConfig(nextConfig, runtime);
  }

  if (selected.includes("gateway")) {
    const gateway = await promptGatewayConfig(nextConfig, runtime);
    nextConfig = gateway.config;
    gatewayPort = gateway.port;
    gatewayToken = gateway.token;
  }

  if (selected.includes("providers")) {
    nextConfig = await setupProviders(nextConfig, runtime, {
      allowDisable: true,
      allowSignalInstall: true,
    });
  }

  if (selected.includes("skills")) {
    const wsDir = resolveUserPath(workspaceDir);
    nextConfig = await setupSkills(nextConfig, wsDir, runtime);
  }

  nextConfig = applyWizardMetadata(nextConfig, {
    command: opts.command,
    mode,
  });
  await writeConfigFile(nextConfig);
  runtime.log(`Updated ${CONFIG_PATH_CLAWDIS}`);

  if (selected.includes("daemon")) {
    if (!selected.includes("gateway")) {
      const portInput = guardCancel(
        await text({
          message: "Gateway port for daemon install",
          initialValue: String(gatewayPort),
          validate: (value) =>
            Number.isFinite(Number(value)) ? undefined : "Invalid port",
        }),
        runtime,
      );
      gatewayPort = Number.parseInt(String(portInput), 10);
    }

    await maybeInstallDaemon({
      runtime,
      port: gatewayPort,
      gatewayToken,
    });
  }

  if (selected.includes("health")) {
    await sleep(1000);
    try {
      await healthCommand({ json: false, timeoutMs: 10_000 }, runtime);
    } catch (err) {
      runtime.error(`Health check failed: ${String(err)}`);
    }
  }

  note(
    (() => {
      const bind = nextConfig.gateway?.bind ?? "loopback";
      const links = resolveControlUiLinks({ bind, port: gatewayPort });
      return [`Web UI: ${links.httpUrl}`, `Gateway WS: ${links.wsUrl}`].join(
        "\n",
      );
    })(),
    "Control UI",
  );

  const wantsOpen = guardCancel(
    await confirm({
      message: "Open Control UI now?",
      initialValue: false,
    }),
    runtime,
  );
  if (wantsOpen) {
    const bind = nextConfig.gateway?.bind ?? "loopback";
    const links = resolveControlUiLinks({ bind, port: gatewayPort });
    await openUrl(links.httpUrl);
  }

  outro("Configure complete.");
}

export async function configureCommand(runtime: RuntimeEnv = defaultRuntime) {
  await runConfigureWizard({ command: "configure" }, runtime);
}
