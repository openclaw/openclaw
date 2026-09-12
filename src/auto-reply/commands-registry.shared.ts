/** Shared command registry builders used by browser-safe and runtime command lists. */
import { normalizeOptionalLowercaseString } from "../../packages/normalization-core/src/string-coerce.js";
import { normalizeStringEntries } from "../../packages/normalization-core/src/string-normalization.js";
import { formatFastModeAutoLabel, resolveFastModeModelAutoOnSeconds } from "../shared/fast-mode.js";
import { COMMAND_ARG_FORMATTERS } from "./commands-args.js";
import type {
  ChatCommandDefinition,
  CommandArgChoiceContext,
  CommandCategory,
  CommandTier,
} from "./commands-registry.types.js";
import { parseActivationCommand } from "./group-activation.js";
import {
  parseSendPolicyCommandBody,
  parseSlashCommandOrNull,
} from "./reply/commands-slash-parse.js";
import { BASE_THINKING_LEVELS, type ThinkLevel } from "./thinking.shared.js";

type ListThinkingLevels = (
  provider?: string | null,
  model?: string | null,
  catalog?: CommandArgChoiceContext["catalog"],
  agentRuntime?: string | null,
) => string[];

const BROWSER_SAFE_THINKING_LEVELS: ThinkLevel[] = [
  ...BASE_THINKING_LEVELS,
  "xhigh",
  "adaptive",
  "max",
];

/**
 * Keep simple model selections on fast client-side patch paths. Semantic reset
 * and multi-token forms require the server directive parser to own the full
 * atomic transaction.
 */
export function shouldForwardModelCommandToServer(rawArgs: string): boolean {
  const args = rawArgs.trim();
  const normalized = args.toLowerCase();
  return ["default", "list", "status"].includes(normalized) || /\s/u.test(args);
}

/** Validates command registry uniqueness and text/native surface invariants. */
function assertCommandRegistry(commands: ChatCommandDefinition[]): void {
  const keys = new Set<string>();
  const nativeNames = new Set<string>();
  const textAliases = new Set<string>();
  for (const command of commands) {
    if (keys.has(command.key)) {
      throw new Error(`Duplicate command key: ${command.key}`);
    }
    keys.add(command.key);

    const nativeName = command.nativeName?.trim();
    if (command.scope === "text") {
      if (nativeName) {
        throw new Error(`Text-only command has native name: ${command.key}`);
      }
      if (command.nativeAliases?.length) {
        throw new Error(`Text-only command has native aliases: ${command.key}`);
      }
      if (command.textAliases.length === 0) {
        throw new Error(`Text-only command missing text alias: ${command.key}`);
      }
    } else if (!nativeName) {
      throw new Error(`Native command missing native name: ${command.key}`);
    } else {
      for (const alias of [nativeName, ...(command.nativeAliases ?? [])]) {
        const nativeKey = normalizeOptionalLowercaseString(alias) ?? "";
        if (nativeNames.has(nativeKey)) {
          throw new Error(`Duplicate native command: ${alias}`);
        }
        nativeNames.add(nativeKey);
      }
    }

    if (command.scope === "native" && command.textAliases.length > 0) {
      throw new Error(`Native-only command has text aliases: ${command.key}`);
    }

    for (const alias of command.textAliases) {
      if (!alias.startsWith("/")) {
        throw new Error(`Command alias missing leading '/': ${alias}`);
      }
      const aliasKey = normalizeOptionalLowercaseString(alias) ?? "";
      if (textAliases.has(aliasKey)) {
        throw new Error(`Duplicate command alias: ${alias}`);
      }
      textAliases.add(aliasKey);
    }
  }
}

type BuiltinCommandArgument = NonNullable<ChatCommandDefinition["args"]>[number];
type BuiltinCommandArgumentOptions = Omit<
  BuiltinCommandArgument,
  "name" | "description" | "type"
> & { type?: BuiltinCommandArgument["type"] };
type BuiltinCommandOptions = Omit<
  ChatCommandDefinition,
  "key" | "description" | "category" | "tier" | "nativeName" | "textAliases" | "scope"
