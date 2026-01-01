import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  cancel,
  confirm,
  intro,
  isCancel,
  multiselect,
  note,
  outro,
  select,
  spinner,
  text,
} from "@clack/prompts";
import { loginAnthropic, type OAuthCredentials } from "@mariozechner/pi-ai";
import { discoverAuthStorage } from "@mariozechner/pi-coding-agent";
import { resolveClawdisAgentDir } from "../agents/agent-paths.js";
import { installSkill } from "../agents/skills-install.js";
import { buildWorkspaceSkillStatus } from "../agents/skills-status.js";
import {
  DEFAULT_AGENT_WORKSPACE_DIR,
  ensureAgentWorkspace,
} from "../agents/workspace.js";
import type { ClawdisConfig } from "../config/config.js";
import {
  CONFIG_PATH_CLAWDIS,
  readConfigFileSnapshot,
  writeConfigFile,
} from "../config/config.js";
import { resolveSessionTranscriptsDir } from "../config/sessions.js";
import { GATEWAY_LAUNCH_AGENT_LABEL } from "../daemon/constants.js";
import { resolveGatewayProgramArguments } from "../daemon/program-args.js";
import { resolveGatewayService } from "../daemon/service.js";
import { assertSupportedRuntime } from "../infra/runtime-guard.js";
import { runCommandWithTimeout } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { CONFIG_DIR, resolveUserPath, sleep } from "../utils.js";
import { healthCommand } from "./health.js";

type OnboardMode = "local" | "remote";
type AuthChoice = "oauth" | "apiKey" | "minimax" | "skip";
type GatewayAuthChoice = "off" | "token" | "password";
type ResetScope = "config" | "config+creds+sessions" | "full";

type OnboardOptions = {
  mode?: OnboardMode;
  workspace?: string;
  nonInteractive?: boolean;
  authChoice?: AuthChoice;
  anthropicApiKey?: string;
  gatewayPort?: number;
  gatewayBind?: "loopback" | "lan" | "tailnet" | "auto";
  gatewayAuth?: GatewayAuthChoice;
  gatewayToken?: string;
  gatewayPassword?: string;
  tailscale?: "off" | "serve" | "funnel";
  tailscaleResetOnExit?: boolean;
  installDaemon?: boolean;
  skipSkills?: boolean;
  skipHealth?: boolean;
  nodeManager?: "npm" | "pnpm" | "bun";
  json?: boolean;
};

function guardCancel<T>(value: T, runtime: RuntimeEnv): T {
  if (isCancel(value)) {
    cancel("Setup cancelled.");
    runtime.exit(0);
  }
  return value;
}

function summarizeExistingConfig(config: ClawdisConfig): string {
  const rows: string[] = [];
  if (config.agent?.workspace)
    rows.push(`workspace: ${config.agent.workspace}`);
  if (config.agent?.model) rows.push(`model: ${config.agent.model}`);
  if (config.gateway?.mode) rows.push(`gateway.mode: ${config.gateway.mode}`);
  if (config.gateway?.bind) rows.push(`gateway.bind: ${config.gateway.bind}`);
  if (config.skills?.install?.nodeManager) {
    rows.push(`skills.nodeManager: ${config.skills.install.nodeManager}`);
  }
  return rows.length ? rows.join("\n") : "No key settings detected.";
}

function randomToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

async function openUrl(url: string): Promise<void> {
  const platform = process.platform;
  const command =
    platform === "darwin"
      ? ["open", url]
      : platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    await runCommandWithTimeout(command, { timeoutMs: 5_000 });
  } catch {
    // ignore; we still print the URL for manual open
  }
}

async function ensureWorkspaceAndSessions(
  workspaceDir: string,
  runtime: RuntimeEnv,
) {
  const ws = await ensureAgentWorkspace({
    dir: workspaceDir,
    ensureBootstrapFiles: true,
  });
  runtime.log(`Workspace OK: ${ws.dir}`);
  const sessionsDir = resolveSessionTranscriptsDir();
  await fs.mkdir(sessionsDir, { recursive: true });
  runtime.log(`Sessions OK: ${sessionsDir}`);
}

