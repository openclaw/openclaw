// 命令别名映射 - 支持中英文命令 / Command alias mapping - supports Chinese and English commands

/**
 * 命令别名映射表 / Command alias mapping table
 * 将中文命令映射到英文命令 / Maps Chinese commands to English commands
 */
export const COMMAND_ALIASES: Record<string, string> = {
  // 网关相关命令 / Gateway related commands
  网关: "gateway",
  启动: "start",
  停止: "stop",
  重启: "restart",

  // 配置相关命令 / Configuration related commands
  配置: "config",

  // 诊断命令 / Diagnostic commands
  诊断: "doctor",

  // 帮助命令 / Help command
  帮助: "help",

  // 其他常用命令 / Other common commands
  状态: "status",
  健康检查: "health",
  模型: "models",
  会话: "sessions",
  代理: "agent",
  内存: "memory",
};

/**
 * 选项别名映射表 / Option alias mapping table
 * 将中文选项映射到英文选项 / Maps Chinese options to English options
 */
export const OPTION_ALIASES: Record<string, string> = {
  // 端口选项 / Port option
  "--端口": "--port",

  // 主机选项 / Host option
  "--主机": "--host",

  // 令牌选项 / Token option
  "--令牌": "--token",

  // 详细输出选项 / Verbose output option
  "--详细": "--verbose",

  // 帮助选项 / Help option
  "--帮助": "--help",

  // 其他常用选项 / Other common options
  "--版本": "--version",
  "--配置": "--config",
  "--调试": "--debug",
  "--输出": "--output",
  "--格式": "--format",
  "--环境": "--env",
};

/**
 * 规范化命令名称 / Normalize command name
 * 将中文命令转换为英文命令，如果找不到映射则返回原命令
 * Converts Chinese command to English, returns original if no mapping found
 *
 * @param command - 原始命令名称 / Original command name
 * @returns 规范化后的命令名称 / Normalized command name
 *
 * @example
 * normalizeCommand('网关') // 返回 'gateway'
 * normalizeCommand('gateway') // 返回 'gateway'
 */
export function normalizeCommand(command: string): string {
  return COMMAND_ALIASES[command] ?? command;
}

/**
 * 规范化选项名称 / Normalize option name
 * 将中文选项转换为英文选项，如果找不到映射则返回原选项
 * Converts Chinese option to English, returns original if no mapping found
 *
 * @param option - 原始选项名称 / Original option name
 * @returns 规范化后的选项名称 / Normalized option name
 *
 * @example
 * normalizeOption('--端口') // 返回 '--port'
 * normalizeOption('--port') // 返回 '--port'
 */
export function normalizeOption(option: string): string {
  // 处理带等号的选项，如 --端口=8080 / Handle options with equals sign, e.g., --端口=8080
  const equalsIndex = option.indexOf("=");
  if (equalsIndex !== -1) {
    const optionName = option.slice(0, equalsIndex);
    const optionValue = option.slice(equalsIndex);
    const normalizedOptionName = OPTION_ALIASES[optionName] ?? optionName;
    return `${normalizedOptionName}${optionValue}`;
  }

  return OPTION_ALIASES[option] ?? option;
}

/**
 * 规范化参数数组 / Normalize argument array
 * 将命令行参数中的中文命令和选项转换为英文
 * Converts Chinese commands and options in command line arguments to English
 *
 * @param args - 原始参数数组 / Original argument array
 * @returns 规范化后的参数数组 / Normalized argument array
 *
 * @example
 * normalizeArgs(['openclaw', '网关', '启动', '--端口', '8080'])
 * // 返回 ['openclaw', 'gateway', 'start', '--port', '8080']
 */
export function normalizeArgs(args: string[]): string[] {
  return args.map((arg, index) => {
    // 第一个参数是程序路径，不处理 / First argument is program path, skip it
    if (index === 0) {
      return arg;
    }

    // 如果是选项（以 - 开头），使用选项规范化 / If it's an option (starts with -), use option normalization
    if (arg.startsWith("-")) {
      return normalizeOption(arg);
    }

    // 否则作为命令处理 / Otherwise treat as command
    return normalizeCommand(arg);
  });
}

/**
 * 检查是否为中文命令 / Check if it's a Chinese command
 *
 * @param command - 命令名称 / Command name
 * @returns 是否为中文命令 / Whether it's a Chinese command
 */
export function isChineseCommand(command: string): boolean {
  return command in COMMAND_ALIASES;
}

/**
 * 检查是否为中文选项 / Check if it's a Chinese option
 *
 * @param option - 选项名称 / Option name
 * @returns 是否为中文选项 / Whether it's a Chinese option
 */
export function isChineseOption(option: string): boolean {
  const optionName = option.includes("=") ? option.slice(0, option.indexOf("=")) : option;
  return optionName in OPTION_ALIASES;
}