> & { nativeName?: string | false; textAliases?: string[] };

function defineCommandArgument(
  name: string,
  description: string,
  options: BuiltinCommandArgumentOptions = {},
): BuiltinCommandArgument {
  return { name, description, type: "string", ...options };
}

/** Defines a built-in command with its aliases and argument parsing defaults. */
function defineBuiltinCommand(
  key: string,
  description: string,
  category: CommandCategory,
  tier: CommandTier,
  options: BuiltinCommandOptions = {},
): ChatCommandDefinition {
  const { nativeName = key } = options;
  return {
    key,
    nativeName: nativeName === false ? undefined : nativeName,
    nativeAliases: options.nativeAliases
      ? normalizeStringEntries(options.nativeAliases)
      : undefined,
    nativeProviders: options.nativeProviders
      ? normalizeStringEntries(options.nativeProviders)
      : undefined,
    description,
    ...(options.descriptionLocalizations
      ? { descriptionLocalizations: options.descriptionLocalizations }
      : {}),
    acceptsArgs: options.acceptsArgs ?? Boolean(options.args?.length),
    args: options.args,
    argsParsing: options.argsParsing ?? (options.args?.length ? "positional" : "none"),
    formatArgs: options.formatArgs,
    argsMenu: options.argsMenu,
    textAliases: (options.textAliases ?? [`/${key}`]).map((alias) => alias.trim()).filter(Boolean),
    scope: nativeName === false ? "text" : "both",
    category,
    tier,
    activeRunSafe: options.activeRunSafe,
    modelIndependent: options.modelIndependent,
  };
}

