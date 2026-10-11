/** Shared command registry builders used by browser-safe and runtime command lists. */
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

function choiceMenu(
  name: string,
  description: string,
  choices: NonNullable<BuiltinCommandArgument["choices"]>,
): Pick<BuiltinCommandOptions, "args" | "argsMenu"> {
  return { args: [defineCommandArgument(name, description, { choices })], argsMenu: "auto" };
}

function freeformArgs(
  name: string,
  description: string,
  options: Pick<BuiltinCommandArgumentOptions, "required"> = {},
): Pick<BuiltinCommandOptions, "args"> {
  return {
    args: [defineCommandArgument(name, description, { ...options, captureRemaining: true })],
  };
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
    nativeAliases: options.nativeAliases,
    nativeProviders: options.nativeProviders,
    description,
    ...(options.descriptionLocalizations
      ? { descriptionLocalizations: options.descriptionLocalizations }
      : {}),
    acceptsArgs: options.acceptsArgs ?? Boolean(options.args?.length),
    args: options.args,
    argsParsing: options.argsParsing ?? (options.args?.length ? "positional" : "none"),
    formatArgs: options.formatArgs,
    argsMenu: options.argsMenu,
    textAliases: options.textAliases ?? [`/${key}`],
    scope: nativeName === false ? "text" : "both",
    category,
    tier,
    activeRunSafe: options.activeRunSafe,
    modelIndependent: options.modelIndependent,
  };
}

