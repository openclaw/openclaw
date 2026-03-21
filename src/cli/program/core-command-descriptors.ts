export type CoreCliCommandDescriptor = {
  name: string;
  description: string;
  hasSubcommands: boolean;
};

export const CORE_CLI_COMMAND_DESCRIPTORS = [
  {
    name: "setup",
    description: "初始化本地配置和工作区 / Initialize local config and agent workspace",
    hasSubcommands: false,
  },
  {
    name: "onboard",
    description:
      "交互式入门向导（网关、工作区、技能）/ Interactive onboarding for gateway, workspace, and skills",
    hasSubcommands: false,
  },
  {
    name: "configure",
    description:
      "交互式配置向导（凭据、频道、网关）/ Interactive configuration for credentials, channels, gateway",
    hasSubcommands: false,
  },
  {
    name: "config",
    description: "配置管理（get/set/unset/file/validate）/ Non-interactive config helpers",
    hasSubcommands: true,
  },
  {
    name: "backup",
    description: "创建和验证本地备份 / Create and verify local backup archives",
    hasSubcommands: true,
  },
  {
    name: "doctor",
    description: "健康检查和快速修复 / Health checks + quick fixes for gateway and channels",
    hasSubcommands: false,
  },
  {
    name: "dashboard",
    description: "打开控制面板 / Open the Control UI with your current token",
    hasSubcommands: false,
  },
  {
    name: "reset",
    description: "重置本地配置和状态（保留 CLI）/ Reset local config/state (keeps CLI installed)",
    hasSubcommands: false,
  },
  {
    name: "uninstall",
    description:
      "卸载网关服务和本地数据（保留 CLI）/ Uninstall gateway service + local data (CLI remains)",
    hasSubcommands: false,
  },
  {
    name: "message",
    description: "发送、读取和管理消息 / Send, read, and manage messages",
    hasSubcommands: true,
  },
  {
    name: "memory",
    description: "搜索和重建索引记忆文件 / Search and reindex memory files",
    hasSubcommands: true,
  },
  {
    name: "agent",
    description: "通过网关运行一个代理回合 / Run one agent turn via the Gateway",
    hasSubcommands: false,
  },
  {
    name: "agents",
    description: "管理独立代理（工作区、认证、路由）/ Manage isolated agents",
    hasSubcommands: true,
  },
  {
    name: "status",
    description: "显示频道健康和最近会话 / Show channel health and recent sessions",
    hasSubcommands: false,
  },
  {
    name: "health",
    description: "获取运行中网关的健康状态 / Fetch health from running gateway",
    hasSubcommands: false,
  },
  {
    name: "sessions",
    description: "列出存储的会话 / List stored conversation sessions",
    hasSubcommands: true,
  },
  {
    name: "browser",
    description: "管理 OpenClaw 专用浏览器 / Manage OpenClaw's dedicated browser",
    hasSubcommands: true,
  },
] as const satisfies ReadonlyArray<CoreCliCommandDescriptor>;

export function getCoreCliCommandDescriptors(): ReadonlyArray<CoreCliCommandDescriptor> {
  return CORE_CLI_COMMAND_DESCRIPTORS;
}

export function getCoreCliCommandsWithSubcommands(): string[] {
  return CORE_CLI_COMMAND_DESCRIPTORS.filter((command) => command.hasSubcommands).map(
    (command) => command.name,
  );
}