async function writeOAuthCredentials(
  provider: "anthropic",
  creds: OAuthCredentials,
): Promise<void> {
  const dir = path.join(CONFIG_DIR, "credentials");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const filePath = path.join(dir, "oauth.json");
  let storage: Record<string, OAuthCredentials> = {};
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, OAuthCredentials>;
    if (parsed && typeof parsed === "object") storage = parsed;
  } catch {
    // ignore
  }
  storage[provider] = creds;
  await fs.writeFile(filePath, `${JSON.stringify(storage, null, 2)}\n`, "utf8");
  await fs.chmod(filePath, 0o600);
}

async function setAnthropicApiKey(key: string) {
  const agentDir = resolveClawdisAgentDir();
  const authStorage = discoverAuthStorage(agentDir);
  authStorage.set("anthropic", { type: "api_key", key });
}

function applyMinimaxConfig(cfg: ClawdisConfig): ClawdisConfig {
  const allowed = new Set(cfg.agent?.allowedModels ?? []);
  allowed.add("anthropic/claude-opus-4-5");
  allowed.add("lmstudio/minimax-m2.1-gs32");

  const aliases = { ...(cfg.agent?.modelAliases ?? {}) };
  if (!aliases.Opus) aliases.Opus = "anthropic/claude-opus-4-5";
  if (!aliases.Minimax) aliases.Minimax = "lmstudio/minimax-m2.1-gs32";

  const providers = { ...(cfg.models?.providers ?? {}) };
  if (!providers.lmstudio) {
    providers.lmstudio = {
      baseUrl: "http://127.0.0.1:1234/v1",
      apiKey: "lmstudio",
      api: "openai-responses",
      models: [
        {
          id: "minimax-m2.1-gs32",
          name: "MiniMax M2.1 GS32",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 196608,
          maxTokens: 8192,
        },
      ],
    };
  }

  return {
    ...cfg,
    agent: {
      ...cfg.agent,
      model: "Minimax",
      allowedModels: Array.from(allowed),
      modelAliases: aliases,
    },
    models: {
      mode: cfg.models?.mode ?? "merge",
      providers,
    },
  };
}

function upsertSkillEntry(
  cfg: ClawdisConfig,
  skillKey: string,
  patch: { apiKey?: string },
): ClawdisConfig {
  const entries = { ...(cfg.skills?.entries ?? {}) };
  const existing = (entries[skillKey] as { apiKey?: string } | undefined) ?? {};
  entries[skillKey] = { ...existing, ...patch };
  return {
    ...cfg,
    skills: {
      ...cfg.skills,
      entries,
    },
  };
}

function resolveNodeManagerOptions(): Array<{
  value: "npm" | "pnpm" | "bun";
  label: string;
}> {
  return [
    { value: "npm", label: "npm" },
    { value: "pnpm", label: "pnpm" },
    { value: "bun", label: "bun" },
  ];
}

async function moveToTrash(
  pathname: string,
  runtime: RuntimeEnv,
): Promise<void> {
  if (!pathname) return;
  try {
    await fs.access(pathname);
  } catch {
    return;
  }
  try {
    await runCommandWithTimeout(["trash", pathname], { timeoutMs: 5000 });
    runtime.log(`Moved to Trash: ${pathname}`);
  } catch {
    runtime.log(`Failed to move to Trash (manual delete): ${pathname}`);
  }
}

async function handleReset(
  scope: ResetScope,
  workspaceDir: string,
  runtime: RuntimeEnv,
) {
  await moveToTrash(CONFIG_PATH_CLAWDIS, runtime);
  if (scope === "config") return;
  await moveToTrash(path.join(CONFIG_DIR, "credentials"), runtime);
  await moveToTrash(resolveSessionTranscriptsDir(), runtime);
  if (scope === "full") {
    await moveToTrash(workspaceDir, runtime);
  }
}