/** Builds the built-in command list with context-aware thinking choices. */
export function buildBuiltinChatCommands(
  params: { listThinkingLevels?: ListThinkingLevels } = {},
): ChatCommandDefinition[] {
  const configuredThinkingLevels =
    params.listThinkingLevels ?? (() => BROWSER_SAFE_THINKING_LEVELS);
  const listThinkingLevelChoices: ListThinkingLevels = (provider, model, catalog, agentRuntime) => {
    const levels = configuredThinkingLevels(provider, model, catalog, agentRuntime);
    return ["default", ...levels.filter((level) => level !== "default")];
  };
  const commands: ChatCommandDefinition[] = [
    defineBuiltinCommand("help", "Show available commands.", "status", "essential", {
      modelIndependent: "always",
    }),
    defineBuiltinCommand("commands", "List all slash commands.", "status", "power", {
      modelIndependent: "no-args",
    }),
    defineBuiltinCommand("tools", "List available runtime tools.", "status", "standard", {
      modelIndependent: "always",
      args: [
        defineCommandArgument("mode", "compact or verbose", { choices: ["compact", "verbose"] }),
      ],
      argsMenu: "auto",
    }),
    defineBuiltinCommand("skill", "Run a skill by name.", "tools", "standard", {
      modelIndependent: "no-args",
      args: [
        defineCommandArgument("name", "Skill name", { required: true }),
        defineCommandArgument("input", "Skill input", { captureRemaining: true }),
      ],
    }),
    defineBuiltinCommand(
      "dashboard",
      "Create or update this session's dashboard.",
      "tools",
      "standard",
      {
        args: [
          defineCommandArgument("request", "Dashboard requirements", {
            captureRemaining: true,
          }),
        ],
      },
    ),
    defineBuiltinCommand(
      "learn",
      "Draft a reusable skill from recent work or named sources.",
      "tools",
      "standard",
      {
        args: [
          defineCommandArgument("request", "Sources and requirements for the skill draft", {
            captureRemaining: true,
          }),
        ],
      },
    ),
    defineBuiltinCommand(
      "loop",
      "Loop a prompt: /loop [interval] <prompt> | /loop status | /loop stop [name]",
      "tools",
      "standard",
      {
        modelIndependent: (args) => !args || args.toLowerCase() === "help",
        args: [
          defineCommandArgument("spec", "[interval] prompt, or status/stop", {
            required: false,
            captureRemaining: true,
          }),
        ],
      },
    ),
    defineBuiltinCommand("status", "Show current status.", "status", "essential", {
      acceptsArgs: true,
      activeRunSafe: true,
      modelIndependent: "always",
    }),
    defineBuiltinCommand("goal", "Show or control the current goal.", "status", "standard", {
      modelIndependent: (args) => {
        const parsed = parseSlashCommandOrNull(`/goal ${args}`, "/goal", {
          defaultAction: "status",
          invalidMessage: "",
        });
        return (
          parsed?.ok === true &&
          (["status", "edit", "pause", "complete", "done", "block", "blocked", "clear"].includes(
            parsed.action,
          ) ||
            (["start", "set", "create"].includes(parsed.action) && !parsed.args))
        );
      },
      args: [
        defineCommandArgument(
          "action",
          "status, start, edit, pause, resume, complete, block, clear",
          {
            choices: ["status", "start", "edit", "pause", "resume", "complete", "block", "clear"],
          },
        ),
        defineCommandArgument("text", "Goal objective or note", { captureRemaining: true }),
      ],
    }),
    defineBuiltinCommand(
      "diagnostics",
      "Explain Gateway diagnostics and Codex feedback upload options.",
      "status",
      "standard",
      {
        modelIndependent: "always",
        args: [
          defineCommandArgument("note", "Optional note for Codex feedback upload", {
            captureRemaining: true,
          }),
        ],
      },
    ),
    defineBuiltinCommand("login", "Connect a model provider.", "management", "standard", {
      modelIndependent: "always",
      nativeProviders: ["discord", "slack", "telegram"],
      args: [defineCommandArgument("provider", "Provider or connection method")],
    }),
    defineBuiltinCommand(
      "openclaw",
      "Run the OpenClaw setup and repair helper.",
      "management",
      "essential",
      {
        modelIndependent: "always",
        nativeName: false,
        acceptsArgs: true,
      },
    ),
    defineBuiltinCommand("tasks", "List background tasks for this session.", "status", "standard", {
      modelIndependent: "always",
    }),
    defineBuiltinCommand("allowlist", "List/add/remove allowlist entries.", "management", "power", {
      modelIndependent: "always",
      nativeName: false,
      acceptsArgs: true,
    }),
    defineBuiltinCommand("approve", "Approve or deny exec requests.", "management", "power", {
      acceptsArgs: true,
      modelIndependent: "always",
    }),
    defineBuiltinCommand(
      "context",
      "Explain how context is built and used.",
      "status",
      "standard",
      { acceptsArgs: true, modelIndependent: "always" },
    ),
    defineBuiltinCommand(
      "btw",
      "Ask a side question without changing future session context.",
      "tools",
      "standard",
      {
        modelIndependent: "no-args",
        nativeAliases: ["side"],
        textAliases: ["/btw", "/side"],
        acceptsArgs: true,
      },
    ),
    defineBuiltinCommand(
      "export-session",
      "Export current session to an owner-only HTML file in the workspace.",
      "status",
      "essential",
      {
        modelIndependent: "always",
        textAliases: ["/export-session", "/export"],
        args: [
          defineCommandArgument("path", "Output path inside workspace (default: workspace)", {
            required: false,
          }),
        ],
      },
    ),
    defineBuiltinCommand(
      "export-trajectory",
      "Export a JSONL trajectory bundle for the active session.",
      "status",
      "essential",
      {
        modelIndependent: "always",
        textAliases: ["/export-trajectory", "/trajectory"],
        args: [
          defineCommandArgument("path", "Output directory (default: workspace)", {
            required: false,
          }),
        ],
      },
    ),
    defineBuiltinCommand("tts", "Control text-to-speech (TTS).", "media", "standard", {
      modelIndependent: "always",
      args: [
        defineCommandArgument("action", "TTS action", {
          choices: [
            { value: "on", label: "On" },
            { value: "off", label: "Off" },
            { value: "status", label: "Status" },
            { value: "provider", label: "Provider" },
            { value: "limit", label: "Limit" },
            { value: "summary", label: "Summary" },
            { value: "audio", label: "Audio" },
            { value: "help", label: "Help" },
          ],
        }),
        defineCommandArgument("value", "Provider, limit, or text", { captureRemaining: true }),
      ],
      argsMenu: {
        arg: "action",
        title:
          "TTS Actions:\n" +
          "• On – Enable TTS for responses\n" +
          "• Off – Disable TTS\n" +
          "• Status – Show current settings\n" +
          "• Provider – Show or set the voice provider\n" +
          "• Limit – Set max characters for TTS\n" +
          "• Summary – Toggle AI summary for long texts\n" +
          "• Audio – Generate TTS from custom text\n" +
          "• Help – Show usage guide",
      },
    }),
    defineBuiltinCommand("whoami", "Show your sender id.", "status", "power", {
      textAliases: ["/whoami", "/id"],
      modelIndependent: "no-args",
    }),
    defineBuiltinCommand(
      "session",
      "Manage conversation bindings and session lifecycle settings.",
      "session",
      "power",
      {
        modelIndependent: "always",
        args: [
          defineCommandArgument("action", "idle | max-age | unbind", {
            choices: ["idle", "max-age", "unbind"],
          }),
          defineCommandArgument("value", "Duration (24h, 90m) or off", { captureRemaining: true }),
        ],
        argsMenu: "auto",
      },
    ),
    defineBuiltinCommand(
      "subagents",
      "Inspect subagent runs for this session.",
      "management",
      "standard",
      {
        modelIndependent: "always",
        args: [
          defineCommandArgument("action", "list | log | info", {
            choices: ["list", "log", "info"],
          }),
          defineCommandArgument("target", "Run id, index, or session key"),
          defineCommandArgument("value", "Additional input (limit/message)", {
            captureRemaining: true,
          }),
        ],
        argsMenu: "auto",
      },
    ),
    defineBuiltinCommand("acp", "Manage ACP sessions and runtime options.", "management", "power", {
      modelIndependent: (args) => {
        const parsed = parseSlashCommandOrNull(`/acp ${args}`, "/acp", {
          defaultAction: "help",
          invalidMessage: "",
        });
        return parsed?.ok === true && (parsed.action !== "steer" || !parsed.args);
      },
      args: [
        defineCommandArgument("action", "Action to run", {
          preferAutocomplete: true,
          choices: [
            "spawn",
            "cancel",
            "steer",
            "close",
            "sessions",
            "status",
            "set-mode",
            "set",
            "cwd",
            "permissions",
            "timeout",
            "model",
            "reset-options",
            "doctor",
            "install",
            "help",
          ],
        }),
        defineCommandArgument("value", "Action arguments", { captureRemaining: true }),
      ],
      argsMenu: "auto",
    }),
    defineBuiltinCommand(
      "agents",
      "List thread-bound agents for this session.",
      "management",
      "standard",
      { modelIndependent: "always" },
    ),
    defineBuiltinCommand(
      "steer",
      "Send guidance to the active run in this session.",
      "management",
      "standard",
      {
        modelIndependent: "no-args",
        textAliases: ["/steer", "/tell"],
        args: [defineCommandArgument("message", "Steering message", { captureRemaining: true })],
      },
    ),
    defineBuiltinCommand("config", "Show or set config values.", "management", "power", {
      modelIndependent: "always",
      args: [
        defineCommandArgument("action", "show | get | set | unset", {
          choices: ["show", "get", "set", "unset"],
        }),
        defineCommandArgument("path", "Config path"),
        defineCommandArgument("value", "Value for set", { captureRemaining: true }),
      ],
      argsParsing: "none",
      formatArgs: COMMAND_ARG_FORMATTERS.config,
    }),
    defineBuiltinCommand("mcp", "Show or set OpenClaw MCP servers.", "management", "power", {
      modelIndependent: "always",
      args: [
        defineCommandArgument("action", "show | get | set | unset", {
          choices: ["show", "get", "set", "unset"],
        }),
        defineCommandArgument("path", "MCP server name"),
        defineCommandArgument("value", "JSON config for set", { captureRemaining: true }),
      ],
      argsParsing: "none",
      formatArgs: COMMAND_ARG_FORMATTERS.mcp,
    }),
    defineBuiltinCommand(
      "plugins",
      "List, show, enable, or disable plugins.",
      "management",
      "power",
      {
        modelIndependent: "always",
        textAliases: ["/plugins", "/plugin"],
        args: [
          defineCommandArgument("action", "list | show | get | enable | disable", {
            choices: ["list", "show", "get", "enable", "disable"],
          }),
          defineCommandArgument("path", "Plugin id or name"),
        ],
        argsParsing: "none",
        formatArgs: COMMAND_ARG_FORMATTERS.plugins,
      },
    ),
    defineBuiltinCommand("debug", "Set runtime debug overrides.", "management", "power", {
      modelIndependent: "always",
      args: [
        defineCommandArgument("action", "show | reset | set | unset", {
          choices: ["show", "reset", "set", "unset"],
        }),
        defineCommandArgument("path", "Debug path"),
        defineCommandArgument("value", "Value for set", { captureRemaining: true }),
      ],
      argsParsing: "none",
      formatArgs: COMMAND_ARG_FORMATTERS.debug,
    }),
    defineBuiltinCommand("usage", "Usage footer or cost summary.", "options", "standard", {
      modelIndependent: "always",
      args: [
        defineCommandArgument("mode", "off, tokens, full, or cost", {
          choices: ["off", "tokens", "full", "cost"],
        }),
      ],
      argsMenu: "auto",
    }),
    defineBuiltinCommand("stop", "Stop the current run.", "session", "essential", {
      activeRunSafe: true,
      modelIndependent: "no-args",
    }),
    defineBuiltinCommand("restart", "Restart OpenClaw.", "tools", "power", {
      modelIndependent: "no-args",
    }),
    defineBuiltinCommand("update", "Update OpenClaw and restart.", "tools", "power", {
      modelIndependent: "no-args",
    }),
    defineBuiltinCommand("activation", "Set group activation mode.", "management", "power", {
      modelIndependent: (args) => parseActivationCommand(`/activation ${args}`).hasCommand,
      args: [
        defineCommandArgument("mode", "mention or always", { choices: ["mention", "always"] }),
      ],
      argsMenu: "auto",
    }),
    defineBuiltinCommand("send", "Set send policy.", "management", "power", {
      modelIndependent: (args) => parseSendPolicyCommandBody(`/send ${args}`).hasCommand,
      args: [
        defineCommandArgument("mode", "on, off, or inherit", {
          choices: ["on", "off", "inherit"],
        }),
      ],
      argsMenu: "auto",
    }),
    defineBuiltinCommand("reset", "Reset the current session.", "session", "essential", {
      acceptsArgs: true,
    }),
    defineBuiltinCommand("new", "Start a new session.", "session", "essential", {
      modelIndependent: "always",
      acceptsArgs: true,
    }),
    defineBuiltinCommand("name", "Name or rename the current session.", "session", "standard", {
      modelIndependent: "always",
      args: [
        defineCommandArgument("title", "New session name (omit to see a suggestion)", {
          captureRemaining: true,
        }),
      ],
    }),
    defineBuiltinCommand("compact", "Compact the session context.", "session", "essential", {
      args: [
        defineCommandArgument("instructions", "Extra compaction instructions", {
          captureRemaining: true,
        }),
      ],
    }),
    defineBuiltinCommand("think", "Set thinking level.", "options", "essential", {
      modelIndependent: "always",
      textAliases: ["/think", "/thinking", "/t"],
      activeRunSafe: true,
      args: [
        defineCommandArgument("level", "Thinking level", {
          choices: ({ provider, model, catalog, agentRuntime }) =>
            listThinkingLevelChoices(provider, model, catalog, agentRuntime),
        }),
      ],
      argsMenu: "auto",
    }),
    defineBuiltinCommand("verbose", "Toggle verbose mode.", "options", "standard", {
      modelIndependent: "always",
      textAliases: ["/verbose", "/v"],
      args: [defineCommandArgument("mode", "on, off, or full", { choices: ["on", "off", "full"] })],
      argsMenu: "auto",
    }),
    defineBuiltinCommand("trace", "Toggle plugin trace lines.", "options", "power", {
      modelIndependent: "directive",
      args: [defineCommandArgument("mode", "on, off, or raw", { choices: ["on", "off", "raw"] })],
      argsMenu: "auto",
    }),
    defineBuiltinCommand("fast", "Toggle fast mode.", "options", "standard", {
      modelIndependent: "always",
      args: [
        defineCommandArgument("mode", "on, off, auto, default, or status", {
          choices: ({ cfg, provider, model }) => [
            "on",
            "off",
            {
              value: "auto",
              label: formatFastModeAutoLabel({
                fastAutoOnSeconds: resolveFastModeModelAutoOnSeconds({ cfg, provider, model }),
              }),
            },
            "default",
            "status",
          ],
        }),
      ],
      argsMenu: "auto",
    }),
    defineBuiltinCommand("reasoning", "Toggle reasoning visibility.", "options", "standard", {
      modelIndependent: "directive",
      textAliases: ["/reasoning", "/reason"],
      args: [
        defineCommandArgument("mode", "on, off, or stream", { choices: ["on", "off", "stream"] }),
      ],
      argsMenu: "auto",
    }),
    defineBuiltinCommand("elevated", "Toggle elevated mode.", "options", "power", {
      modelIndependent: "directive",
      textAliases: ["/elevated", "/elev"],
      args: [
        defineCommandArgument("mode", "on, off, ask, or full", {
          choices: ["on", "off", "ask", "full"],
        }),
      ],
      argsMenu: "auto",
    }),
    defineBuiltinCommand("exec", "Set exec defaults for this session.", "options", "power", {
      modelIndependent: "directive",
      args: [
        defineCommandArgument("host", "auto, sandbox, gateway, or node", {
          choices: ["auto", "sandbox", "gateway", "node"],
        }),
        defineCommandArgument("security", "deny, allowlist, or full", {
          choices: ["deny", "allowlist", "full"],
        }),
        defineCommandArgument("ask", "off, on-miss, or always", {
          choices: ["off", "on-miss", "always"],
        }),
        defineCommandArgument("node", "Node id or name"),
      ],
      argsParsing: "none",
      formatArgs: COMMAND_ARG_FORMATTERS.exec,
    }),
    defineBuiltinCommand(
      "model",
      "Show or set the model; use -s, -a, or -g to choose scope.",
      "options",
      "essential",
      {
        modelIndependent: "directive",
        args: [
          defineCommandArgument(
            "model",
            "Model id; add -s for session, -a for agent, or -g for global scope",
          ),
        ],
      },
    ),
    defineBuiltinCommand("models", "List model providers/models.", "options", "standard", {
      acceptsArgs: true,
      modelIndependent: "always",
    }),
    defineBuiltinCommand("queue", "Adjust queue settings.", "options", "power", {
      modelIndependent: "directive",
      args: [
        defineCommandArgument("mode", "queue mode", {
          choices: ["steer", "followup", "collect", "interrupt"],
        }),
        defineCommandArgument("debounce", "debounce duration (e.g. 500ms, 2s)"),
        defineCommandArgument("cap", "queue cap", { type: "number" }),
        defineCommandArgument("drop", "drop policy", { choices: ["old", "new", "summarize"] }),
      ],
      argsParsing: "none",
      formatArgs: COMMAND_ARG_FORMATTERS.queue,
    }),
    defineBuiltinCommand("bash", "Run host shell commands (host-only).", "tools", "power", {
      modelIndependent: "always",
      nativeName: false,
      args: [defineCommandArgument("command", "Shell command", { captureRemaining: true })],
    }),
  ];
  assertCommandRegistry(commands);
  return commands;
}
