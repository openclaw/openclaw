export type SubCliDescriptor = {
  name: string;
  description: string;
  hasSubcommands: boolean;
};

export const SUB_CLI_DESCRIPTORS = [
  {
    name: "acp",
    description: "代理控制协议工具 / Agent Control Protocol tools",
    hasSubcommands: true,
  },
  {
    name: "gateway",
    description: "运行、检查和查询 WebSocket 网关 / Run, inspect, and query the WebSocket Gateway",
    hasSubcommands: true,
  },
  {
    name: "daemon",
    description: "网关服务（旧别名）/ Gateway service (legacy alias)",
    hasSubcommands: true,
  },
  {
    name: "logs",
    description: "通过 RPC 查看网关日志 / Tail gateway file logs via RPC",
    hasSubcommands: false,
  },
  {
    name: "system",
    description: "系统事件、心跳和在线状态 / System events, heartbeat, and presence",
    hasSubcommands: true,
  },
  {
    name: "models",
    description: "发现、扫描和配置模型 / Discover, scan, and configure models",
    hasSubcommands: true,
  },
  {
    name: "approvals",
    description: "管理执行审批 / Manage exec approvals",
    hasSubcommands: true,
  },
  {
    name: "nodes",
    description: "管理节点配对和命令 / Manage node pairing and commands",
    hasSubcommands: true,
  },
  {
    name: "devices",
    description: "设备配对和令牌管理 / Device pairing + token management",
    hasSubcommands: true,
  },
  {
    name: "node",
    description: "运行和管理无头节点服务 / Run and manage headless node host service",
    hasSubcommands: true,
  },
  {
    name: "sandbox",
    description: "管理沙箱容器 / Manage sandbox containers for agent isolation",
    hasSubcommands: true,
  },
  {
    name: "tui",
    description: "打开终端 UI 连接到网关 / Open terminal UI connected to Gateway",
    hasSubcommands: false,
  },
  {
    name: "cron",
    description: "管理定时任务 / Manage cron jobs via Gateway scheduler",
    hasSubcommands: true,
  },
  {
    name: "dns",
    description: "DNS 辅助工具（Tailscale + CoreDNS）/ DNS helpers for discovery",
    hasSubcommands: true,
  },
  {
    name: "docs",
    description: "搜索在线文档 / Search the live OpenClaw docs",
    hasSubcommands: false,
  },
  {
    name: "hooks",
    description: "管理内部代理钩子 / Manage internal agent hooks",
    hasSubcommands: true,
  },
  {
    name: "webhooks",
    description: "Webhook 辅助和集成 / Webhook helpers and integrations",
    hasSubcommands: true,
  },
  {
    name: "qr",
    description: "生成 iOS 配对二维码 / Generate iOS pairing QR/setup code",
    hasSubcommands: false,
  },
  {
    name: "clawbot",
    description: "旧版 clawbot 命令别名 / Legacy clawbot command aliases",
    hasSubcommands: true,
  },
  {
    name: "pairing",
    description: "安全配对（批准入站请求）/ Secure DM pairing",
    hasSubcommands: true,
  },
  {
    name: "plugins",
    description: "管理插件和扩展 / Manage OpenClaw plugins and extensions",
    hasSubcommands: true,
  },
  {
    name: "channels",
    description: "管理聊天频道（Telegram、Discord 等）/ Manage chat channels",
    hasSubcommands: true,
  },
  {
    name: "directory",
    description: "查找联系人和群组 ID / Lookup contact and group IDs",
    hasSubcommands: true,
  },
  {
    name: "security",
    description: "安全工具和本地配置审计 / Security tools and local config audits",
    hasSubcommands: true,
  },
  {
    name: "secrets",
    description: "密钥运行时重载控制 / Secrets runtime reload controls",
    hasSubcommands: true,
  },
  {
    name: "skills",
    description: "列出和检查可用技能 / List and inspect available skills",
    hasSubcommands: true,
  },
  {
    name: "update",
    description: "更新 OpenClaw / Update OpenClaw and check channel status",
    hasSubcommands: true,
  },
  {
    name: "completion",
    description: "生成 shell 补全脚本 / Generate shell completion script",
    hasSubcommands: false,
  },
] as const satisfies ReadonlyArray<SubCliDescriptor>;

export function getSubCliEntries(): ReadonlyArray<SubCliDescriptor> {
  return SUB_CLI_DESCRIPTORS;
}

export function getSubCliCommandsWithSubcommands(): string[] {
  return SUB_CLI_DESCRIPTORS.filter((entry) => entry.hasSubcommands).map((entry) => entry.name);
}