async function setupSkills(
  cfg: ClawdisConfig,
  workspaceDir: string,
  runtime: RuntimeEnv,
): Promise<ClawdisConfig> {
  const report = buildWorkspaceSkillStatus(workspaceDir, { config: cfg });
  const eligible = report.skills.filter((s) => s.eligible);
  const missing = report.skills.filter(
    (s) => !s.eligible && !s.disabled && !s.blockedByAllowlist,
  );
  const blocked = report.skills.filter((s) => s.blockedByAllowlist);

  note(
    [
      `Eligible: ${eligible.length}`,
      `Missing requirements: ${missing.length}`,
      `Blocked by allowlist: ${blocked.length}`,
    ].join("\n"),
    "Skills status",
  );

  const shouldConfigure = guardCancel(
    await confirm({
      message: "Configure skills now? (recommended)",
      initialValue: true,
    }),
    runtime,
  );
  if (!shouldConfigure) return cfg;

  const nodeManager = guardCancel(
    await select({
      message: "Preferred node manager for skill installs",
      options: resolveNodeManagerOptions(),
    }),
    runtime,
  );

  let next: ClawdisConfig = {
    ...cfg,
    skills: {
      ...cfg.skills,
      install: {
        ...cfg.skills?.install,
        nodeManager,
      },
    },
  };

  const installable = missing.filter(
    (skill) => skill.install.length > 0 && skill.missing.bins.length > 0,
  );
  if (installable.length > 0) {
    const toInstall = guardCancel(
      await multiselect({
        message: "Install missing skill dependencies",
        options: installable.map((skill) => ({
          value: skill.name,
          label: `${skill.emoji ?? "🧩"} ${skill.name}`,
          hint: skill.install[0]?.label ?? "install",
        })),
      }),
      runtime,
    );

    for (const name of toInstall as string[]) {
      const target = installable.find((s) => s.name === name);
      if (!target || target.install.length === 0) continue;
      const installId = target.install[0]?.id;
      if (!installId) continue;
      const spin = spinner();
      spin.start(`Installing ${name}…`);
      const result = await installSkill({
        workspaceDir,
        skillName: target.name,
        installId,
        config: next,
      });
      spin.stop(result.ok ? `Installed ${name}` : `Install failed: ${name}`);
      if (!result.ok && result.stderr) {
        runtime.log(result.stderr.trim());
      }
    }
  }

  for (const skill of missing) {
    if (!skill.primaryEnv || skill.missing.env.length === 0) continue;
    const wantsKey = guardCancel(
      await confirm({
        message: `Set ${skill.primaryEnv} for ${skill.name}?`,
        initialValue: false,
      }),
      runtime,
    );
    if (!wantsKey) continue;
    const apiKey = guardCancel(
      await text({
        message: `Enter ${skill.primaryEnv}`,
        validate: (value) => (value?.trim() ? undefined : "Required"),
      }),
      runtime,
    );
    next = upsertSkillEntry(next, skill.skillKey, { apiKey: apiKey.trim() });
  }

  return next;
}

export async function onboardCommand(
  opts: OnboardOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  assertSupportedRuntime(runtime);

  if (opts.nonInteractive) {
    const snapshot = await readConfigFileSnapshot();
    const baseConfig: ClawdisConfig = snapshot.valid ? snapshot.config : {};
    const mode: OnboardMode = opts.mode ?? "local";

    if (mode === "remote") {
      const payload = {
        mode,
        instructions: [
          "clawdis setup",
          "clawdis gateway-daemon --port 18789",
          "OAuth creds: ~/.clawdis/credentials/oauth.json",
          "Workspace: ~/clawd",
        ],
      };
      if (opts.json) {
        runtime.log(JSON.stringify(payload, null, 2));
      } else {
        runtime.log(payload.instructions.join("\n"));
      }
      return;
    }

    const workspaceDir = resolveUserPath(
      (
        opts.workspace ??
        baseConfig.agent?.workspace ??
        DEFAULT_AGENT_WORKSPACE_DIR
      ).trim(),
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
    } else if (authChoice === "oauth") {
      runtime.error("OAuth requires interactive mode.");
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

    await writeConfigFile(nextConfig);
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
    return;
  }

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
      const workspaceDefault =
        baseConfig.agent?.workspace ?? DEFAULT_AGENT_WORKSPACE_DIR;
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
        initialValue:
          baseConfig.agent?.workspace ?? DEFAULT_AGENT_WORKSPACE_DIR,
      }),
      runtime,
    ) as string);

  const workspaceDir = resolveUserPath(
    workspaceInput.trim() || DEFAULT_AGENT_WORKSPACE_DIR,
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
      await writeOAuthCredentials("anthropic", oauthCreds);
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
  );

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
    tailscaleResetOnExit = guardCancel(
      await confirm({
        message: "Reset Tailscale serve/funnel on exit?",
        initialValue: false,
      }),
      runtime,
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
      bind: String(bind),
      tailscale: {
        ...nextConfig.gateway?.tailscale,
        mode: tailscaleMode,
        resetOnExit: tailscaleResetOnExit,
      },
    },
  };

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
