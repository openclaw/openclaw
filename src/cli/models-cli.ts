// Commander registration for model catalog, status, auth, alias, and fallback commands.
import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import type { ModelsAuthSetApiKeyResult } from "../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { GATEWAY_SERVER_CAPS } from "../../packages/gateway-protocol/src/server-capabilities.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { formatDocsHelp } from "./help-format.js";
import { runWithLocalStateOwner } from "./local-state-owner.js";
import { registerModelsAccountsCli } from "./models-accounts-cli.js";
import type { GlobalOnlyModelCommandName } from "./models-cli.runtime.js";
import { isModelsStatusJsonOutput } from "./models-output-mode.js";
import { setCommandJsonMode } from "./program/json-mode.js";

type ModelsCliRuntime = typeof import("./models-cli.runtime.js");
type ModelsAuthCommands = typeof import("../commands/models/auth.js");
type ModelsStatusOptions = Parameters<
  typeof import("../commands/models/list.status-command.js").modelsStatusCommand
>[0];
type ModelsAuthLoginOptions = Parameters<ModelsAuthCommands["modelsAuthLoginCommand"]>[0] & {
  deviceCode?: boolean;
};
type ModelsAuthOrderOptions = { provider: string; agent?: string; json?: boolean };

async function withModelsRuntime(
  action: (runtime: ModelsCliRuntime) => Promise<void>,
): Promise<void> {
  const runtime = await import("./models-cli.runtime.js");
  return runtime.runModelsCommand(() => action(runtime));
}

function runAgentModelCommand<T extends object>(
  command: Command,
  options: (agent: string | undefined) => T,
  load: () => Promise<(opts: T, runtime: ModelsCliRuntime["defaultRuntime"]) => Promise<void>>,
): Promise<void> {
  return withModelsRuntime(async ({ defaultRuntime, resolveModelAgentOption }) => {
    const agent = resolveModelAgentOption(command);
    const run = await load();
    await run(options(agent), defaultRuntime);
  });
}

