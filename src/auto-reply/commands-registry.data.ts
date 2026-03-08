import { listChannelDocks } from "../channels/dock.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { COMMAND_ARG_FORMATTERS } from "./commands-args.js";
import type {
  ChatCommandDefinition,
  CommandCategory,
  CommandScope,
} from "./commands-registry.types.js";
import { listThinkingLevels } from "./thinking.js";

type DefineChatCommandInput = {
  key: string;
  nativeName?: string;
  description: string;
  args?: ChatCommandDefinition["args"];
  argsParsing?: ChatCommandDefinition["argsParsing"];
  formatArgs?: ChatCommandDefinition["formatArgs"];
  argsMenu?: ChatCommandDefinition["argsMenu"];
  acceptsArgs?: boolean;
  textAlias?: string;
  textAliases?: string[];
  scope?: CommandScope;
  category?: CommandCategory;
};

function defineChatCommand(command: DefineChatCommandInput): ChatCommandDefinition {
  const aliases = (command.textAliases ?? (command.textAlias ? [command.textAlias] : []))
    .map((alias) => alias.trim())
    .filter(Boolean);
  const scope =
    command.scope ?? (command.nativeName ? (aliases.length ? "both" : "native") : "text");
  const acceptsArgs = command.acceptsArgs ?? Boolean(command.args?.length);
  const argsParsing = command.argsParsing ?? (command.args?.length ? "positional" : "none");
  return {
    key: command.key,
    nativeName: command.nativeName,
    description: command.description,
    acceptsArgs,
    args: command.args,
    argsParsing,
    formatArgs: command.formatArgs,
    argsMenu: command.argsMenu,
    textAliases: aliases,
    scope,
    category: command.category,
  };
}

type ChannelDock = ReturnType<typeof listChannelDocks>[number];

function defineDockCommand(dock: ChannelDock): ChatCommandDefinition {
  return defineChatCommand({
    key: `dock:${dock.id}`,
    nativeName: `dock_${dock.id}`,
    description: `Switch to ${dock.id} for replies.`,
    textAliases: [`/dock-${dock.id}`, `/dock_${dock.id}`],
    category: "docks",
  });
}

function registerAlias(commands: ChatCommandDefinition[], key: string, ...aliases: string[]): void {
  const command = commands.find((entry) => entry.key === key);
  if (!command) {
    throw new Error(`registerAlias: unknown command key: ${key}`);
  }
  const existing = new Set(command.textAliases.map((alias) => alias.trim().toLowerCase()));
  for (const alias of aliases) {
    const trimmed = alias.trim();
    if (!trimmed) {
      continue;
    }
    const lowered = trimmed.toLowerCase();
    if (existing.has(lowered)) {
      continue;
    }
    existing.add(lowered);
    command.textAliases.push(trimmed);
  }
}

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
      if (command.textAliases.length === 0) {
        throw new Error(`Text-only command missing text alias: ${command.key}`);
      }
    } else if (!nativeName) {
      throw new Error(`Native command missing native name: ${command.key}`);
    } else {
      const nativeKey = nativeName.toLowerCase();
      if (nativeNames.has(nativeKey)) {
        throw new Error(`Duplicate native command: ${nativeName}`);
      }
      nativeNames.add(nativeKey);
    }

    if (command.scope === "native" && command.textAliases.length > 0) {
      throw new Error(`Native-only command has text aliases: ${command.key}`);
    }

    for (const alias of command.textAliases) {
      if (!alias.startsWith("/")) {
        throw new Error(`Command alias missing leading '/': ${alias}`);
      }
      const aliasKey = alias.toLowerCase();
      if (textAliases.has(aliasKey)) {
        throw new Error(`Duplicate command alias: ${alias}`);
      }
      textAliases.add(aliasKey);
    }
  }
}

let cachedCommands: ChatCommandDefinition[] | null = null;
let cachedRegistry: ReturnType<typeof getActivePluginRegistry> | null = null;
let cachedNativeCommandSurfaces: Set<string> | null = null;
let cachedNativeRegistry: ReturnType<typeof getActivePluginRegistry> | null = null;