function definePathCommand(
  key: string,
  description: string,
  actions: string[],
  pathDescription: string,
  valueDescription?: string,
  textAliases?: string[],
): ChatCommandDefinition {
  const args = [
    defineCommandArgument("action", actions.join(" | "), { choices: actions }),
    defineCommandArgument("path", pathDescription),
  ];
  if (valueDescription) {
    args.push(defineCommandArgument("value", valueDescription, { captureRemaining: true }));
  }
  return defineBuiltinCommand(key, description, "management", "power", {
    modelIndependent: "always",
    textAliases,
    args,
    argsParsing: "none",
    formatArgs: COMMAND_ARG_FORMATTERS[key],
  });
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
  return [
    defineBuiltinCommand("help", "Show available commands.", "status", "essential", {
      activeRunSafe: true,
      modelIndependent: "always",
    }),
    defineBuiltinCommand("commands", "List all slash commands.", "status", "power", {
      activeRunSafe: true,
      modelIndependent: "no-args",
    }),
    defineBuiltinCommand("tools", "List available runtime tools.", "status", "standard", {
      activeRunSafe: true,
      modelIndependent: "always",
      ...choiceMenu("mode", "compact or verbose", ["compact", "verbose"]),
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
      freeformArgs("request", "Dashboard requirements"),
    ),
    defineBuiltinCommand(
      "learn",
      "Draft a reusable skill from recent work or named sources.",
      "tools",
      "standard",
      freeformArgs("request", "Sources and requirements for the skill draft"),
    ),
    defineBuiltinCommand(
      "loop",
      "Loop a prompt: /loop [interval] <prompt> | /loop status | /loop stop [name]",
      "tools",
      "standard",
      {
        modelIndependent: (args) => !args || args.toLowerCase() === "help",
        ...freeformArgs("spec", "[interval] prompt, or status/stop", { required: false }),
      },
    ),
    defineBuiltinCommand("status", "Show current status.", "status", "essential", {
      acceptsArgs: true,
      activeRunSafe: true,
      modelIndependent: "always",
    }),
    defineBuiltinCommand("goal", "Show or control the current goal.", "status", "standard", {
      modelIndependent: (args) => {
        const parsed = parseSlashCommandOrNull(`/goal ${args}`, "/goal", "status");
        return (
          parsed !== null &&
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
        ...freeformArgs("note", "Optional note for Codex feedback upload"),
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
    defineBuiltinCommand("allowlist", "List/add/remove allowlist entries.", "management", "power", {
      modelIndependent: "always",
      nativeName: false,
      acceptsArgs: true,
    }),
    defineBuiltinCommand("approve", "Approve or deny exec requests.", "management", "power", {
      acceptsArgs: true,
      activeRunSafe: true,
      modelIndependent: "always",
    }),
    defineBuiltinCommand(
      "context",
      "Explain how context is built and used.",
      "status",
      "standard",
      { acceptsArgs: true, activeRunSafe: true, modelIndependent: "always" },
    ),
    defineBuiltinCommand(
      "btw",
      "Ask a side question without changing future session context.",
      "tools",
      "standard",
      {
        activeRunSafe: true,
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
      activeRunSafe: true,
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
        activeRunSafe: true,
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
        const parsed = parseSlashCommandOrNull(`/acp ${args}`, "/acp", "help");
        return parsed !== null && (parsed.action !== "steer" || !parsed.args);
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
      { activeRunSafe: true, modelIndependent: "always" },
    ),
    defineBuiltinCommand(
      "steer",
      "Send guidance to the active run in this session.",
      "management",
      "standard",
      {
        modelIndependent: "no-args",
        textAliases: ["/steer", "/tell"],
        ...freeformArgs("message", "Steering message"),
      },
    ),
    definePathCommand(
      "config",
      "Show or set config values.",
      ["show", "get", "set", "unset"],
      "Config path",
      "Value for set",
    ),
    definePathCommand(
      "mcp",
      "Show or set OpenClaw MCP servers.",
      ["show", "get", "set", "unset"],
      "MCP server name",
      "JSON config for set",
    ),
    definePathCommand(
      "plugins",
      "List, show, enable, or disable plugins.",
      ["list", "show", "get", "enable", "disable"],
      "Plugin id or name",
      undefined,
      ["/plugins", "/plugin"],
    ),
    definePathCommand(
      "debug",
      "Set runtime debug overrides.",
      ["show", "reset", "set", "unset"],
      "Debug path",
      "Value for set",
    ),
    defineBuiltinCommand("usage", "Usage footer or cost summary.", "options", "standard", {
      modelIndependent: "always",
      ...choiceMenu("mode", "off, tokens, full, or cost", ["off", "tokens", "full", "cost"]),
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
      ...choiceMenu("mode", "mention or always", ["mention", "always"]),
    }),
    defineBuiltinCommand("send", "Set send policy.", "management", "power", {
      modelIndependent: (args) => parseSendPolicyCommandBody(`/send ${args}`).hasCommand,
      ...choiceMenu("mode", "on, off, or inherit", ["on", "off", "inherit"]),
    }),
    // Reset handlers must reach lifecycle cleanup before waiting on the work they interrupt.
    defineBuiltinCommand("reset", "Reset the current session.", "session", "essential", {
      activeRunSafe: true,
      acceptsArgs: true,
    }),
    defineBuiltinCommand("new", "Start a new session.", "session", "essential", {
      activeRunSafe: true,
      modelIndependent: "always",
      acceptsArgs: true,
    }),
    defineBuiltinCommand("name", "Name or rename the current session.", "session", "standard", {
      modelIndependent: "always",
      ...freeformArgs("title", "New session name (omit to see a suggestion)"),
    }),
    defineBuiltinCommand(
      "compact",
      "Compact the session context.",
      "session",
      "essential",
      freeformArgs("instructions", "Extra compaction instructions"),
    ),
    defineBuiltinCommand("think", "Set thinking level.", "options", "essential", {
      modelIndependent: "always",
      textAliases: ["/think", "/thinking", "/t"],
      activeRunSafe: true,
      ...choiceMenu("level", "Thinking level", ({ provider, model, catalog, agentRuntime }) =>
        listThinkingLevelChoices(provider, model, catalog, agentRuntime),
      ),
    }),
    defineBuiltinCommand("verbose", "Toggle verbose mode.", "options", "standard", {
      modelIndependent: "always",
      textAliases: ["/verbose", "/v"],
      ...choiceMenu("mode", "on, off, or full", ["on", "off", "full"]),
    }),
    defineBuiltinCommand("trace", "Toggle plugin trace lines.", "options", "power", {
      modelIndependent: "directive",
      ...choiceMenu("mode", "on, off, or raw", ["on", "off", "raw"]),
    }),
    defineBuiltinCommand("fast", "Toggle fast mode.", "options", "standard", {
      modelIndependent: "always",
      ...choiceMenu(
        "mode",
        "on, off, ultrafast, auto, default, or status",
        // Generic command menus have no authenticated account-tier facts for offering Ultrafast.
        ({ cfg, provider, model }) => [
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
      ),
    }),
    defineBuiltinCommand("reasoning", "Toggle reasoning visibility.", "options", "standard", {
      modelIndependent: "directive",
      textAliases: ["/reasoning", "/reason"],
      ...choiceMenu("mode", "on, off, or stream", ["on", "off", "stream"]),
    }),
    defineBuiltinCommand("elevated", "Toggle elevated mode.", "options", "power", {
      modelIndependent: "directive",
      textAliases: ["/elevated", "/elev"],
      ...choiceMenu("mode", "on, off, ask, or full", ["on", "off", "ask", "full"]),
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
      activeRunSafe: true,
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
      ...freeformArgs("command", "Shell command"),
    }),
  ];
}