// Ownership is selected before loading any mutation-capable auth runtime.
function runAuthModelCommand<T extends object>(
  command: Command,
  options: (agent: string | undefined) => T,
  load: () => Promise<(opts: T, runtime: ModelsCliRuntime["defaultRuntime"]) => Promise<void>>,
): Promise<void> {
  return withModelsRuntime(async ({ defaultRuntime, resolveModelAgentOption }) => {
    const agent = resolveModelAgentOption(command);
    const opts = options(agent);
    if (command.name() === "login" || command.name() === "login-github-copilot") {
      const loginOptions = command.opts<ModelsAuthLoginOptions>();
      const copilot = command.name() === "login-github-copilot";
      const sessionId = randomUUID();
      const unsupported = [
        loginOptions.profileId?.trim() ? "--profile-id" : undefined,
        loginOptions.force ? "--force" : undefined,
        loginOptions.setDefault ? "--set-default" : undefined,
        loginOptions.yes ? "--yes" : undefined,
      ].filter(Boolean);
      let cancellationConfirmed = false;
      await runWithLocalStateOwner({
        method: "models.authLogin",
        params: async (signal) => {
          // Load the plugin registry only after choosing the Gateway owner, not during CLI help.
          const { readGatewayLoginParams } =
            await import("../commands/models/auth-login-gateway.js");
          return readGatewayLoginParams(
            {
              provider: copilot ? "github-copilot" : loginOptions.provider,
              method: copilot
                ? "device"
                : loginOptions.deviceCode
                  ? "device-code"
                  : loginOptions.method,
              agent,
            },
            sessionId,
            signal,
          );
        },
        target: "system/agent provider sign-in",
        requireLocalBackendSharedAuth: true,
        requiredCapabilities: [GATEWAY_SERVER_CAPS.MODELS_AUTH_LOGIN_OWNER],
        timeoutMs: 25 * 60_000,
        onForeignOwner: unsupported.length
          ? async () => {
              throw new Error(
                `${unsupported.join(", ")} cannot be represented by models.authLogin. Omit these options, or stop the Gateway through its service owner and rerun this command offline. No credential was changed.`,
              );
            }
          : undefined,
        onGatewayResponse: async (request, signal) => {
          // Terminal auth runtime belongs to the accepted Gateway wizard, not CLI registration.
          const { runGatewayLoginWizard } =
            await import("../commands/models/auth-login-gateway.js");
          await runGatewayLoginWizard(request, sessionId, signal, defaultRuntime);
        },
        onGatewaySignalAbort: async (request) => {
          await request("wizard.cancel", { sessionId, closeInput: true });
          cancellationConfirmed = true;
        },
        runLocal: async () => {
          const run = await load();
          await run(opts, defaultRuntime);
        },
      }).catch((error: unknown) => {
        if (!cancellationConfirmed) {
          throw error;
        }
        defaultRuntime.log("Login session closed. Credentials already saved were not undone.");
      });
      return;
    }
    const pasteApiKey = command.name() === "paste-api-key";
    const { provider, profileId } = command.opts<{ provider?: string; profileId?: string }>();
    const result = await runWithLocalStateOwner<ModelsAuthSetApiKeyResult | void>({
      method: pasteApiKey ? "models.authSetApiKey" : "models.auth",
      params: pasteApiKey
        ? async (signal) => {
            // Read-only input collection stays behind Gateway owner selection.
            const { readGatewayApiKeyParams } = await import("../commands/models/auth-gateway.js");
            return readGatewayApiKeyParams({ provider, agent }, signal);
          }
        : {},
      target:
        command.name() === "paste-token"
          ? "token credentials (models.authSetApiKey cannot store token types or --expires-in)"
          : "system/agent credentials",
      requireLocalBackendSharedAuth: pasteApiKey,
      requiredCapabilities: pasteApiKey
        ? [GATEWAY_SERVER_CAPS.MODELS_AUTH_SET_API_KEY_OWNER]
        : undefined,
      onForeignOwner: !pasteApiKey
        ? "refuse"
        : profileId?.trim()
          ? async () => {
              throw new Error(
                "--profile-id is not supported by models.authSetApiKey. Omit --profile-id to use the Gateway's API-key profile, or stop the Gateway through its service owner and rerun this command.",
              );
            }
          : undefined,
      runLocal: async () => {
        const run = await load();
        await run(opts, defaultRuntime);
      },
    });
    if (result) {
      if (result.warning) {
        defaultRuntime.error(sanitizeTerminalText(result.warning));
      }
      defaultRuntime.log(
        `Auth profile: ${sanitizeTerminalText(result.profileId)} (${sanitizeTerminalText(result.provider)}/api_key)`,
      );
    }
  });
}

/** Run a command that edits global defaults, rejecting the inherited `models --agent`. */
async function withGlobalModelsRuntime(
  command: Command,
  commandName: GlobalOnlyModelCommandName,
  action: (runtime: ModelsCliRuntime) => Promise<void>,
): Promise<void> {
  return withModelsRuntime(async (runtime) => {
    runtime.rejectAgentScopedModelCommand(command, commandName);
    await action(runtime);
  });
}

