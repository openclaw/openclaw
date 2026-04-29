// 钩子安装规范类型
export type HookInstallSpec = {
  id?: string;                // 安装 ID
  kind: "bundled" | "npm" | "git"; // 安装类型：捆绑、npm 或 git
  label?: string;            // 显示标签
  package?: string;           // 包名
  repository?: string;        // 仓库 URL
  bins?: string[];           // 可执行文件列表
};

// OpenClaw 钩子元数据类型
export type OpenClawHookMetadata = {
  always?: boolean;           // 是否始终运行
  hookKey?: string;          // 钩子键
  emoji?: string;            // 表情符号
  homepage?: string;          // 主页 URL
  /** 此钩子处理的事件（如 ["command:new", "session:start"]） */
  events: string[];
  /** 可选的导出名称（默认："default"） */
  export?: string;
  os?: string[];             // 支持的操作系统
  requires?: {
    bins?: string[];         // 需要的二进制文件
    anyBins?: string[];      // 任意二进制文件
    env?: string[];          // 需要的环境变量
    config?: string[];       // 需要的配置
  };
  install?: HookInstallSpec[]; // 安装规范
};

// 钩子调用策略
export type HookInvocationPolicy = {
  enabled: boolean;          // 是否启用
};

// 解析的钩子前置数据格式
export type ParsedHookFrontmatter = Record<string, string>;

// 钩子类型
export type Hook = {
  name: string;                              // 钩子名称
  description: string;                       // 描述
  source: "openclaw-bundled" | "openclaw-managed" | "openclaw-workspace" | "openclaw-plugin"; // 来源
  pluginId?: string;                         // 插件 ID（如果来源是插件）
  filePath: string;                          // HOOK.md 文件路径
  baseDir: string;                            // 包含钩子的目录
  handlerPath: string;                        // 处理器模块路径（handler.ts/js）
};

// 钩子来源类型
export type HookSource = Hook["source"];

// 钩子条目类型
export type HookEntry = {
  hook: Hook;                                // 钩子对象
  frontmatter: ParsedHookFrontmatter;        // 解析的前置数据
  metadata?: OpenClawHookMetadata;           // 可选的元数据
  invocation?: HookInvocationPolicy;         // 调用策略
};

// 钩子 eligibility 上下文
export type HookEligibilityContext = {
  remote?: {
    platforms: string[];                     // 平台列表
    hasBin: (bin: string) => boolean;       // 检查是否有二进制文件
    hasAnyBin: (bins: string[]) => boolean; // 检查是否有任意二进制文件
    note?: string;                          // 备注
  };
};

// 钩子快照类型
export type HookSnapshot = {
  hooks: Array<{ name: string; events: string[] }>; // 钩子名称和事件数组
  resolvedHooks?: Hook[];                      // 解析的钩子数组
  version?: number;                           // 版本号
};