function buildChatCommands(): ChatCommandDefinition[] {
  const commands: ChatCommandDefinition[] = [
    defineChatCommand({
      key: "help",
      nativeName: "help",
      description: "显示可用命令",
      textAlias: "/help",
      category: "status",
    }),
    defineChatCommand({
      key: "commands",
      nativeName: "commands",
      description: "列出所有斜杠命令",
      textAlias: "/commands",
      category: "status",
    }),
    defineChatCommand({
      key: "skill",
      nativeName: "skill",
      description: "按名称运行技能",
      textAlias: "/skill",
      category: "tools",
      args: [
        {
          name: "name",
          description: "技能名称",
          type: "string",
          required: true,
        },
        {
          name: "input",
          description: "技能输入",
          type: "string",
          captureRemaining: true,
        },
      ],
    }),
    defineChatCommand({
      key: "status",
      nativeName: "status",
      description: "显示当前状态",
      textAlias: "/status",
      category: "status",
    }),
    defineChatCommand({
      key: "allowlist",
      description: "列出/添加/删除白名单条目",
      textAlias: "/allowlist",
      acceptsArgs: true,
      scope: "text",
      category: "management",
    }),
    defineChatCommand({
      key: "approve",
      nativeName: "approve",
      description: "批准或拒绝执行请求",
      textAlias: "/approve",
      acceptsArgs: true,
      category: "management",
    }),
    defineChatCommand({
      key: "context",
      nativeName: "context",
      description: "解释上下文的构建和使用方式",
      textAlias: "/context",
      acceptsArgs: true,
      category: "status",
    }),
    defineChatCommand({
      key: "export-session",
      nativeName: "export-session",
      description: "将当前会话导出为 HTML 文件（含完整系统提示）",
      textAliases: ["/export-session", "/export"],
      acceptsArgs: true,
      category: "status",
      args: [
        {
          name: "path",
          description: "输出路径（默认：workspace）",
          type: "string",
          required: false,
        },
      ],
    }),
    defineChatCommand({
      key: "tts",
      nativeName: "tts",
      description: "控制文字转语音 (TTS)",
      textAlias: "/tts",
      category: "media",
      args: [
        {
          name: "action",
          description: "TTS 操作",
          type: "string",
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
        },
        {
          name: "value",
          description: "提供商、限制或文本",
          type: "string",
          captureRemaining: true,
        },
      ],
      argsMenu: {
        arg: "action",
        title:
          "TTS Actions:\n" +
          "• On – Enable TTS for responses\n" +
          "• Off – Disable TTS\n" +
          "• Status – Show current settings\n" +
          "• Provider – Set voice provider (edge, elevenlabs, openai)\n" +
          "• Limit – Set max characters for TTS\n" +
          "• Summary – Toggle AI summary for long texts\n" +
          "• Audio – Generate TTS from custom text\n" +
          "• Help – Show usage guide",
      },
    }),
    defineChatCommand({
      key: "whoami",
      nativeName: "whoami",
      description: "显示你的发送者 ID",
      textAlias: "/whoami",
      category: "status",
    }),
    defineChatCommand({
      key: "session",
      nativeName: "session",
      description: "管理会话级设置",
      textAlias: "/session",
      category: "session",
      args: [
        {
          name: "action",
          description: "idle | max-age",
          type: "string",
          choices: ["idle", "max-age"],
        },
        {
          name: "value",
          description: "时长（24h, 90m）或关闭",
          type: "string",
          captureRemaining: true,
        },
      ],
      argsMenu: "auto",
    }),
    defineChatCommand({
      key: "subagents",
      nativeName: "subagents",
      description: "列出、终止、记录、生成或引导当前会话的子代理运行",
      textAlias: "/subagents",
      category: "management",
      args: [
        {
          name: "action",
          description: "list | kill | log | info | send | steer | spawn",
          type: "string",
          choices: ["list", "kill", "log", "info", "send", "steer", "spawn"],
        },
        {
          name: "target",
          description: "运行 ID、索引或会话密钥",
          type: "string",
        },
        {
          name: "value",
          description: "附加输入（限制/消息）",
          type: "string",
          captureRemaining: true,
        },
      ],
      argsMenu: "auto",
    }),
    defineChatCommand({
      key: "acp",
      nativeName: "acp",
      description: "管理 ACP 会话和运行时选项",
      textAlias: "/acp",
      category: "management",
      args: [
        {
          name: "action",
          description: "要执行的操作",
          type: "string",
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
        },
        {
          name: "value",
          description: "操作参数",
          type: "string",
          captureRemaining: true,
        },
      ],
      argsMenu: "auto",
    }),
    defineChatCommand({
      key: "focus",
      nativeName: "focus",
      description:
        "Bind this thread (Discord) or topic/conversation (Telegram) to a session target.",
      textAlias: "/focus",
      category: "management",
      args: [
        {
          name: "target",
          description: "子代理标签/索引或会话密钥/ID/标签",
          type: "string",
          captureRemaining: true,
        },
      ],
    }),
    defineChatCommand({
      key: "unfocus",
      nativeName: "unfocus",
      description: "移除当前线程（Discord）或主题/对话（Telegram）绑定",
      textAlias: "/unfocus",
      category: "management",
    }),
    defineChatCommand({
      key: "agents",
      nativeName: "agents",
      description: "列出当前会话的线程绑定代理",
      textAlias: "/agents",
      category: "management",
    }),
    defineChatCommand({
      key: "kill",
      nativeName: "kill",
      description: "终止正在运行的子代理（或全部）",
      textAlias: "/kill",
      category: "management",
      args: [
        {
          name: "target",
          description: "标签、运行 ID、索引或全部",
          type: "string",
        },
      ],
      argsMenu: "auto",
    }),
    defineChatCommand({
      key: "steer",
      nativeName: "steer",
      description: "向正在运行的子代理发送指导",
      textAlias: "/steer",
      category: "management",
      args: [
        {
          name: "target",
          description: "标签、运行 ID 或索引",
          type: "string",
        },
        {
          name: "message",
          description: "指导消息",
          type: "string",
          captureRemaining: true,
        },
      ],
    }),
    defineChatCommand({
      key: "config",
      nativeName: "config",
      description: "显示或设置配置值",
      textAlias: "/config",
      category: "management",
      args: [
        {
          name: "action",
          description: "show | get | set | unset",
          type: "string",
          choices: ["show", "get", "set", "unset"],
        },
        {
          name: "path",
          description: "配置路径",
          type: "string",
        },
        {
          name: "value",
          description: "设置的值",
          type: "string",
          captureRemaining: true,
        },
      ],
      argsParsing: "none",
      formatArgs: COMMAND_ARG_FORMATTERS.config,
    }),
    defineChatCommand({
      key: "debug",
      nativeName: "debug",
      description: "设置运行时调试覆盖",
      textAlias: "/debug",
      category: "management",
      args: [
        {
          name: "action",
          description: "show | reset | set | unset",
          type: "string",
          choices: ["show", "reset", "set", "unset"],
        },
        {
          name: "path",
          description: "调试路径",
          type: "string",
        },
        {
          name: "value",
          description: "设置的值",
          type: "string",
          captureRemaining: true,
        },
      ],
      argsParsing: "none",
      formatArgs: COMMAND_ARG_FORMATTERS.debug,
    }),
    defineChatCommand({
      key: "usage",
      nativeName: "usage",
      description: "用量摘要或费用统计",
      textAlias: "/usage",
      category: "options",
      args: [
        {
          name: "mode",
          description: "off, tokens, full 或 cost",
          type: "string",
          choices: ["off", "tokens", "full", "cost"],
        },
      ],
      argsMenu: "auto",
    }),
    defineChatCommand({
      key: "stop",
      nativeName: "stop",
      description: "停止当前运行",
      textAlias: "/stop",
      category: "session",
    }),
    defineChatCommand({
      key: "restart",
      nativeName: "restart",
      description: "重启 OpenClaw",
      textAlias: "/restart",
      category: "tools",
    }),
    defineChatCommand({
      key: "activation",
      nativeName: "activation",
      description: "设置群组激活模式",
      textAlias: "/activation",
      category: "management",
      args: [
        {
          name: "mode",
          description: "mention 或 always",
          type: "string",
          choices: ["mention", "always"],
        },
      ],
      argsMenu: "auto",
    }),
    defineChatCommand({
      key: "send",
      nativeName: "send",
      description: "设置发送策略",
      textAlias: "/send",
      category: "management",
      args: [
        {
          name: "mode",
          description: "on, off 或 inherit",
          type: "string",
          choices: ["on", "off", "inherit"],
        },
      ],
      argsMenu: "auto",
    }),
    defineChatCommand({
      key: "reset",
      nativeName: "reset",
      description: "重置当前会话",
      textAlias: "/reset",
      acceptsArgs: true,
      category: "session",
    }),
    defineChatCommand({
      key: "new",
      nativeName: "new",
      description: "开始新会话",
      textAlias: "/new",
      acceptsArgs: true,
      category: "session",
    }),
    defineChatCommand({
      key: "compact",
      nativeName: "compact",
      description: "压缩会话上下文",
      textAlias: "/compact",
      category: "session",
      args: [
        {
          name: "instructions",
          description: "额外压缩指令",
          type: "string",
          captureRemaining: true,
        },
      ],
    }),
    defineChatCommand({
      key: "think",
      nativeName: "think",
      description: "设置思考级别",
      textAlias: "/think",
      category: "options",
      args: [
        {
          name: "level",
          description: "off, minimal, low, medium, high, xhigh",
          type: "string",
          choices: ({ provider, model }) => listThinkingLevels(provider, model),
        },
      ],
      argsMenu: "auto",
    }),
    defineChatCommand({
      key: "verbose",
      nativeName: "verbose",
      description: "切换详细模式",
      textAlias: "/verbose",
      category: "options",
      args: [
        {
          name: "mode",
          description: "on 或 off",
          type: "string",
          choices: ["on", "off"],
        },
      ],
      argsMenu: "auto",
    }),
    defineChatCommand({
      key: "reasoning",
      nativeName: "reasoning",
      description: "切换推理可见性",
      textAlias: "/reasoning",
      category: "options",
      args: [
        {
          name: "mode",
          description: "on, off 或 stream",
          type: "string",
          choices: ["on", "off", "stream"],
        },
      ],
      argsMenu: "auto",
    }),
    defineChatCommand({
      key: "elevated",
      nativeName: "elevated",
      description: "切换提升权限模式",
      textAlias: "/elevated",
      category: "options",
      args: [
        {
          name: "mode",
          description: "on, off, ask 或 full",
          type: "string",
          choices: ["on", "off", "ask", "full"],
        },
      ],
      argsMenu: "auto",
    }),
    defineChatCommand({
      key: "exec",
      nativeName: "exec",
      description: "设置当前会话的执行默认值",
      textAlias: "/exec",
      category: "options",
      args: [
        {
          name: "host",
          description: "sandbox, gateway 或 node",
          type: "string",
          choices: ["sandbox", "gateway", "node"],
        },
        {
          name: "security",
          description: "deny, allowlist 或 full",
          type: "string",
          choices: ["deny", "allowlist", "full"],
        },
        {
          name: "ask",
          description: "off, on-miss 或 always",
          type: "string",
          choices: ["off", "on-miss", "always"],
        },
        {
          name: "node",
          description: "节点 ID 或名称",
          type: "string",
        },
      ],
      argsParsing: "none",
      formatArgs: COMMAND_ARG_FORMATTERS.exec,
    }),
    defineChatCommand({
      key: "model",
      nativeName: "model",
      description: "显示或设置模型",
      textAlias: "/model",
      category: "options",
      args: [
        {
          name: "model",
          description: "模型 ID（provider/model 或 id）",
          type: "string",
        },
      ],
    }),
    defineChatCommand({
      key: "models",
      nativeName: "models",
      description: "列出模型提供商或提供商模型",
      textAlias: "/models",
      argsParsing: "none",
      acceptsArgs: true,
      category: "options",
    }),
    defineChatCommand({
      key: "queue",
      nativeName: "queue",
      description: "调整队列设置",
      textAlias: "/queue",
      category: "options",
      args: [
        {
          name: "mode",
          description: "队列模式",
          type: "string",
          choices: ["steer", "interrupt", "followup", "collect", "steer-backlog"],
        },
        {
          name: "debounce",
          description: "防抖时长（如 500ms, 2s）",
          type: "string",
        },
        {
          name: "cap",
          description: "队列上限",
          type: "number",
        },
        {
          name: "drop",
          description: "丢弃策略",
          type: "string",
          choices: ["old", "new", "summarize"],
        },
      ],
      argsParsing: "none",
      formatArgs: COMMAND_ARG_FORMATTERS.queue,
    }),
    defineChatCommand({
      key: "bash",
      description: "运行主机 shell 命令（仅主机）",
      textAlias: "/bash",
      scope: "text",
      category: "tools",
      args: [
        {
          name: "command",
          description: "Shell 命令",
          type: "string",
          captureRemaining: true,
        },
      ],
    }),
    ...listChannelDocks()
      .filter((dock) => dock.capabilities.nativeCommands)
      .map((dock) => defineDockCommand(dock)),
  ];

  registerAlias(commands, "whoami", "/id");
  registerAlias(commands, "think", "/thinking", "/t");
  registerAlias(commands, "verbose", "/v");
  registerAlias(commands, "reasoning", "/reason");
  registerAlias(commands, "elevated", "/elev");
  registerAlias(commands, "steer", "/tell");

  assertCommandRegistry(commands);
  return commands;
}

export function getChatCommands(): ChatCommandDefinition[] {
  const registry = getActivePluginRegistry();
  if (cachedCommands && registry === cachedRegistry) {
    return cachedCommands;
  }
  const commands = buildChatCommands();
  cachedCommands = commands;
  cachedRegistry = registry;
  cachedNativeCommandSurfaces = null;
  return commands;
}

export function getNativeCommandSurfaces(): Set<string> {
  const registry = getActivePluginRegistry();
  if (cachedNativeCommandSurfaces && registry === cachedNativeRegistry) {
    return cachedNativeCommandSurfaces;
  }
  cachedNativeCommandSurfaces = new Set(
    listChannelDocks()
      .filter((dock) => dock.capabilities.nativeCommands)
      .map((dock) => dock.id),
  );
  cachedNativeRegistry = registry;
  return cachedNativeCommandSurfaces;
}