export function registerModelsCli(program: Command) {
  const models = program
    .command("models")
    .description("Model discovery, scanning, and configuration")
    .option("--json", "Output JSON (alias for `models status --json`)", false)
    .option("--status-json", "Output JSON (alias for `models status --json`)", false)
    .option("--status-plain", "Plain output (alias for `models status --plain`)", false)
    .option("--agent <id>", "Agent id to inspect (overrides OPENCLAW_AGENT_DIR)")
    .addHelpText("after", () => formatDocsHelp("/cli/models"));
  const hasJsonOutput = (opts?: { json?: boolean }): boolean =>
    Boolean(opts?.json || models.opts<{ json?: boolean }>().json);
  setCommandJsonMode(models, "output", ({ argv, command }) =>
    isModelsStatusJsonOutput(argv, command),
  );
  registerModelsAccountsCli(models);

  models
    .command("list")
    .description("List models (configured by default)")
    .option("--refresh", "Refresh provider discovery before listing", false)
    .option("--all", "Show full model catalog", false)
    .option("--local", "Filter to local models", false)
    .option("--provider <id>", "Filter by provider id")
    .option("--agent <id>", "Agent id to inspect (overrides OPENCLAW_AGENT_DIR)")
    .option("--json", "Output JSON", false)
    .option("--plain", "Plain line output", false)
    .action(async (opts, command) => {
      await withModelsRuntime(async ({ defaultRuntime, resolveModelAgentOption }) => {
        const { modelsListCommand } = await import("../commands/models/list.list-command.js");
        await modelsListCommand(
          {
            ...opts,
            json: hasJsonOutput(opts),
            agent: resolveModelAgentOption(command),
          },
          defaultRuntime,
        );
      });
    });

  models
    .command("status")
    .description("Show configured model state")
    .option("--json", "Output JSON", false)
    .option("--plain", "Plain output", false)
    .option(
      "--check",
      "Check auth/runtime readiness (1=missing/expired/unavailable/incompatible/indeterminate, 2=expiring)",
      false,
    )
    .option("--probe", "Check configured provider auth (live)", false)
    .option("--probe-provider <name>", "Only check a single provider")
    .option(
      "--probe-profile <id>",
      "Only check specific auth profile ids (repeat or comma-separated)",
      (value, previous) => {
        const next = Array.isArray(previous) ? previous : previous ? [previous] : [];
        next.push(value);
        return next;
      },
    )
    .option("--probe-timeout <ms>", "Timeout per check in ms")
    .option("--probe-concurrency <n>", "Concurrent checks")
    .option("--probe-max-tokens <n>", "Maximum tokens per check (best-effort)")
    .option("--agent <id>", "Agent id to inspect (overrides OPENCLAW_AGENT_DIR)")
    .action((opts: ModelsStatusOptions, command) =>
      runAgentModelCommand(
        command,
        (agent) => ({ ...opts, json: hasJsonOutput(opts), agent }),
        async () => (await import("../commands/models/list.status-command.js")).modelsStatusCommand,
      ),
    );

  models
    .command("refresh")
    .description("Refresh the hosted model catalog")
    .option("--json", "Output JSON", false)
    .action(async (opts, command: Command) => {
      await withGlobalModelsRuntime(command, "refresh", async ({ defaultRuntime }) => {
        const { modelsRefreshCommand } = await import("../commands/models/refresh.js");
        await modelsRefreshCommand({ json: hasJsonOutput(opts) }, defaultRuntime);
      });
    });

  for (const [name, description, field] of [
    ["set", "Set the default model", "model"],
    ["set-image", "Set the image model", "imageModel"],
  ] as const) {
    models
      .command(name)
      .description(description)
      .argument("<model>", "Model id or alias")
      .action(async (model: string, _opts: unknown, command: Command) => {
        await withGlobalModelsRuntime(command, name, async ({ defaultRuntime }) => {
          const { modelsSetCommand } = await import("../commands/models/set.js");
          await modelsSetCommand(model, defaultRuntime, field);
        });
      });
  }

  const aliases = models.command("aliases").description("Manage model aliases");

  aliases
    .command("list")
    .description("List model aliases")
    .option("--json", "Output JSON", false)
    .option("--plain", "Plain output", false)
    .action(async (opts, command: Command) => {
      await withGlobalModelsRuntime(command, "aliases list", async ({ defaultRuntime }) => {
        const { modelsAliasesListCommand } = await import("../commands/models/aliases.js");
        await modelsAliasesListCommand({ ...opts, json: hasJsonOutput(opts) }, defaultRuntime);
      });
    });

  aliases
    .command("add")
    .description("Add or update a model alias")
    .argument("<alias>", "Alias name")
    .argument("<model>", "Model id or alias")
    .action(async (alias: string, model: string, _opts: unknown, command: Command) => {
      await withGlobalModelsRuntime(command, "aliases add", async ({ defaultRuntime }) => {
        const { modelsAliasesAddCommand } = await import("../commands/models/aliases.js");
        await modelsAliasesAddCommand(alias, model, defaultRuntime);
      });
    });

  aliases
    .command("remove")
    .description("Remove a model alias")
    .argument("<alias>", "Alias name")
    .action(async (alias: string, _opts: unknown, command: Command) => {
      await withGlobalModelsRuntime(command, "aliases remove", async ({ defaultRuntime }) => {
        const { modelsAliasesRemoveCommand } = await import("../commands/models/aliases.js");
        await modelsAliasesRemoveCommand(alias, defaultRuntime);
      });
    });

  const fallbackGroups = [
    {
      name: "fallbacks",
      modelType: "model",
      noun: "fallback",
      article: "a",
      key: "model",
      label: "Fallbacks",
      notFoundLabel: "Fallback",
      clearedMessage: "Fallback list cleared.",
    },
    {
      name: "image-fallbacks",
      modelType: "image model",
      noun: "image fallback",
      article: "an",
      key: "imageModel",
      label: "Image fallbacks",
      notFoundLabel: "Image fallback",
      clearedMessage: "Image fallback list cleared.",
    },
  ] as const;

  for (const params of fallbackGroups) {
    const { name, modelType, noun, article } = params;
    const group = models.command(name).description(`Manage ${modelType} fallback list`);

    group
      .command("list")
      .description(`List ${noun} models`)
      .option("--json", "Output JSON", false)
      .option("--plain", "Plain output", false)
      .action(async (opts) => {
        await withModelsRuntime(async ({ defaultRuntime }) => {
          const { listFallbacksCommand } = await import("../commands/models/fallbacks-shared.js");
          await listFallbacksCommand(
            params,
            { ...opts, json: hasJsonOutput(opts) },
            defaultRuntime,
          );
        });
      });

    for (const action of ["add", "remove"] as const) {
      group
        .command(action)
        .description(`${action === "add" ? "Add" : "Remove"} ${article} ${noun} model`)
        .argument("<model>", "Model id or alias")
        .action(async (model: string, _opts: unknown, command: Command) => {
          await withGlobalModelsRuntime(
            command,
            `${name} ${action}`,
            async ({ defaultRuntime }) => {
              const { changeFallbacksCommand } =
                await import("../commands/models/fallbacks-shared.js");
              await changeFallbacksCommand({ ...params, action }, model, defaultRuntime);
            },
          );
        });
    }

    group
      .command("clear")
      .description(`Clear all ${noun} models`)
      .action(async (_opts: unknown, command: Command) => {
        await withGlobalModelsRuntime(command, `${name} clear`, async ({ defaultRuntime }) => {
          const { clearFallbacksCommand } = await import("../commands/models/fallbacks-shared.js");
          await clearFallbacksCommand(params, defaultRuntime);
        });
      });
  }

  models
    .command("scan")
    .description("Scan OpenRouter free models for tools + images")
    .option("--min-params <b>", "Minimum parameter size (billions)")
    .option("--max-age-days <days>", "Skip models older than N days")
    .option("--provider <name>", "Filter by provider prefix")
    .option("--max-candidates <n>", "Max fallback candidates", "6")
    .option("--timeout <ms>", "Timeout per check in ms")
    .option("--concurrency <n>", "Check concurrency")
    .option("--no-probe", "Skip live checks; list free candidates only (writes no config)")
    .option("--yes", "Accept defaults without prompting", false)
    .option("--no-input", "Disable prompts (use defaults)")
    .option(
      "--set-default",
      "Also set agents.defaults.model primary to the first selection (fallbacks are replaced either way)",
      false,
    )
    .option(
      "--set-image",
      "Also set agents.defaults.imageModel primary to the first image selection",
      false,
    )
    .option("--json", "Output JSON", false)
    .action(async (opts, command: Command) => {
      await withGlobalModelsRuntime(command, "scan", async ({ defaultRuntime }) => {
        const { modelsScanCommand } = await import("../commands/models/scan.js");
        await modelsScanCommand({ ...opts, json: hasJsonOutput(opts) }, defaultRuntime);
      });
    });

  models.action(async (opts) => {
    await withModelsRuntime(async ({ defaultRuntime }) => {
      const { modelsStatusCommand } = await import("../commands/models/list.status-command.js");
      await modelsStatusCommand(
        {
          json: Boolean(opts?.json || opts?.statusJson),
          plain: Boolean(opts?.statusPlain),
          agent: opts?.agent as string | undefined,
        },
        defaultRuntime,
      );
    });
  });

  const auth = models
    .command("auth")
    .description("Manage system/agent credentials on this machine");
  auth.option("--agent <id>", "Agent id for auth commands");
  auth.action(() => {
    auth.help();
  });

  auth
    .command("list")
    .description("List saved auth profiles")
    .option("--provider <id>", "Filter by provider id")
    .option("--agent <id>", "Agent id (default: configured system agent)")
    .option("--json", "Output JSON", false)
    .action((opts: { provider?: string; agent?: string; json?: boolean }, command) =>
      runAuthModelCommand(
        command,
        (agent) => ({ ...opts, agent, json: hasJsonOutput(opts) }),
        async () => (await import("../commands/models/auth-list.js")).modelsAuthListCommand,
      ),
    );

  auth
    .command("add")
    .description("Interactive auth helper (provider auth or paste token)")
    .option("--agent <id>", "Agent id (default: configured default agent)")
    .action((_opts, command) =>
      runAuthModelCommand(
        command,
        (agent) => ({ agent }),
        async () => (await import("../commands/models/auth.js")).modelsAuthAddCommand,
      ),
    );

  auth
    .command("activate")
    .description("Test a saved sign-in and use it for this agent")
    .argument("<profileId>", "Saved sign-in id from models auth list")
    .option("--agent <id>", "Agent id (default: the only configured agent)")
    .action((profileId: string, _opts, command) =>
      runAuthModelCommand(
        command,
        (agent) => ({ profileId, agent }),
        async () => (await import("../commands/models/auth-activate.js")).modelsAuthActivateCommand,
      ),
    );

  auth
    .command("logout")
    .description("Remove a saved auth profile (see `models auth list` for ids)")
    .argument("<profileId>", "Auth profile id (e.g. openai:manual)")
    .option("--agent <id>", "Agent id (default: configured default agent)")
    .option("--yes", "Skip the confirmation prompt", false)
    .action((profileId: string, opts: { agent?: string; yes?: boolean }, command) =>
      runAuthModelCommand(
        command,
        (agent) => ({ ...opts, profileId, agent }),
        async () => (await import("../commands/models/auth-logout.js")).modelsAuthLogoutCommand,
      ),
    );

  auth
    .command("login")
    .description("Sign in for system/agent use on this machine (OAuth/API key)")
    .option("--agent <id>", "Agent id (default: configured default agent)")
    .option("--provider <id>", "Provider id registered by a plugin")
    .option("--method <id>", "Provider auth method id")
    .option("--device-code", "Use the provider device-code auth method", false)
    .option("--profile-id <id>", "Auth profile id override for single-profile login methods")
    .option("--set-default", "Apply the provider's default model recommendation", false)
    .option(
      "--force",
      "Remove existing profiles for the provider before logging in (use when a cached OAuth profile is stuck or you want to switch accounts)",
      false,
    )
    .action(async ({ deviceCode, ...opts }: ModelsAuthLoginOptions, command) => {
      if (deviceCode && typeof opts.method === "string" && opts.method !== "device-code") {
        throw new Error(
          "--device-code cannot be combined with --method unless method is device-code.",
        );
      }
      await runAuthModelCommand(
        command,
        (agent) => ({ ...opts, method: deviceCode ? "device-code" : opts.method, agent }),
        async () => (await import("../commands/models/auth.js")).modelsAuthLoginCommand,
      );
    });

  auth
    .command("setup-token")
    .description("Run a provider CLI to create/sync a token (TTY required)")
    .option("--agent <id>", "Agent id (default: configured default agent)")
    .option("--provider <name>", "Provider id")
    .option("--yes", "Skip confirmation", false)
    .action((opts: { provider?: string; agent?: string; yes?: boolean }, command) =>
      runAuthModelCommand(
        command,
        (agent) => ({ ...opts, agent }),
        async () => (await import("../commands/models/auth.js")).modelsAuthSetupTokenCommand,
      ),
    );

  for (const [name, noun, exampleProvider, handler] of [
    ["paste-token", "token", "anthropic", "modelsAuthPasteTokenCommand"],
    ["paste-api-key", "API key", "openai", "modelsAuthPasteApiKeyCommand"],
  ] as const) {
    const paste = auth
      .command(name)
      .description(
        `Save ${name === "paste-token" ? "a" : "an"} ${noun} in an auth profile and update config`,
      )
      .option("--agent <id>", "Agent id (default: configured default agent)")
      .requiredOption("--provider <name>", `Provider id (e.g. ${exampleProvider})`)
      .option("--profile-id <id>", "Auth profile id (default: <provider>:manual)");
    if (name === "paste-token") {
      paste.option(
        "--expires-in <duration>",
        "Optional expiry duration (e.g. 365d, 12h). Stored as absolute expiresAt.",
      );
    }
    paste.action((opts: Parameters<ModelsAuthCommands[typeof handler]>[0], command) =>
      runAuthModelCommand(
        command,
        (agent) => ({ ...opts, agent }),
        async () => (await import("../commands/models/auth.js"))[handler],
      ),
    );
  }

  auth
    .command("login-github-copilot")
    .description("Login to GitHub Copilot via GitHub device flow (TTY required)")
    .option("--agent <id>", "Agent id (default: configured default agent)")
    .option("--yes", "Overwrite existing profile without prompting", false)
    .action((opts: { agent?: string; yes?: boolean }, command) =>
      runAuthModelCommand(
        command,
        (agent) => ({ ...opts, provider: "github-copilot", method: "device", agent }),
        async () => (await import("../commands/models/auth.js")).modelsAuthLoginCommand,
      ),
    );

  const order = auth.command("order").description("Manage per-agent auth profile order overrides");

  order
    .command("get")
    .description("Show per-agent auth profile order override")
    .requiredOption("--provider <name>", "Provider id (e.g. anthropic)")
    .option("--agent <id>", "Agent id (default: configured system agent)")
    .option("--json", "Output JSON", false)
    .action((opts: ModelsAuthOrderOptions, command) =>
      runAuthModelCommand(
        command,
        (agent) => ({ ...opts, agent, json: hasJsonOutput(opts) }),
        async () => (await import("../commands/models/auth-order.js")).modelsAuthOrderGetCommand,
      ),
    );

  order
    .command("set")
    .description("Set per-agent auth profile order override")
    .requiredOption("--provider <name>", "Provider id (e.g. anthropic)")
    .option("--agent <id>", "Agent id (default: configured default agent)")
    .argument("<profileIds...>", "Auth profile ids (e.g. anthropic:default)")
    .action((profileIds: string[], opts: ModelsAuthOrderOptions, command) =>
      runAuthModelCommand(
        command,
        (agent) => ({ ...opts, agent, order: profileIds }),
        async () => (await import("../commands/models/auth-order.js")).modelsAuthOrderUpdateCommand,
      ),
    );

  order
    .command("clear")
    .description("Clear per-agent auth profile order override")
    .requiredOption("--provider <name>", "Provider id (e.g. anthropic)")
    .option("--agent <id>", "Agent id (default: configured default agent)")
    .action((opts: ModelsAuthOrderOptions, command) =>
      runAuthModelCommand(
        command,
        (agent) => ({ ...opts, agent, order: null }),
        async () => (await import("../commands/models/auth-order.js")).modelsAuthOrderUpdateCommand,
      ),
    );
}
