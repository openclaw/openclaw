import { CHANNEL_IDS } from "../channels/registry.js";
import { VERSION } from "../version.js";
import { OpenClawSchema } from "./zod-schema.js";

export type ConfigUiHint = {
  label?: string;
  help?: string;
  group?: string;
  order?: number;
  advanced?: boolean;
  sensitive?: boolean;
  placeholder?: string;
  itemTemplate?: unknown;
};

export type ConfigUiHints = Record<string, ConfigUiHint>;

export type ConfigSchema = ReturnType<typeof OpenClawSchema.toJSONSchema>;

type JsonSchemaNode = Record<string, unknown>;

export type ConfigSchemaResponse = {
  schema: ConfigSchema;
  uiHints: ConfigUiHints;
  version: string;
  generatedAt: string;
};

export type PluginUiMetadata = {
  id: string;
  name?: string;
  description?: string;
  configUiHints?: Record<
    string,
    Pick<ConfigUiHint, "label" | "help" | "advanced" | "sensitive" | "placeholder">
  >;
  configSchema?: JsonSchemaNode;
};

export type ChannelUiMetadata = {
  id: string;
  label?: string;
  description?: string;
  configSchema?: JsonSchemaNode;
  configUiHints?: Record<string, ConfigUiHint>;
};

type ConfigLocale = "en" | "zh-CN";

function normalizeConfigLocale(locale?: string | null): ConfigLocale {
  return locale === "zh-CN" ? "zh-CN" : "en";
}

function normalizeHintKey(key: string): string {
  return key.replace(/\[\]/g, ".*");
}

const AUTO_LABEL_MAP: Record<string, string> = {
  // Common full segments
  defaults: "默认设置",
  list: "列表",
  model: "模型",
  models: "模型",
  imageModel: "图像模型",
  fallbacks: "回退",
  memorySearch: "记忆搜索",
  memory: "记忆",
  contextPruning: "上下文裁剪",
  compaction: "压缩",
  humanDelay: "人类延迟",
  blockStreaming: "阻塞流",
  blockStreamingChunk: "阻塞流分片",
  blockStreamingCoalesce: "阻塞流合并",
  heartbeat: "心跳",
  sandbox: "沙箱",
  docker: "Docker",
  browser: "浏览器",
  subagents: "子代理",
  tools: "工具",
  commands: "命令",
  hooks: "钩子",
  sessions: "会话",
  auth: "认证",
  bindings: "绑定",
  approvals: "审批",
  plugins: "插件",
  gateway: "网关",
  diagnostics: "诊断",
  logging: "日志",
  ui: "界面",
  nodeHost: "节点主机",
  discovery: "发现",
  broadcast: "广播",
  talk: "语音",
  wizard: "向导",
  canvasHost: "画布主机",
  web: "Web",
  env: "环境",
  media: "媒体",
  skills: "技能",
  modelsConfig: "模型配置",
  defaultsConfig: "默认配置",
  config: "配置",
  settings: "设置",
  // Common leaf segments
  enabled: "启用",
  name: "名称",
  id: "ID",
  mode: "模式",
  type: "类型",
  url: "URL",
  baseUrl: "基础地址",
  apiKey: "API 密钥",
  key: "密钥",
  token: "令牌",
  secret: "密钥",
  password: "密码",
  path: "路径",
  dir: "目录",
  file: "文件",
  host: "主机",
  port: "端口",
  timeout: "超时",
  timeoutSeconds: "超时（秒）",
  minDelayMs: "最小延迟（ms）",
  maxDelayMs: "最大延迟（ms）",
  minChars: "最小字符",
  maxChars: "最大字符",
  minTokens: "最小 Token",
  maxTokens: "最大 Token",
  maxConcurrent: "最大并发",
  intervalMinutes: "间隔（分钟）",
  intervalSeconds: "间隔（秒）",
  debounceMs: "防抖（ms）",
  ttl: "TTL",
  scope: "范围",
  policy: "策略",
  allow: "允许",
  deny: "拒绝",
  allowlist: "允许列表",
  denylist: "拒绝列表",
  users: "用户",
  user: "用户",
  group: "群组",
  groups: "群组",
  channels: "频道",
  channel: "频道",
  accounts: "账号",
  account: "账号",
  permissions: "权限",
  retries: "重试",
  retry: "重试",
  attempts: "尝试次数",
  jitter: "抖动",
  headers: "请求头",
  query: "查询",
  filters: "过滤",
  filter: "过滤",
  limits: "限制",
  limit: "限制",
  include: "包含",
  exclude: "排除",
  export: "导出",
  import: "导入",
  cache: "缓存",
  batch: "批处理",
  concurrency: "并发",
  tags: "标签",
  tag: "标签",
};

const AUTO_LABEL_TOKEN_MAP: Record<string, string> = {
  // Common tokens
  auto: "自动",
  select: "选择",
  family: "协议族",
  max: "最大",
  min: "最小",
  delay: "延迟",
  time: "时间",
  seconds: "秒",
  second: "秒",
  minutes: "分钟",
  minute: "分钟",
  hours: "小时",
  hour: "小时",
  ms: "ms",
  mb: "MB",
  gb: "GB",
  api: "API",
  key: "密钥",
  token: "令牌",
  url: "URL",
  host: "主机",
  port: "端口",
  path: "路径",
  dir: "目录",
  file: "文件",
  cache: "缓存",
  ttl: "TTL",
  batch: "批处理",
  poll: "轮询",
  interval: "间隔",
  timeout: "超时",
  size: "大小",
  limit: "限制",
  maxChars: "最大字符",
  minChars: "最小字符",
  enabled: "启用",
  default: "默认",
  name: "名称",
  id: "ID",
  mode: "模式",
  type: "类型",
  policy: "策略",
  allow: "允许",
  deny: "拒绝",
  list: "列表",
  group: "群组",
  channel: "频道",
  account: "账号",
  model: "模型",
  image: "图像",
  memory: "记忆",
  search: "搜索",
  remote: "远程",
  local: "本地",
  sandbox: "沙箱",
  docker: "Docker",
  browser: "浏览器",
  tools: "工具",
  commands: "命令",
  prompt: "提示",
  system: "系统",
  reason: "原因",
  stream: "流式",
  chunk: "分片",
  coalesce: "合并",
  heartbeat: "心跳",
  session: "会话",
  user: "用户",
  agent: "Agent",
  skill: "技能",
  skills: "技能",
  hook: "钩子",
  log: "日志",
  logging: "日志",
  diagnostics: "诊断",
  gateway: "网关",
  exec: "执行",
  approvals: "审批",
  bind: "绑定",
  binding: "绑定",
  ui: "界面",
  web: "Web",
  env: "环境",
};

function splitCamel(value: string): string[] {
  return value
    .replace(/[_\\-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean);
}

function autoTranslateSegment(segment: string): string | null {
  if (!segment || segment === "*") {
    return null;
  }
  const direct = AUTO_LABEL_MAP[segment];
  if (direct) {
    return direct;
  }
  const parts = splitCamel(segment);
  if (parts.length === 0) {
    return null;
  }
  const tokens = parts.map((part) => part.toLowerCase());
  let unit: string | null = null;
  const mapped = tokens.map((token) => {
    const mappedToken = AUTO_LABEL_TOKEN_MAP[token];
    if (mappedToken) {
      if (
        mappedToken === "ms" ||
        mappedToken === "秒" ||
        mappedToken === "分钟" ||
        mappedToken === "小时" ||
        mappedToken === "MB" ||
        mappedToken === "GB"
      ) {
        unit = mappedToken;
        return "";
      }
      return mappedToken;
    }
    return partFallback(token);
  });
  const base = mapped.filter(Boolean).join("");
  if (!base) {
    return null;
  }
  return unit ? `${base}（` + unit + "）" : base;
}

function partFallback(token: string): string {
  const direct = AUTO_LABEL_TOKEN_MAP[token];
  if (direct) {
    return direct;
  }
  return token;
}

function autoLabelForPath(path: string[]): string | null {
  const filtered = path.filter((segment) => segment && segment !== "*" && segment !== "list");
  if (filtered.length === 0) {
    return null;
  }
  const last = filtered.at(-1);
  if (!last) {
    return null;
  }
  const translated = autoTranslateSegment(last);
  if (translated) {
    return translated;
  }
  const parent = filtered.length > 1 ? (filtered.at(-2) ?? null) : null;
  if (parent) {
    const parentTranslated = autoTranslateSegment(parent);
    if (parentTranslated) {
      return `${parentTranslated}配置`;
    }
  }
  return null;
}

function applyAutoHintsFromSchema(
  schema: ConfigSchema,
  hints: ConfigUiHints,
  locale: ConfigLocale,
) {
  if (locale !== "zh-CN") {
    return hints;
  }
  const next: ConfigUiHints = { ...hints };

  const visit = (node: JsonSchemaObject, path: string[]) => {
    const key = path.join(".");
    if (key) {
      const current = next[key] ?? {};
      if (!current.label) {
        const label = autoLabelForPath(path);
        if (label) {
          next[key] = { ...current, label };
        }
      }
    }

    const properties = node.properties ?? {};
    for (const [name, value] of Object.entries(properties)) {
      const child = asSchemaObject(value);
      if (child) {
        visit(child, [...path, name]);
      }
    }

    const items = node.items;
    if (items && typeof items === "object") {
      const entry = Array.isArray(items) ? items[0] : items;
      const child = asSchemaObject(entry);
      if (child) {
        visit(child, [...path, "*"]);
      }
    }

    const additional = node.additionalProperties;
    if (additional && typeof additional === "object") {
      const child = asSchemaObject(additional);
      if (child) {
        visit(child, [...path, "*"]);
      }
    }

    const unions = [node.anyOf, node.oneOf, node.allOf];
    for (const variants of unions) {
      if (!variants) {
        continue;
      }
      for (const variant of variants) {
        const child = asSchemaObject(variant);
        if (child) {
          visit(child, path);
        }
      }
    }
  };

  const root = asSchemaObject(schema);
  if (root) {
    visit(root, []);
  }
  return next;
}

const GROUP_LABELS: Record<string, string> = {
  wizard: "Wizard",
  update: "Update",
  diagnostics: "Diagnostics",
  logging: "Logging",
  gateway: "Gateway",
  nodeHost: "Node Host",
  agents: "Agents",
  tools: "Tools",
  bindings: "Bindings",
  audio: "Audio",
  models: "Models",
  messages: "Messages",
  commands: "Commands",
  session: "Session",
  cron: "Cron",
  hooks: "Hooks",
  ui: "UI",
  browser: "Browser",
  talk: "Talk",
  channels: "Messaging Channels",
  skills: "Skills",
  plugins: "Plugins",
  discovery: "Discovery",
  presence: "Presence",
  voicewake: "Voice Wake",
};

const GROUP_LABELS_ZH: Record<string, string> = {
  wizard: "向导",
  update: "更新",
  diagnostics: "诊断",
  logging: "日志",
  gateway: "网关",
  nodeHost: "节点主机",
  agents: "代理",
  tools: "工具",
  bindings: "绑定",
  audio: "音频",
  models: "模型",
  messages: "消息",
  commands: "命令",
  session: "会话",
  cron: "定时任务",
  hooks: "钩子",
  ui: "界面",
  browser: "浏览器",
  talk: "语音",
  channels: "消息渠道",
  skills: "技能",
  plugins: "插件",
  discovery: "发现",
  presence: "在线状态",
  voicewake: "语音唤醒",
};

const GROUP_ORDER: Record<string, number> = {
  wizard: 20,
  update: 25,
  diagnostics: 27,
  gateway: 30,
  nodeHost: 35,
  agents: 40,
  tools: 50,
  bindings: 55,
  audio: 60,
  models: 70,
  messages: 80,
  commands: 85,
  session: 90,
  cron: 100,
  hooks: 110,
  ui: 120,
  browser: 130,
  talk: 140,
  channels: 150,
  skills: 200,
  plugins: 205,
  discovery: 210,
  presence: 220,
  voicewake: 230,
  logging: 900,
};

function mergeLocalizedMap(
  base: Record<string, string>,
  localized: Record<string, string>,
  locale: ConfigLocale,
): Record<string, string> {
  if (locale !== "zh-CN") {
    return base;
  }
  const merged: Record<string, string> = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(localized)]);
  for (const key of keys) {
    merged[key] = localized[key] ?? base[key];
  }
  return merged;
}

const FIELD_LABELS: Record<string, string> = {
  "meta.lastTouchedVersion": "Config Last Touched Version",
  "meta.lastTouchedAt": "Config Last Touched At",
  "update.channel": "Update Channel",
  "update.checkOnStart": "Update Check on Start",
  "diagnostics.enabled": "Diagnostics Enabled",
  "diagnostics.flags": "Diagnostics Flags",
  "diagnostics.otel.enabled": "OpenTelemetry Enabled",
  "diagnostics.otel.endpoint": "OpenTelemetry Endpoint",
  "diagnostics.otel.protocol": "OpenTelemetry Protocol",
  "diagnostics.otel.headers": "OpenTelemetry Headers",
  "diagnostics.otel.serviceName": "OpenTelemetry Service Name",
  "diagnostics.otel.traces": "OpenTelemetry Traces Enabled",
  "diagnostics.otel.metrics": "OpenTelemetry Metrics Enabled",
  "diagnostics.otel.logs": "OpenTelemetry Logs Enabled",
  "diagnostics.otel.sampleRate": "OpenTelemetry Trace Sample Rate",
  "diagnostics.otel.flushIntervalMs": "OpenTelemetry Flush Interval (ms)",
  "diagnostics.cacheTrace.enabled": "Cache Trace Enabled",
  "diagnostics.cacheTrace.filePath": "Cache Trace File Path",
  "diagnostics.cacheTrace.includeMessages": "Cache Trace Include Messages",
  "diagnostics.cacheTrace.includePrompt": "Cache Trace Include Prompt",
  "diagnostics.cacheTrace.includeSystem": "Cache Trace Include System",
  "agents.list.*.identity.avatar": "Identity Avatar",
  "agents.list.*.skills": "Agent Skill Filter",
  "gateway.remote.url": "Remote Gateway URL",
  "gateway.remote.sshTarget": "Remote Gateway SSH Target",
  "gateway.remote.sshIdentity": "Remote Gateway SSH Identity",
  "gateway.remote.token": "Remote Gateway Token",
  "gateway.remote.password": "Remote Gateway Password",
  "gateway.remote.tlsFingerprint": "Remote Gateway TLS Fingerprint",
  "gateway.auth.token": "Gateway Token",
  "gateway.auth.password": "Gateway Password",
  "tools.media.image.enabled": "Enable Image Understanding",
  "tools.media.image.maxBytes": "Image Understanding Max Bytes",
  "tools.media.image.maxChars": "Image Understanding Max Chars",
  "tools.media.image.prompt": "Image Understanding Prompt",
  "tools.media.image.timeoutSeconds": "Image Understanding Timeout (sec)",
  "tools.media.image.attachments": "Image Understanding Attachment Policy",
  "tools.media.image.models": "Image Understanding Models",
  "tools.media.image.scope": "Image Understanding Scope",
  "tools.media.models": "Media Understanding Shared Models",
  "tools.media.concurrency": "Media Understanding Concurrency",
  "tools.media.audio.enabled": "Enable Audio Understanding",
  "tools.media.audio.maxBytes": "Audio Understanding Max Bytes",
  "tools.media.audio.maxChars": "Audio Understanding Max Chars",
  "tools.media.audio.prompt": "Audio Understanding Prompt",
  "tools.media.audio.timeoutSeconds": "Audio Understanding Timeout (sec)",
  "tools.media.audio.language": "Audio Understanding Language",
  "tools.media.audio.attachments": "Audio Understanding Attachment Policy",
  "tools.media.audio.models": "Audio Understanding Models",
  "tools.media.audio.scope": "Audio Understanding Scope",
  "tools.media.video.enabled": "Enable Video Understanding",
  "tools.media.video.maxBytes": "Video Understanding Max Bytes",
  "tools.media.video.maxChars": "Video Understanding Max Chars",
  "tools.media.video.prompt": "Video Understanding Prompt",
  "tools.media.video.timeoutSeconds": "Video Understanding Timeout (sec)",
  "tools.media.video.attachments": "Video Understanding Attachment Policy",
  "tools.media.video.models": "Video Understanding Models",
  "tools.media.video.scope": "Video Understanding Scope",
  "tools.links.enabled": "Enable Link Understanding",
  "tools.links.maxLinks": "Link Understanding Max Links",
  "tools.links.timeoutSeconds": "Link Understanding Timeout (sec)",
  "tools.links.models": "Link Understanding Models",
  "tools.links.scope": "Link Understanding Scope",
  "tools.profile": "Tool Profile",
  "tools.alsoAllow": "Tool Allowlist Additions",
  "agents.list[].tools.profile": "Agent Tool Profile",
  "agents.list[].tools.alsoAllow": "Agent Tool Allowlist Additions",
  "tools.byProvider": "Tool Policy by Provider",
  "agents.list[].tools.byProvider": "Agent Tool Policy by Provider",
  "tools.exec.applyPatch.enabled": "Enable apply_patch",
  "tools.exec.applyPatch.allowModels": "apply_patch Model Allowlist",
  "tools.exec.notifyOnExit": "Exec Notify On Exit",
  "tools.exec.approvalRunningNoticeMs": "Exec Approval Running Notice (ms)",
  "tools.exec.host": "Exec Host",
  "tools.exec.security": "Exec Security",
  "tools.exec.ask": "Exec Ask",
  "tools.exec.node": "Exec Node Binding",
  "tools.exec.pathPrepend": "Exec PATH Prepend",
  "tools.exec.safeBins": "Exec Safe Bins",
  "tools.message.allowCrossContextSend": "Allow Cross-Context Messaging",
  "tools.message.crossContext.allowWithinProvider": "Allow Cross-Context (Same Provider)",
  "tools.message.crossContext.allowAcrossProviders": "Allow Cross-Context (Across Providers)",
  "tools.message.crossContext.marker.enabled": "Cross-Context Marker",
  "tools.message.crossContext.marker.prefix": "Cross-Context Marker Prefix",
  "tools.message.crossContext.marker.suffix": "Cross-Context Marker Suffix",
  "tools.message.broadcast.enabled": "Enable Message Broadcast",
  "tools.web.search.enabled": "Enable Web Search Tool",
  "tools.web.search.provider": "Web Search Provider",
  "tools.web.search.apiKey": "Brave Search API 密钥",
  "tools.web.search.maxResults": "Web Search Max Results",
  "tools.web.search.timeoutSeconds": "Web Search Timeout (sec)",
  "tools.web.search.cacheTtlMinutes": "Web Search Cache TTL (min)",
  "tools.web.fetch.enabled": "Enable Web Fetch Tool",
  "tools.web.fetch.maxChars": "Web Fetch Max Chars",
  "tools.web.fetch.timeoutSeconds": "Web Fetch Timeout (sec)",
  "tools.web.fetch.cacheTtlMinutes": "Web Fetch Cache TTL (min)",
  "tools.web.fetch.maxRedirects": "Web Fetch Max Redirects",
  "tools.web.fetch.userAgent": "Web Fetch User-Agent",
  "gateway.controlUi.basePath": "Control UI Base Path",
  "gateway.controlUi.root": "Control UI Assets Root",
  "gateway.controlUi.allowedOrigins": "Control UI Allowed Origins",
  "gateway.controlUi.allowInsecureAuth": "Allow Insecure Control UI Auth",
  "gateway.controlUi.dangerouslyDisableDeviceAuth": "Dangerously Disable Control UI Device Auth",
  "gateway.http.endpoints.chatCompletions.enabled": "OpenAI Chat Completions Endpoint",
  "gateway.reload.mode": "Config Reload Mode",
  "gateway.reload.debounceMs": "Config Reload Debounce (ms)",
  "gateway.nodes.browser.mode": "Gateway Node Browser Mode",
  "gateway.nodes.browser.node": "Gateway Node Browser Pin",
  "gateway.nodes.allowCommands": "Gateway Node Allowlist (Extra Commands)",
  "gateway.nodes.denyCommands": "Gateway Node Denylist",
  "nodeHost.browserProxy.enabled": "Node Browser Proxy Enabled",
  "nodeHost.browserProxy.allowProfiles": "Node Browser Proxy Allowed Profiles",
  "skills.load.watch": "Watch Skills",
  "skills.load.watchDebounceMs": "Skills Watch Debounce (ms)",
  "agents.defaults.workspace": "Workspace",
  "agents.defaults.repoRoot": "Repo Root",
  "agents.defaults.bootstrapMaxChars": "Bootstrap Max Chars",
  "agents.defaults.envelopeTimezone": "Envelope Timezone",
  "agents.defaults.envelopeTimestamp": "Envelope Timestamp",
  "agents.defaults.envelopeElapsed": "Envelope Elapsed",
  "agents.defaults.memorySearch": "Memory Search",
  "agents.defaults.memorySearch.enabled": "Enable Memory Search",
  "agents.defaults.memorySearch.sources": "Memory Search Sources",
  "agents.defaults.memorySearch.extraPaths": "Extra Memory Paths",
  "agents.defaults.memorySearch.experimental.sessionMemory":
    "Memory Search Session Index (Experimental)",
  "agents.defaults.memorySearch.provider": "Memory Search Provider",
  "agents.defaults.memorySearch.remote.baseUrl": "Remote Embedding Base URL",
  "agents.defaults.memorySearch.remote.apiKey": "Remote Embedding API Key",
  "agents.defaults.memorySearch.remote.headers": "Remote Embedding Headers",
  "agents.defaults.memorySearch.remote.batch.concurrency": "Remote Batch Concurrency",
  "agents.defaults.memorySearch.model": "Memory Search Model",
  "agents.defaults.memorySearch.fallback": "Memory Search Fallback",
  "agents.defaults.memorySearch.local.modelPath": "Local Embedding Model Path",
  "agents.defaults.memorySearch.store.path": "Memory Search Index Path",
  "agents.defaults.memorySearch.store.vector.enabled": "Memory Search Vector Index",
  "agents.defaults.memorySearch.store.vector.extensionPath": "Memory Search Vector Extension Path",
  "agents.defaults.memorySearch.chunking.tokens": "Memory Chunk Tokens",
  "agents.defaults.memorySearch.chunking.overlap": "Memory Chunk Overlap Tokens",
  "agents.defaults.memorySearch.sync.onSessionStart": "Index on Session Start",
  "agents.defaults.memorySearch.sync.onSearch": "Index on Search (Lazy)",
  "agents.defaults.memorySearch.sync.watch": "Watch Memory Files",
  "agents.defaults.memorySearch.sync.watchDebounceMs": "Memory Watch Debounce (ms)",
  "agents.defaults.memorySearch.sync.sessions.deltaBytes": "Session Delta Bytes",
  "agents.defaults.memorySearch.sync.sessions.deltaMessages": "Session Delta Messages",
  "agents.defaults.memorySearch.query.maxResults": "Memory Search Max Results",
  "agents.defaults.memorySearch.query.minScore": "Memory Search Min Score",
  "agents.defaults.memorySearch.query.hybrid.enabled": "Memory Search Hybrid",
  "agents.defaults.memorySearch.query.hybrid.vectorWeight": "Memory Search Vector Weight",
  "agents.defaults.memorySearch.query.hybrid.textWeight": "Memory Search Text Weight",
  "agents.defaults.memorySearch.query.hybrid.candidateMultiplier":
    "Memory Search Hybrid Candidate Multiplier",
  "agents.defaults.memorySearch.cache.enabled": "Memory Search Embedding Cache",
  "agents.defaults.memorySearch.cache.maxEntries": "Memory Search Embedding Cache Max Entries",
  memory: "Memory",
  "memory.backend": "Memory Backend",
  "memory.citations": "Memory Citations Mode",
  "memory.qmd.command": "QMD Binary",
  "memory.qmd.includeDefaultMemory": "QMD Include Default Memory",
  "memory.qmd.paths": "QMD Extra Paths",
  "memory.qmd.paths.path": "QMD Path",
  "memory.qmd.paths.pattern": "QMD Path Pattern",
  "memory.qmd.paths.name": "QMD Path Name",
  "memory.qmd.sessions.enabled": "QMD Session Indexing",
  "memory.qmd.sessions.exportDir": "QMD Session Export Directory",
  "memory.qmd.sessions.retentionDays": "QMD Session Retention (days)",
  "memory.qmd.update.interval": "QMD Update Interval",
  "memory.qmd.update.debounceMs": "QMD Update Debounce (ms)",
  "memory.qmd.update.onBoot": "QMD Update on Startup",
  "memory.qmd.update.embedInterval": "QMD Embed Interval",
  "memory.qmd.limits.maxResults": "QMD Max Results",
  "memory.qmd.limits.maxSnippetChars": "QMD Max Snippet Chars",
  "memory.qmd.limits.maxInjectedChars": "QMD Max Injected Chars",
  "memory.qmd.limits.timeoutMs": "QMD Search Timeout (ms)",
  "memory.qmd.scope": "QMD Surface Scope",
  "auth.profiles": "Auth Profiles",
  "auth.order": "Auth Profile Order",
  "auth.cooldowns.billingBackoffHours": "Billing Backoff (hours)",
  "auth.cooldowns.billingBackoffHoursByProvider": "Billing Backoff Overrides",
  "auth.cooldowns.billingMaxHours": "Billing Backoff Cap (hours)",
  "auth.cooldowns.failureWindowHours": "Failover Window (hours)",
  "agents.defaults.models": "Models",
  "agents.defaults.model.primary": "Primary Model",
  "agents.defaults.model.fallbacks": "Model Fallbacks",
  "agents.defaults.imageModel.primary": "Image Model",
  "agents.defaults.imageModel.fallbacks": "Image Model Fallbacks",
  "agents.defaults.humanDelay.mode": "Human Delay Mode",
  "agents.defaults.humanDelay.minMs": "Human Delay Min (ms)",
  "agents.defaults.humanDelay.maxMs": "Human Delay Max (ms)",
  "agents.defaults.cliBackends": "CLI Backends",
  "commands.native": "Native Commands",
  "commands.nativeSkills": "Native Skill Commands",
  "commands.text": "Text Commands",
  "commands.bash": "Allow Bash Chat Command",
  "commands.bashForegroundMs": "Bash Foreground Window (ms)",
  "commands.config": "Allow /config",
  "commands.debug": "Allow /debug",
  "commands.restart": "Allow Restart",
  "commands.useAccessGroups": "Use Access Groups",
  "commands.ownerAllowFrom": "Command Owners",
  "ui.seamColor": "Accent Color",
  "ui.assistant.name": "Assistant Name",
  "ui.assistant.avatar": "Assistant Avatar",
  "browser.evaluateEnabled": "Browser Evaluate Enabled",
  "browser.snapshotDefaults": "Browser Snapshot Defaults",
  "browser.snapshotDefaults.mode": "Browser Snapshot Mode",
  "browser.remoteCdpTimeoutMs": "Remote CDP Timeout (ms)",
  "browser.remoteCdpHandshakeTimeoutMs": "Remote CDP Handshake Timeout (ms)",
  "session.dmScope": "DM Session Scope",
  "session.agentToAgent.maxPingPongTurns": "Agent-to-Agent Ping-Pong Turns",
  "messages.ackReaction": "Ack Reaction Emoji",
  "messages.ackReactionScope": "Ack Reaction Scope",
  "messages.inbound.debounceMs": "Inbound Message Debounce (ms)",
  "talk.apiKey": "Talk API Key",
  "channels.whatsapp": "WhatsApp 渠道",
  "channels.telegram": "Telegram 渠道",
  "channels.telegram.customCommands": "Telegram Custom Commands",
  "channels.discord": "Discord 渠道",
  "channels.slack": "Slack 渠道",
  "channels.mattermost": "Mattermost 渠道",
  "channels.signal": "Signal 渠道",
  "channels.imessage": "iMessage 渠道",
  "channels.bluebubbles": "BlueBubbles 渠道",
  "channels.msteams": "Microsoft Teams 渠道",
  "channels.telegram.botToken": "Telegram Bot Token（机器人令牌）",
  "channels.telegram.dmPolicy": "Telegram DM Policy",
  "channels.telegram.streamMode": "Telegram Draft Stream Mode",
  "channels.telegram.draftChunk.minChars": "Telegram Draft Chunk Min Chars",
  "channels.telegram.draftChunk.maxChars": "Telegram Draft Chunk Max Chars",
  "channels.telegram.draftChunk.breakPreference": "Telegram Draft Chunk Break Preference",
  "channels.telegram.retry.attempts": "Telegram Retry Attempts",
  "channels.telegram.retry.minDelayMs": "Telegram Retry Min Delay (ms)",
  "channels.telegram.retry.maxDelayMs": "Telegram Retry Max Delay (ms)",
  "channels.telegram.retry.jitter": "Telegram Retry Jitter",
  "channels.telegram.network.autoSelectFamily": "Telegram 自动选择网络协议族",
  "channels.telegram.timeoutSeconds": "Telegram API Timeout (seconds)",
  "channels.telegram.capabilities.inlineButtons": "Telegram Inline Buttons",
  "channels.whatsapp.dmPolicy": "WhatsApp DM Policy",
  "channels.whatsapp.selfChatMode": "WhatsApp Self-Phone Mode",
  "channels.whatsapp.debounceMs": "WhatsApp Message Debounce (ms)",
  "channels.signal.dmPolicy": "Signal DM Policy",
  "channels.imessage.dmPolicy": "iMessage DM Policy",
  "channels.bluebubbles.dmPolicy": "BlueBubbles DM Policy",
  "channels.discord.dm.policy": "Discord DM Policy",
  "channels.discord.retry.attempts": "Discord Retry Attempts",
  "channels.discord.retry.minDelayMs": "Discord Retry Min Delay (ms)",
  "channels.discord.retry.maxDelayMs": "Discord Retry Max Delay (ms)",
  "channels.discord.retry.jitter": "Discord Retry Jitter",
  "channels.discord.maxLinesPerMessage": "Discord Max Lines Per Message",
  "channels.discord.intents.presence": "Discord Presence Intent（在线状态权限）",
  "channels.discord.intents.guildMembers": "Discord Guild Members Intent（成员列表权限）",
  "channels.discord.pluralkit.enabled": "Discord PluralKit Enabled",
  "channels.discord.pluralkit.token": "Discord PluralKit Token（令牌）",
  "channels.slack.dm.policy": "Slack DM Policy",
  "channels.slack.allowBots": "Slack Allow Bot Messages",
  "channels.discord.token": "Discord Bot Token（机器人令牌）",
  "channels.slack.botToken": "Slack Bot Token（机器人令牌）",
  "channels.slack.appToken": "Slack App Token（应用令牌）",
  "channels.slack.userToken": "Slack User Token",
  "channels.slack.userTokenReadOnly": "Slack User Token Read Only",
  "channels.slack.thread.historyScope": "Slack Thread History Scope",
  "channels.slack.thread.inheritParent": "Slack Thread Parent Inheritance",
  "channels.mattermost.botToken": "Mattermost Bot Token（机器人令牌）",
  "channels.mattermost.baseUrl": "Mattermost Base URL（基础地址）",
  "channels.mattermost.chatmode": "Mattermost Chat Mode",
  "channels.mattermost.oncharPrefixes": "Mattermost Onchar Prefixes",
  "channels.mattermost.requireMention": "Mattermost Require Mention",
  "channels.signal.account": "Signal Account",
  "channels.imessage.cliPath": "iMessage CLI Path",
  "agents.list[].skills": "Agent Skill Filter",
  "agents.list[].identity.avatar": "Agent Avatar",
  "discovery.mdns.mode": "mDNS Discovery Mode",
  "plugins.enabled": "Enable Plugins",
  "plugins.allow": "Plugin Allowlist",
  "plugins.deny": "Plugin Denylist",
  "plugins.load.paths": "Plugin Load Paths",
  "plugins.slots": "Plugin Slots",
  "plugins.slots.memory": "Memory Plugin",
  "plugins.entries": "Plugin Entries",
  "plugins.entries.*.enabled": "Plugin Enabled",
  "plugins.entries.*.config": "Plugin Config",
  "plugins.installs": "Plugin Install Records",
  "plugins.installs.*.source": "Plugin Install Source",
  "plugins.installs.*.spec": "Plugin Install Spec",
  "plugins.installs.*.sourcePath": "Plugin Install Source Path",
  "plugins.installs.*.installPath": "Plugin Install Path",
  "plugins.installs.*.version": "Plugin Install Version",
  "plugins.installs.*.installedAt": "Plugin Install Time",
};

const FIELD_LABELS_ZH: Record<string, string> = {
  "meta.lastTouchedVersion": "配置最后写入版本",
  "meta.lastTouchedAt": "配置最后写入时间",
  "update.channel": "更新通道",
  "update.checkOnStart": "启动时检查更新",
  "diagnostics.enabled": "启用诊断",
  "diagnostics.flags": "诊断标记",
  "diagnostics.otel.enabled": "启用 OpenTelemetry",
  "diagnostics.otel.endpoint": "OpenTelemetry 端点",
  "diagnostics.otel.protocol": "OpenTelemetry 协议",
  "diagnostics.otel.headers": "OpenTelemetry 请求头",
  "diagnostics.otel.serviceName": "OpenTelemetry 服务名",
  "diagnostics.otel.traces": "启用 OpenTelemetry Traces",
  "diagnostics.otel.metrics": "启用 OpenTelemetry Metrics",
  "diagnostics.otel.logs": "启用 OpenTelemetry Logs",
  "diagnostics.otel.sampleRate": "OpenTelemetry Trace 采样率",
  "diagnostics.otel.flushIntervalMs": "OpenTelemetry 刷新间隔（ms）",
  "diagnostics.cacheTrace.enabled": "启用 Cache Trace",
  "diagnostics.cacheTrace.filePath": "Cache Trace 文件路径",
  "diagnostics.cacheTrace.includeMessages": "Cache Trace 包含消息",
  "diagnostics.cacheTrace.includePrompt": "Cache Trace 包含 Prompt",
  "diagnostics.cacheTrace.includeSystem": "Cache Trace 包含 System",
  "agents.list.*.identity.avatar": "身份头像",
  "agents.list.*.skills": "Agent 技能筛选",
  "gateway.remote.url": "远程网关 URL",
  "gateway.remote.sshTarget": "远程网关 SSH 目标",
  "gateway.remote.sshIdentity": "远程网关 SSH 身份文件",
  "gateway.remote.token": "远程网关 Token",
  "gateway.remote.password": "远程网关密码",
  "gateway.remote.tlsFingerprint": "远程网关 TLS 指纹",
  "gateway.auth.token": "网关 Token",
  "gateway.auth.password": "网关密码",
  "tools.media.image.enabled": "启用图像理解",
  "tools.media.image.maxBytes": "图像理解最大字节",
  "tools.media.image.maxChars": "图像理解最大字符",
  "tools.media.image.prompt": "图像理解 Prompt",
  "tools.media.image.timeoutSeconds": "图像理解超时（秒）",
  "tools.media.image.attachments": "图像理解附件策略",
  "tools.media.image.models": "图像理解模型",
  "tools.media.image.scope": "图像理解范围",
  "tools.media.models": "媒体理解共享模型",
  "tools.media.concurrency": "媒体理解并发数",
  "tools.media.audio.enabled": "启用音频理解",
  "tools.media.audio.maxBytes": "音频理解最大字节",
  "tools.media.audio.maxChars": "音频理解最大字符",
  "tools.media.audio.prompt": "音频理解 Prompt",
  "tools.media.audio.timeoutSeconds": "音频理解超时（秒）",
  "tools.media.audio.language": "音频理解语言",
  "tools.media.audio.attachments": "音频理解附件策略",
  "tools.media.audio.models": "音频理解模型",
  "tools.media.audio.scope": "音频理解范围",
  "tools.media.video.enabled": "启用视频理解",
  "tools.media.video.maxBytes": "视频理解最大字节",
  "tools.media.video.maxChars": "视频理解最大字符",
  "tools.media.video.prompt": "视频理解 Prompt",
  "tools.media.video.timeoutSeconds": "视频理解超时（秒）",
  "tools.media.video.attachments": "视频理解附件策略",
  "tools.media.video.models": "视频理解模型",
  "tools.media.video.scope": "视频理解范围",
  "tools.links.enabled": "启用链接理解",
  "tools.links.maxLinks": "链接理解最大链接数",
  "tools.links.timeoutSeconds": "链接理解超时（秒）",
  "tools.links.models": "链接理解模型",
  "tools.links.scope": "链接理解范围",
  "tools.profile": "工具配置档",
  "tools.alsoAllow": "工具允许列表补充",
  "agents.list[].tools.profile": "Agent 工具配置档",
  "agents.list[].tools.alsoAllow": "Agent 工具允许列表补充",
  "tools.byProvider": "按提供方的工具策略",
  "agents.list[].tools.byProvider": "Agent 按提供方的工具策略",
  "tools.exec.applyPatch.enabled": "启用 apply_patch",
  "tools.exec.applyPatch.allowModels": "apply_patch 模型允许列表",
  "tools.exec.notifyOnExit": "Exec 退出通知",
  "tools.exec.approvalRunningNoticeMs": "Exec 审批运行提示（ms）",
  "tools.exec.host": "Exec 主机",
  "tools.exec.security": "Exec 安全策略",
  "tools.exec.ask": "Exec 询问策略",
  "tools.exec.node": "Exec 节点绑定",
  "tools.exec.pathPrepend": "Exec PATH 前置",
  "tools.exec.safeBins": "Exec 安全二进制",
  "tools.message.allowCrossContextSend": "允许跨上下文消息",
  "tools.message.crossContext.allowWithinProvider": "允许跨上下文（同提供方）",
  "tools.message.crossContext.allowAcrossProviders": "允许跨上下文（跨提供方）",
  "tools.message.crossContext.marker.enabled": "跨上下文标记",
  "tools.message.crossContext.marker.prefix": "跨上下文标记前缀",
  "tools.message.crossContext.marker.suffix": "跨上下文标记后缀",
  "tools.message.broadcast.enabled": "启用消息广播",
  "tools.web.search.enabled": "启用 Web 搜索工具",
  "tools.web.search.provider": "Web 搜索提供方",
  "tools.web.search.apiKey": "Brave Search API Key",
  "tools.web.search.maxResults": "Web 搜索最大结果数",
  "tools.web.search.timeoutSeconds": "Web 搜索超时（秒）",
  "tools.web.search.cacheTtlMinutes": "Web 搜索缓存 TTL（分钟）",
  "tools.web.fetch.enabled": "启用 Web 抓取工具",
  "tools.web.fetch.maxChars": "Web 抓取最大字符",
  "tools.web.fetch.timeoutSeconds": "Web 抓取超时（秒）",
  "tools.web.fetch.cacheTtlMinutes": "Web 抓取缓存 TTL（分钟）",
  "tools.web.fetch.maxRedirects": "Web 抓取最大重定向",
  "tools.web.fetch.userAgent": "Web 抓取 User-Agent",
  "gateway.controlUi.basePath": "控制台基础路径",
  "gateway.controlUi.root": "控制台资源根目录",
  "gateway.controlUi.allowInsecureAuth": "允许不安全控制台认证",
  "gateway.controlUi.dangerouslyDisableDeviceAuth": "危险：禁用控制台设备认证",
  "gateway.http.endpoints.chatCompletions.enabled": "OpenAI Chat Completions 端点",
  "gateway.reload.mode": "配置热重载模式",
  "gateway.reload.debounceMs": "配置重载防抖（ms）",
  "gateway.nodes.browser.mode": "网关节点浏览器模式",
  "gateway.nodes.browser.node": "网关节点浏览器固定节点",
  "gateway.nodes.allowCommands": "网关节点允许列表（额外命令）",
  "gateway.nodes.denyCommands": "网关节点拒绝列表",
  "nodeHost.browserProxy.enabled": "启用节点浏览器代理",
  "nodeHost.browserProxy.allowProfiles": "节点浏览器代理允许的配置档",
  "skills.load.watch": "监视技能",
  "skills.load.watchDebounceMs": "技能监视防抖（ms）",
  "agents.defaults.workspace": "工作区",
  "agents.defaults.repoRoot": "仓库根目录",
  "agents.defaults.bootstrapMaxChars": "启动文件最大字符数",
  "agents.defaults.envelopeTimezone": "消息封装时区",
  "agents.defaults.envelopeTimestamp": "消息封装时间戳",
  "agents.defaults.envelopeElapsed": "消息封装耗时",
  "agents.defaults.memorySearch": "记忆检索",
  "agents.defaults.memorySearch.enabled": "启用记忆检索",
  "agents.defaults.memorySearch.sources": "记忆检索来源",
  "agents.defaults.memorySearch.extraPaths": "额外记忆路径",
  "agents.defaults.memorySearch.experimental.sessionMemory": "会话记忆索引（实验）",
  "agents.defaults.memorySearch.provider": "记忆检索提供方",
  "agents.defaults.memorySearch.remote.baseUrl": "远程嵌入 Base URL",
  "agents.defaults.memorySearch.remote.apiKey": "远程嵌入 API Key",
  "agents.defaults.memorySearch.remote.headers": "远程嵌入请求头",
  "agents.defaults.memorySearch.remote.batch.concurrency": "远程批处理并发",
  "agents.defaults.memorySearch.model": "记忆检索模型",
  "agents.defaults.memorySearch.fallback": "记忆检索回退",
  "agents.defaults.memorySearch.local.modelPath": "本地嵌入模型路径",
  "agents.defaults.memorySearch.store.path": "记忆检索索引路径",
  "agents.defaults.memorySearch.store.vector.enabled": "记忆检索向量索引",
  "agents.defaults.memorySearch.store.vector.extensionPath": "记忆检索向量扩展路径",
  "agents.defaults.memorySearch.chunking.tokens": "记忆分块 Token",
  "agents.defaults.memorySearch.chunking.overlap": "记忆分块重叠 Token",
  "agents.defaults.memorySearch.sync.onSessionStart": "会话开始时索引",
  "agents.defaults.memorySearch.sync.onSearch": "搜索时索引（惰性）",
  "agents.defaults.memorySearch.sync.watch": "监视记忆文件",
  "agents.defaults.memorySearch.sync.watchDebounceMs": "记忆监视防抖（ms）",
  "agents.defaults.memorySearch.sync.sessions.deltaBytes": "会话增量字节",
  "agents.defaults.memorySearch.sync.sessions.deltaMessages": "会话增量消息数",
  "agents.defaults.memorySearch.query.maxResults": "记忆检索最大结果数",
  "agents.defaults.memorySearch.query.minScore": "记忆检索最小分数",
  "agents.defaults.memorySearch.query.hybrid.enabled": "记忆检索混合模式",
  "agents.defaults.memorySearch.query.hybrid.vectorWeight": "记忆检索向量权重",
  "agents.defaults.memorySearch.query.hybrid.textWeight": "记忆检索文本权重",
  "agents.defaults.memorySearch.query.hybrid.candidateMultiplier": "记忆检索候选倍数",
  "agents.defaults.memorySearch.cache.enabled": "记忆检索嵌入缓存",
  "agents.defaults.memorySearch.cache.maxEntries": "记忆检索嵌入缓存上限",
  memory: "记忆",
  "memory.backend": "记忆后端",
  "memory.citations": "引用模式",
  "memory.qmd.command": "QMD 可执行文件",
  "memory.qmd.includeDefaultMemory": "QMD 包含默认记忆",
  "memory.qmd.paths": "QMD 额外路径",
  "memory.qmd.paths.path": "QMD 路径",
  "memory.qmd.paths.pattern": "QMD 路径模式",
  "memory.qmd.paths.name": "QMD 路径名称",
  "memory.qmd.sessions.enabled": "QMD 会话索引",
  "memory.qmd.sessions.exportDir": "QMD 会话导出目录",
  "memory.qmd.sessions.retentionDays": "QMD 会话保留（天）",
  "memory.qmd.update.interval": "QMD 更新间隔",
  "memory.qmd.update.debounceMs": "QMD 更新防抖（ms）",
  "memory.qmd.update.onBoot": "QMD 启动时更新",
  "memory.qmd.update.embedInterval": "QMD 嵌入更新间隔",
  "memory.qmd.limits.maxResults": "QMD 最大结果数",
  "memory.qmd.limits.maxSnippetChars": "QMD 片段最大字符",
  "memory.qmd.limits.maxInjectedChars": "QMD 注入最大字符",
  "memory.qmd.limits.timeoutMs": "QMD 搜索超时（ms）",
  "memory.qmd.scope": "QMD 召回范围",
  "auth.profiles": "认证配置档",
  "auth.order": "认证配置档顺序",
  "auth.cooldowns.billingBackoffHours": "计费退避（小时）",
  "auth.cooldowns.billingBackoffHoursByProvider": "计费退避按提供方覆盖",
  "auth.cooldowns.billingMaxHours": "计费退避上限（小时）",
  "auth.cooldowns.failureWindowHours": "故障窗口（小时）",
  "agents.defaults.models": "模型",
  "agents.defaults.model.primary": "主模型",
  "agents.defaults.model.fallbacks": "模型回退",
  "agents.defaults.imageModel.primary": "图像模型",
  "agents.defaults.imageModel.fallbacks": "图像模型回退",
  "agents.defaults.humanDelay.mode": "人类延迟模式",
  "agents.defaults.humanDelay.minMs": "人类延迟最小值（ms）",
  "agents.defaults.humanDelay.maxMs": "人类延迟最大值（ms）",
  "agents.defaults.cliBackends": "CLI 后端",
  "commands.native": "原生命令",
  "commands.nativeSkills": "原生技能命令",
  "commands.text": "文本命令",
  "commands.bash": "允许 Bash 聊天命令",
  "commands.bashForegroundMs": "Bash 前台窗口（ms）",
  "commands.config": "允许 /config",
  "commands.debug": "允许 /debug",
  "commands.restart": "允许重启",
  "commands.useAccessGroups": "使用访问组",
  "ui.seamColor": "强调色",
  "ui.assistant.name": "助手名称",
  "ui.assistant.avatar": "助手头像",
  "browser.evaluateEnabled": "启用浏览器 Evaluate",
  "browser.snapshotDefaults": "浏览器快照默认值",
  "browser.snapshotDefaults.mode": "浏览器快照模式",
  "browser.remoteCdpTimeoutMs": "远程 CDP 超时（ms）",
  "browser.remoteCdpHandshakeTimeoutMs": "远程 CDP 握手超时（ms）",
  "session.dmScope": "私聊会话范围",
  "session.agentToAgent.maxPingPongTurns": "Agent 间往返轮次",
  "messages.ackReaction": "确认表情",
  "messages.ackReactionScope": "确认表情范围",
  "messages.inbound.debounceMs": "入站消息防抖（ms）",
  "talk.apiKey": "语音 API Key",
  "channels.whatsapp": "WhatsApp",
  "channels.telegram": "Telegram",
  "channels.telegram.customCommands": "Telegram 自定义命令",
  "channels.discord": "Discord",
  "channels.slack": "Slack",
  "channels.mattermost": "Mattermost",
  "channels.signal": "Signal",
  "channels.imessage": "iMessage",
  "channels.bluebubbles": "BlueBubbles",
  "channels.msteams": "MS Teams",
  "channels.telegram.botToken": "Telegram Bot Token",
  "channels.telegram.dmPolicy": "Telegram 私聊策略",
  "channels.telegram.streamMode": "Telegram 草稿流模式",
  "channels.telegram.draftChunk.minChars": "Telegram 草稿分片最小字符",
  "channels.telegram.draftChunk.maxChars": "Telegram 草稿分片最大字符",
  "channels.telegram.draftChunk.breakPreference": "Telegram 草稿分片断点偏好",
  "channels.telegram.retry.attempts": "Telegram 重试次数",
  "channels.telegram.retry.minDelayMs": "Telegram 重试最小延迟（ms）",
  "channels.telegram.retry.maxDelayMs": "Telegram 重试最大延迟（ms）",
  "channels.telegram.retry.jitter": "Telegram 重试抖动",
  "channels.telegram.network.autoSelectFamily": "Telegram autoSelectFamily",
  "channels.telegram.timeoutSeconds": "Telegram API 超时（秒）",
  "channels.telegram.capabilities.inlineButtons": "Telegram 内联按钮",
  "channels.whatsapp.dmPolicy": "WhatsApp 私聊策略",
  "channels.whatsapp.selfChatMode": "WhatsApp 自聊模式",
  "channels.whatsapp.debounceMs": "WhatsApp 消息防抖（ms）",
  "channels.signal.dmPolicy": "Signal 私聊策略",
  "channels.imessage.dmPolicy": "iMessage 私聊策略",
  "channels.bluebubbles.dmPolicy": "BlueBubbles 私聊策略",
  "channels.discord.dm.policy": "Discord 私聊策略",
  "channels.discord.retry.attempts": "Discord 重试次数",
  "channels.discord.retry.minDelayMs": "Discord 重试最小延迟（ms）",
  "channels.discord.retry.maxDelayMs": "Discord 重试最大延迟（ms）",
  "channels.discord.retry.jitter": "Discord 重试抖动",
  "channels.discord.maxLinesPerMessage": "Discord 单条最大行数",
  "channels.discord.intents.presence": "Discord Presence Intent",
  "channels.discord.intents.guildMembers": "Discord Guild Members Intent",
  "channels.discord.pluralkit.enabled": "Discord PluralKit 启用",
  "channels.discord.pluralkit.token": "Discord PluralKit Token",
  "channels.slack.dm.policy": "Slack 私聊策略",
  "channels.slack.allowBots": "Slack 允许 Bot 消息",
  "channels.discord.token": "Discord Bot Token",
  "channels.slack.botToken": "Slack Bot Token",
  "channels.slack.appToken": "Slack App Token",
  "channels.slack.userToken": "Slack 用户 Token",
  "channels.slack.userTokenReadOnly": "Slack 用户 Token（只读）",
  "channels.slack.thread.historyScope": "Slack 线程历史范围",
  "channels.slack.thread.inheritParent": "Slack 线程继承父频道",
  "channels.mattermost.botToken": "Mattermost Bot Token",
  "channels.mattermost.baseUrl": "Mattermost Base URL",
  "channels.mattermost.chatmode": "Mattermost 聊天模式",
  "channels.mattermost.oncharPrefixes": "Mattermost 触发前缀",
  "channels.mattermost.requireMention": "Mattermost 要求提及",
  "channels.signal.account": "Signal 账号",
  "channels.imessage.cliPath": "iMessage CLI 路径",
  "channels.*": "渠道配置",
  "channels.*.enabled": "启用该渠道",
  "channels.*.name": "账号名称",
  "channels.*.accounts": "多账号配置",
  "channels.*.accounts.*": "账号配置",
  "channels.*.accounts.*.name": "账号名称",
  "channels.*.accounts.*.enabled": "启用该账号",
  "channels.*.accounts.*.configWrites": "允许写配置",
  "channels.*.capabilities": "能力开关",
  "channels.*.capabilities.*": "能力开关",
  "channels.*.accounts.*.capabilities": "账号能力开关",
  "channels.*.accounts.*.capabilities.*": "账号能力开关",
  "channels.*.groupPolicy": "群聊策略",
  "channels.*.historyLimit": "历史记录上限",
  "channels.*.dmHistoryLimit": "私聊历史上限",
  "channels.*.dms": "私聊配置",
  "channels.*.dms.*": "私聊条目",
  "channels.*.dms.*.historyLimit": "私聊历史上限",
  "channels.*.textChunkLimit": "文本分片上限",
  "channels.*.chunkMode": "文本分片模式",
  "channels.*.blockStreaming": "阻塞流模式",
  "channels.*.blockStreamingCoalesce": "阻塞流合并",
  "channels.*.blockStreamingCoalesce.minChars": "阻塞流合并最小字符",
  "channels.*.blockStreamingCoalesce.maxChars": "阻塞流合并最大字符",
  "channels.*.blockStreamingCoalesce.idleMs": "阻塞流合并空闲时间（ms）",
  "channels.*.mediaMaxMb": "媒体大小上限（MB）",
  "channels.*.markdown": "Markdown 设置",
  "channels.*.markdown.tables": "允许 Markdown 表格",
  "channels.*.allowFrom": "允许来源",
  "channels.*.allowFrom.*": "允许来源条目",
  "channels.*.groupAllowFrom": "群聊允许列表",
  "channels.*.groupAllowFrom.*": "群聊允许条目",
  "channels.*.groups": "群组配置",
  "channels.*.groups.*": "群组条目",
  "channels.*.groups.*.requireMention": "要求提及",
  "channels.*.groups.*.tools": "工具策略",
  "channels.*.groups.*.tools.allow": "工具允许列表",
  "channels.*.groups.*.tools.allow.*": "工具允许条目",
  "channels.*.groups.*.tools.alsoAllow": "工具允许列表补充",
  "channels.*.groups.*.tools.alsoAllow.*": "工具允许条目",
  "channels.*.groups.*.tools.deny": "工具拒绝列表",
  "channels.*.groups.*.tools.deny.*": "工具拒绝条目",
  "channels.*.groups.*.toolsBySender": "按发送者的工具策略",
  "channels.*.groups.*.toolsBySender.*.allow": "允许工具",
  "channels.*.groups.*.toolsBySender.*.allow.*": "允许工具条目",
  "channels.*.groups.*.toolsBySender.*.alsoAllow": "允许工具补充",
  "channels.*.groups.*.toolsBySender.*.alsoAllow.*": "允许工具条目",
  "channels.*.groups.*.toolsBySender.*.deny": "拒绝工具",
  "channels.*.groups.*.toolsBySender.*.deny.*": "拒绝工具条目",
  "channels.*.actions": "动作能力",
  "channels.*.actions.reactions": "允许表情反应",
  "channels.*.actions.sendMessage": "允许发送消息",
  "channels.*.actions.deleteMessage": "允许删除消息",
  "channels.*.actions.sticker": "允许贴纸",
  "channels.*.heartbeat": "心跳提示",
  "channels.*.heartbeat.showOk": "心跳显示正常",
  "channels.*.heartbeat.showAlerts": "心跳显示告警",
  "channels.*.heartbeat.useIndicator": "心跳使用指示灯",
  "channels.*.accounts.*.groupPolicy": "群聊策略",
  "channels.*.accounts.*.historyLimit": "历史记录上限",
  "channels.*.accounts.*.dmHistoryLimit": "私聊历史上限",
  "channels.*.accounts.*.dms": "私聊配置",
  "channels.*.accounts.*.dms.*": "私聊条目",
  "channels.*.accounts.*.dms.*.historyLimit": "私聊历史上限",
  "channels.*.accounts.*.textChunkLimit": "文本分片上限",
  "channels.*.accounts.*.chunkMode": "文本分片模式",
  "channels.*.accounts.*.blockStreaming": "阻塞流模式",
  "channels.*.accounts.*.blockStreamingCoalesce": "阻塞流合并",
  "channels.*.accounts.*.blockStreamingCoalesce.minChars": "阻塞流合并最小字符",
  "channels.*.accounts.*.blockStreamingCoalesce.maxChars": "阻塞流合并最大字符",
  "channels.*.accounts.*.blockStreamingCoalesce.idleMs": "阻塞流合并空闲时间（ms）",
  "channels.*.accounts.*.mediaMaxMb": "媒体大小上限（MB）",
  "channels.*.accounts.*.markdown": "Markdown 设置",
  "channels.*.accounts.*.markdown.tables": "允许 Markdown 表格",
  "channels.*.accounts.*.allowFrom": "允许来源",
  "channels.*.accounts.*.allowFrom.*": "允许来源条目",
  "channels.*.accounts.*.groupAllowFrom": "群聊允许列表",
  "channels.*.accounts.*.groupAllowFrom.*": "群聊允许条目",
  "channels.*.accounts.*.groups": "群组配置",
  "channels.*.accounts.*.groups.*": "群组条目",
  "channels.*.accounts.*.groups.*.requireMention": "要求提及",
  "channels.*.accounts.*.groups.*.tools": "工具策略",
  "channels.*.accounts.*.groups.*.tools.allow": "工具允许列表",
  "channels.*.accounts.*.groups.*.tools.allow.*": "工具允许条目",
  "channels.*.accounts.*.groups.*.tools.alsoAllow": "工具允许列表补充",
  "channels.*.accounts.*.groups.*.tools.alsoAllow.*": "工具允许条目",
  "channels.*.accounts.*.groups.*.tools.deny": "工具拒绝列表",
  "channels.*.accounts.*.groups.*.tools.deny.*": "工具拒绝条目",
  "channels.*.accounts.*.groups.*.toolsBySender": "按发送者的工具策略",
  "channels.*.accounts.*.groups.*.toolsBySender.*.allow": "允许工具",
  "channels.*.accounts.*.groups.*.toolsBySender.*.allow.*": "允许工具条目",
  "channels.*.accounts.*.groups.*.toolsBySender.*.alsoAllow": "允许工具补充",
  "channels.*.accounts.*.groups.*.toolsBySender.*.alsoAllow.*": "允许工具条目",
  "channels.*.accounts.*.groups.*.toolsBySender.*.deny": "拒绝工具",
  "channels.*.accounts.*.groups.*.toolsBySender.*.deny.*": "拒绝工具条目",
  "channels.*.accounts.*.actions": "动作能力",
  "channels.*.accounts.*.actions.reactions": "允许表情反应",
  "channels.*.accounts.*.actions.sendMessage": "允许发送消息",
  "channels.*.accounts.*.actions.deleteMessage": "允许删除消息",
  "channels.*.accounts.*.actions.sticker": "允许贴纸",
  "channels.*.accounts.*.heartbeat": "心跳提示",
  "channels.*.accounts.*.heartbeat.showOk": "心跳显示正常",
  "channels.*.accounts.*.heartbeat.showAlerts": "心跳显示告警",
  "channels.*.accounts.*.heartbeat.useIndicator": "心跳使用指示灯",
  "channels.*.configWrites": "允许写配置",
  "channels.*.groups.*.enabled": "群组启用",
  "channels.*.groups.*.systemPrompt": "群组系统提示",
  "channels.*.accounts.*.groups.*.enabled": "群组启用",
  "channels.*.accounts.*.groups.*.systemPrompt": "群组系统提示",
  "channels.*.draftChunk.minChars": "草稿分片最小字符",
  "channels.*.draftChunk.maxChars": "草稿分片最大字符",
  "channels.*.draftChunk.breakPreference": "草稿分片断点偏好",
  "channels.*.streamMode": "流模式",
  "channels.*.timeoutSeconds": "请求超时（秒）",
  "channels.*.network.autoSelectFamily": "自动选择网络协议族",
  "channels.*.actions.stickers": "贴纸能力",
  "channels.*.actions.emojiUploads": "表情上传能力",
  "channels.*.actions.stickerUploads": "贴纸上传能力",
  "channels.*.actions.threads": "线程能力",
  "channels.*.actions.roleInfo": "角色信息能力",
  "channels.*.actions.roles": "角色管理能力",
  "channels.*.actions.voiceStatus": "语音状态能力",
  "channels.*.actions.events": "事件处理能力",
  "channels.*.actions.moderation": "内容审核能力",
  "channels.*.actions.channels": "频道管理能力",
  "channels.*.guilds": "服务器配置",
  "channels.*.guilds.*": "服务器条目",
  "channels.*.guilds.*.slug": "服务器标识",
  "channels.*.guilds.*.requireMention": "服务器要求提及",
  "channels.*.guilds.*.tools": "服务器工具策略",
  "channels.*.guilds.*.tools.allow": "允许工具列表",
  "channels.*.guilds.*.tools.allow.*": "允许工具条目",
  "channels.*.guilds.*.tools.alsoAllow": "允许工具补充",
  "channels.*.guilds.*.tools.alsoAllow.*": "允许工具条目",
  "channels.*.guilds.*.tools.deny": "拒绝工具列表",
  "channels.*.guilds.*.tools.deny.*": "拒绝工具条目",
  "channels.*.guilds.*.toolsBySender": "按发送者的工具策略",
  "channels.*.guilds.*.toolsBySender.*.allow": "允许工具",
  "channels.*.guilds.*.toolsBySender.*.allow.*": "允许工具条目",
  "channels.*.guilds.*.toolsBySender.*.alsoAllow": "允许工具补充",
  "channels.*.guilds.*.toolsBySender.*.alsoAllow.*": "允许工具条目",
  "channels.*.guilds.*.toolsBySender.*.deny": "拒绝工具",
  "channels.*.guilds.*.toolsBySender.*.deny.*": "拒绝工具条目",
  "channels.*.guilds.*.reactionNotifications": "反应通知",
  "channels.*.guilds.*.users": "服务器用户",
  "channels.*.guilds.*.users.*": "服务器用户条目",
  "channels.*.guilds.*.channels": "服务器频道",
  "channels.*.guilds.*.channels.*": "频道条目",
  "channels.*.guilds.*.channels.*.allow": "允许频道",
  "channels.*.guilds.*.channels.*.requireMention": "频道要求提及",
  "channels.*.guilds.*.channels.*.tools": "频道工具策略",
  "channels.*.guilds.*.channels.*.tools.allow": "允许工具列表",
  "channels.*.guilds.*.channels.*.tools.allow.*": "允许工具条目",
  "channels.*.guilds.*.channels.*.tools.alsoAllow": "允许工具补充",
  "channels.*.guilds.*.channels.*.tools.alsoAllow.*": "允许工具条目",
  "channels.*.guilds.*.channels.*.tools.deny": "拒绝工具列表",
  "channels.*.guilds.*.channels.*.tools.deny.*": "拒绝工具条目",
  "channels.*.guilds.*.channels.*.toolsBySender": "按发送者的工具策略",
  "channels.*.guilds.*.channels.*.toolsBySender.*.allow": "允许工具",
  "channels.*.guilds.*.channels.*.toolsBySender.*.allow.*": "允许工具条目",
  "channels.*.guilds.*.channels.*.toolsBySender.*.alsoAllow": "允许工具补充",
  "channels.*.guilds.*.channels.*.toolsBySender.*.alsoAllow.*": "允许工具条目",
  "channels.*.guilds.*.channels.*.toolsBySender.*.deny": "拒绝工具",
  "channels.*.guilds.*.channels.*.toolsBySender.*.deny.*": "拒绝工具条目",
  "channels.*.guilds.*.channels.*.skills": "频道技能",
  "channels.*.guilds.*.channels.*.skills.*": "频道技能条目",
  "channels.*.guilds.*.channels.*.enabled": "频道启用",
  "channels.*.guilds.*.channels.*.users": "频道用户",
  "channels.*.guilds.*.channels.*.users.*": "频道用户条目",
  "channels.*.guilds.*.channels.*.systemPrompt": "频道系统提示",
  "channels.*.guilds.*.channels.*.autoThread": "自动线程",
  "channels.*.execApprovals": "执行审批",
  "channels.*.execApprovals.enabled": "启用执行审批",
  "channels.*.execApprovals.approvers": "审批人列表",
  "channels.*.execApprovals.approvers.*": "审批人条目",
  "channels.*.execApprovals.agentFilter": "审批 Agent 过滤",
  "channels.*.execApprovals.agentFilter.*": "审批 Agent 条目",
  "channels.*.execApprovals.sessionFilter": "审批会话过滤",
  "channels.*.execApprovals.sessionFilter.*": "审批会话条目",
  "channels.*.intents": "Intent 权限",
  "channels.*.pluralkit": "PluralKit 设置",
  "channels.*.accounts.*.token": "账号令牌",
  "channels.*.accounts.*.maxLinesPerMessage": "单条消息最大行数",
  "channels.*.accounts.*.actions.stickers": "贴纸能力",
  "channels.*.accounts.*.actions.emojiUploads": "表情上传能力",
  "channels.*.accounts.*.actions.stickerUploads": "贴纸上传能力",
  "channels.*.accounts.*.actions.threads": "线程能力",
  "channels.*.accounts.*.actions.roleInfo": "角色信息能力",
  "channels.*.accounts.*.actions.roles": "角色管理能力",
  "channels.*.accounts.*.actions.voiceStatus": "语音状态能力",
  "channels.*.accounts.*.actions.events": "事件处理能力",
  "channels.*.accounts.*.actions.moderation": "内容审核能力",
  "channels.*.accounts.*.actions.channels": "频道管理能力",
  "channels.*.accounts.*.guilds": "服务器配置",
  "channels.*.accounts.*.guilds.*": "服务器条目",
  "channels.*.accounts.*.guilds.*.slug": "服务器标识",
  "channels.*.accounts.*.guilds.*.requireMention": "服务器要求提及",
  "channels.*.accounts.*.guilds.*.tools": "服务器工具策略",
  "channels.*.accounts.*.guilds.*.tools.allow": "允许工具列表",
  "channels.*.accounts.*.guilds.*.tools.allow.*": "允许工具条目",
  "channels.*.accounts.*.guilds.*.tools.alsoAllow": "允许工具补充",
  "channels.*.accounts.*.guilds.*.tools.alsoAllow.*": "允许工具条目",
  "channels.*.accounts.*.guilds.*.tools.deny": "拒绝工具列表",
  "channels.*.accounts.*.guilds.*.tools.deny.*": "拒绝工具条目",
  "channels.*.accounts.*.guilds.*.toolsBySender": "按发送者的工具策略",
  "channels.*.accounts.*.guilds.*.toolsBySender.*.allow": "允许工具",
  "channels.*.accounts.*.guilds.*.toolsBySender.*.allow.*": "允许工具条目",
  "channels.*.accounts.*.guilds.*.toolsBySender.*.alsoAllow": "允许工具补充",
  "channels.*.accounts.*.guilds.*.toolsBySender.*.alsoAllow.*": "允许工具条目",
  "channels.*.accounts.*.guilds.*.toolsBySender.*.deny": "拒绝工具",
  "channels.*.accounts.*.guilds.*.toolsBySender.*.deny.*": "拒绝工具条目",
  "channels.*.accounts.*.guilds.*.reactionNotifications": "反应通知",
  "channels.*.accounts.*.guilds.*.users": "服务器用户",
  "channels.*.accounts.*.guilds.*.users.*": "服务器用户条目",
  "channels.*.accounts.*.guilds.*.channels": "服务器频道",
  "channels.*.accounts.*.guilds.*.channels.*": "频道条目",
  "channels.*.accounts.*.guilds.*.channels.*.allow": "允许频道",
  "channels.*.accounts.*.guilds.*.channels.*.requireMention": "频道要求提及",
  "channels.*.accounts.*.guilds.*.channels.*.tools": "频道工具策略",
  "channels.*.accounts.*.guilds.*.channels.*.tools.allow": "允许工具列表",
  "channels.*.accounts.*.guilds.*.channels.*.tools.allow.*": "允许工具条目",
  "channels.*.accounts.*.guilds.*.channels.*.tools.alsoAllow": "允许工具补充",
  "channels.*.accounts.*.guilds.*.channels.*.tools.alsoAllow.*": "允许工具条目",
  "channels.*.accounts.*.guilds.*.channels.*.tools.deny": "拒绝工具列表",
  "channels.*.accounts.*.guilds.*.channels.*.tools.deny.*": "拒绝工具条目",
  "channels.*.accounts.*.guilds.*.channels.*.toolsBySender": "按发送者的工具策略",
  "channels.*.accounts.*.guilds.*.channels.*.toolsBySender.*.allow": "允许工具",
  "channels.*.accounts.*.guilds.*.channels.*.toolsBySender.*.allow.*": "允许工具条目",
  "channels.*.accounts.*.guilds.*.channels.*.toolsBySender.*.alsoAllow": "允许工具补充",
  "channels.*.accounts.*.guilds.*.channels.*.toolsBySender.*.alsoAllow.*": "允许工具条目",
  "channels.*.accounts.*.guilds.*.channels.*.toolsBySender.*.deny": "拒绝工具",
  "channels.*.accounts.*.guilds.*.channels.*.toolsBySender.*.deny.*": "拒绝工具条目",
  "channels.*.accounts.*.guilds.*.channels.*.skills": "频道技能",
  "channels.*.accounts.*.guilds.*.channels.*.skills.*": "频道技能条目",
  "channels.*.accounts.*.guilds.*.channels.*.enabled": "频道启用",
  "channels.*.accounts.*.guilds.*.channels.*.users": "频道用户",
  "channels.*.accounts.*.guilds.*.channels.*.users.*": "频道用户条目",
  "channels.*.accounts.*.guilds.*.channels.*.systemPrompt": "频道系统提示",
  "channels.*.accounts.*.guilds.*.channels.*.autoThread": "自动线程",
  "channels.*.tools": "工具策略",
  "channels.*.tools.allow": "允许工具列表",
  "channels.*.tools.allow.*": "允许工具条目",
  "channels.*.tools.alsoAllow": "允许工具补充",
  "channels.*.tools.alsoAllow.*": "允许工具条目",
  "channels.*.tools.deny": "拒绝工具列表",
  "channels.*.tools.deny.*": "拒绝工具条目",
  "channels.*.toolsBySender": "按发送者的工具策略",
  "channels.*.toolsBySender.*": "发送者工具策略",
  "channels.*.toolsBySender.*.allow": "允许工具",
  "channels.*.toolsBySender.*.allow.*": "允许工具条目",
  "channels.*.toolsBySender.*.alsoAllow": "允许工具补充",
  "channels.*.toolsBySender.*.alsoAllow.*": "允许工具条目",
  "channels.*.toolsBySender.*.deny": "拒绝工具",
  "channels.*.toolsBySender.*.deny.*": "拒绝工具条目",
  "channels.*.users": "用户列表",
  "channels.*.users.*": "用户条目",
  "channels.*.skills": "技能列表",
  "channels.*.skills.*": "技能条目",
  "channels.*.systemPrompt": "系统提示",
  "channels.*.allow": "允许列表",
  "channels.*.requireMention": "要求提及",
  "channels.*.accounts.*.draftChunk.minChars": "草稿分片最小字符",
  "channels.*.accounts.*.draftChunk.maxChars": "草稿分片最大字符",
  "channels.*.accounts.*.draftChunk.breakPreference": "草稿分片断点偏好",
  "channels.*.accounts.*.streamMode": "流模式",
  "channels.*.accounts.*.timeoutSeconds": "请求超时（秒）",
  "channels.*.accounts.*.network.autoSelectFamily": "自动选择网络协议族",
  "channels.*.accounts.*.execApprovals": "执行审批",
  "channels.*.accounts.*.execApprovals.enabled": "启用执行审批",
  "channels.*.accounts.*.execApprovals.approvers": "审批人列表",
  "channels.*.accounts.*.execApprovals.approvers.*": "审批人条目",
  "channels.*.accounts.*.execApprovals.agentFilter": "审批 Agent 过滤",
  "channels.*.accounts.*.execApprovals.agentFilter.*": "审批 Agent 条目",
  "channels.*.accounts.*.execApprovals.sessionFilter": "审批会话过滤",
  "channels.*.accounts.*.execApprovals.sessionFilter.*": "审批会话条目",
  "channels.*.accounts.*.intents": "Intent 权限",
  "channels.*.accounts.*.intents.presence": "Presence 权限",
  "channels.*.accounts.*.intents.guildMembers": "Guild Members 权限",
  "channels.*.accounts.*.pluralkit": "PluralKit 设置",
  "channels.*.accounts.*.pluralkit.enabled": "启用 PluralKit",
  "channels.*.accounts.*.pluralkit.token": "PluralKit 令牌",
  "channels.*.groups.*.allow": "允许列表",
  "channels.*.groups.*.users": "用户列表",
  "channels.*.groups.*.users.*": "用户条目",
  "channels.*.accounts.*.groups.*.allow": "允许列表",
  "channels.*.accounts.*.groups.*.users": "用户列表",
  "channels.*.accounts.*.groups.*.users.*": "用户条目",
  "channels.*.serviceAccount": "服务账号",
  "channels.*.serviceAccountFile": "服务账号文件",
  "channels.*.audienceType": "受众类型",
  "channels.*.audience": "受众",
  "channels.*.botUser": "机器人用户",
  "channels.*.typingIndicator": "输入指示器",
  "channels.*.defaultAccount": "默认账号",
  "channels.*.mode": "模式",
  "channels.*.signingSecret": "签名密钥",
  "channels.*.replyToModeByChatType": "按聊天类型的回复模式",
  "channels.*.replyToModeByChatType.direct": "私聊回复模式",
  "channels.*.replyToModeByChatType.group": "群聊回复模式",
  "channels.*.replyToModeByChatType.channel": "频道回复模式",
  "channels.*.thread": "线程设置",
  "channels.*.thread.historyScope": "线程历史范围",
  "channels.*.thread.inheritParent": "线程继承父消息",
  "channels.*.actions.emojiList": "表情列表能力",
  "channels.*.slashCommand": "Slash 命令",
  "channels.*.slashCommand.enabled": "启用 Slash 命令",
  "channels.*.slashCommand.name": "Slash 命令名",
  "channels.*.slashCommand.sessionPrefix": "Slash 会话前缀",
  "channels.*.slashCommand.ephemeral": "Slash 临时消息",
  "channels.*.dm.replyToMode": "私聊回复模式",
  "channels.*.channels": "频道配置",
  "channels.*.channels.*": "频道条目",
  "channels.*.channels.*.enabled": "频道启用",
  "channels.*.channels.*.allow": "允许频道",
  "channels.*.channels.*.requireMention": "频道要求提及",
  "channels.*.channels.*.tools": "频道工具策略",
  "channels.*.channels.*.tools.allow": "允许工具列表",
  "channels.*.channels.*.tools.allow.*": "允许工具条目",
  "channels.*.channels.*.tools.alsoAllow": "允许工具补充",
  "channels.*.channels.*.tools.alsoAllow.*": "允许工具条目",
  "channels.*.channels.*.tools.deny": "拒绝工具列表",
  "channels.*.channels.*.tools.deny.*": "拒绝工具条目",
  "channels.*.channels.*.toolsBySender": "按发送者的工具策略",
  "channels.*.channels.*.toolsBySender.*": "发送者工具策略",
  "channels.*.channels.*.toolsBySender.*.allow": "允许工具",
  "channels.*.channels.*.toolsBySender.*.allow.*": "允许工具条目",
  "channels.*.channels.*.toolsBySender.*.alsoAllow": "允许工具补充",
  "channels.*.channels.*.toolsBySender.*.alsoAllow.*": "允许工具条目",
  "channels.*.channels.*.toolsBySender.*.deny": "拒绝工具",
  "channels.*.channels.*.toolsBySender.*.deny.*": "拒绝工具条目",
  "channels.*.channels.*.allowBots": "允许 Bot 消息",
  "channels.*.channels.*.users": "频道用户",
  "channels.*.channels.*.users.*": "频道用户条目",
  "channels.*.channels.*.skills": "频道技能",
  "channels.*.channels.*.skills.*": "频道技能条目",
  "channels.*.channels.*.systemPrompt": "频道系统提示",
  "channels.*.accounts.*.mode": "模式",
  "channels.*.accounts.*.signingSecret": "签名密钥",
  "channels.*.accounts.*.appToken": "App Token",
  "channels.*.accounts.*.userToken": "用户 Token",
  "channels.*.accounts.*.userTokenReadOnly": "用户 Token（只读）",
  "channels.*.accounts.*.replyToModeByChatType": "按聊天类型的回复模式",
  "channels.*.accounts.*.replyToModeByChatType.direct": "私聊回复模式",
  "channels.*.accounts.*.replyToModeByChatType.group": "群聊回复模式",
  "channels.*.accounts.*.replyToModeByChatType.channel": "频道回复模式",
  "channels.*.accounts.*.thread": "线程设置",
  "channels.*.accounts.*.thread.historyScope": "线程历史范围",
  "channels.*.accounts.*.thread.inheritParent": "线程继承父消息",
  "channels.*.accounts.*.actions.emojiList": "表情列表能力",
  "channels.*.accounts.*.slashCommand": "Slash 命令",
  "channels.*.accounts.*.slashCommand.enabled": "启用 Slash 命令",
  "channels.*.accounts.*.slashCommand.name": "Slash 命令名",
  "channels.*.accounts.*.slashCommand.sessionPrefix": "Slash 会话前缀",
  "channels.*.accounts.*.slashCommand.ephemeral": "Slash 临时消息",
  "channels.*.accounts.*.dm.replyToMode": "私聊回复模式",
  "channels.*.accounts.*.channels": "频道配置",
  "channels.*.accounts.*.channels.*": "频道条目",
  "channels.*.accounts.*.channels.*.enabled": "频道启用",
  "channels.*.accounts.*.channels.*.allow": "允许频道",
  "channels.*.accounts.*.channels.*.requireMention": "频道要求提及",
  "channels.*.accounts.*.channels.*.tools": "频道工具策略",
  "channels.*.accounts.*.channels.*.tools.allow": "允许工具列表",
  "channels.*.accounts.*.channels.*.tools.allow.*": "允许工具条目",
  "channels.*.accounts.*.channels.*.tools.alsoAllow": "允许工具补充",
  "channels.*.accounts.*.channels.*.tools.alsoAllow.*": "允许工具条目",
  "channels.*.accounts.*.channels.*.tools.deny": "拒绝工具列表",
  "channels.*.accounts.*.channels.*.tools.deny.*": "拒绝工具条目",
  "channels.*.accounts.*.channels.*.toolsBySender": "按发送者的工具策略",
  "channels.*.accounts.*.channels.*.toolsBySender.*": "发送者工具策略",
  "channels.*.accounts.*.channels.*.toolsBySender.*.allow": "允许工具",
  "channels.*.accounts.*.channels.*.toolsBySender.*.allow.*": "允许工具条目",
  "channels.*.accounts.*.channels.*.toolsBySender.*.alsoAllow": "允许工具补充",
  "channels.*.accounts.*.channels.*.toolsBySender.*.alsoAllow.*": "允许工具条目",
  "channels.*.accounts.*.channels.*.toolsBySender.*.deny": "拒绝工具",
  "channels.*.accounts.*.channels.*.toolsBySender.*.deny.*": "拒绝工具条目",
  "channels.*.accounts.*.channels.*.allowBots": "允许 Bot 消息",
  "channels.*.accounts.*.channels.*.users": "频道用户",
  "channels.*.accounts.*.channels.*.users.*": "频道用户条目",
  "channels.*.accounts.*.channels.*.skills": "频道技能",
  "channels.*.accounts.*.channels.*.skills.*": "频道技能条目",
  "channels.*.accounts.*.channels.*.systemPrompt": "频道系统提示",
  "channels.signal.accounts.*.account": "Signal 账号",
  "channels.*.groups.*.toolsBySender.*": "发送者工具策略",
  "channels.*.accounts.*.groups.*.toolsBySender.*": "发送者工具策略",
  "channels.*.guilds.*.toolsBySender.*": "发送者工具策略",
  "channels.*.guilds.*.channels.*.toolsBySender.*": "发送者工具策略",
  "channels.*.accounts.*.guilds.*.toolsBySender.*": "发送者工具策略",
  "channels.*.accounts.*.guilds.*.channels.*.toolsBySender.*": "发送者工具策略",
  "channels.*.httpUrl": "HTTP 地址",
  "channels.*.httpHost": "HTTP 主机",
  "channels.*.httpPort": "HTTP 端口",
  "channels.*.autoStart": "自动启动",
  "channels.*.startupTimeoutMs": "启动超时（ms）",
  "channels.*.receiveMode": "接收模式",
  "channels.*.ignoreAttachments": "忽略附件",
  "channels.*.ignoreStories": "忽略动态",
  "channels.*.dbPath": "数据库路径",
  "channels.*.remoteHost": "远程主机",
  "channels.*.service": "服务名称",
  "channels.*.region": "区域",
  "channels.*.includeAttachments": "包含附件",
  "channels.*.serverUrl": "服务器地址",
  "channels.*.password": "密码",
  "channels.*.actions.edit": "允许编辑消息",
  "channels.*.actions.unsend": "允许撤回消息",
  "channels.*.actions.reply": "允许回复消息",
  "channels.*.actions.sendWithEffect": "允许特效发送",
  "channels.*.actions.renameGroup": "允许重命名群组",
  "channels.*.actions.setGroupIcon": "允许设置群头像",
  "channels.*.actions.addParticipant": "允许添加成员",
  "channels.*.actions.removeParticipant": "允许移除成员",
  "channels.*.actions.leaveGroup": "允许退出群组",
  "channels.*.actions.sendAttachment": "允许发送附件",
  "channels.*.appId": "App ID",
  "channels.*.appPassword": "App 密码",
  "channels.*.tenantId": "租户 ID",
  "channels.*.webhook": "Webhook 配置",
  "channels.*.webhook.port": "Webhook 端口",
  "channels.*.webhook.path": "Webhook 路径",
  "channels.*.mediaAllowHosts": "媒体允许主机",
  "channels.*.mediaAllowHosts.*": "媒体允许主机条目",
  "channels.*.mediaAuthAllowHosts": "媒体鉴权允许主机",
  "channels.*.mediaAuthAllowHosts.*": "媒体鉴权允许主机条目",
  "channels.*.replyStyle": "回复风格",
  "channels.*.teams": "团队配置",
  "channels.*.teams.*": "团队条目",
  "channels.*.teams.*.requireMention": "团队要求提及",
  "channels.*.teams.*.tools": "团队工具策略",
  "channels.*.teams.*.tools.allow": "允许工具列表",
  "channels.*.teams.*.tools.allow.*": "允许工具条目",
  "channels.*.teams.*.tools.alsoAllow": "允许工具补充",
  "channels.*.teams.*.tools.alsoAllow.*": "允许工具条目",
  "channels.*.teams.*.tools.deny": "拒绝工具列表",
  "channels.*.teams.*.tools.deny.*": "拒绝工具条目",
  "channels.*.teams.*.toolsBySender": "按发送者的工具策略",
  "channels.*.teams.*.toolsBySender.*": "发送者工具策略",
  "channels.*.teams.*.toolsBySender.*.allow": "允许工具",
  "channels.*.teams.*.toolsBySender.*.allow.*": "允许工具条目",
  "channels.*.teams.*.toolsBySender.*.alsoAllow": "允许工具补充",
  "channels.*.teams.*.toolsBySender.*.alsoAllow.*": "允许工具条目",
  "channels.*.teams.*.toolsBySender.*.deny": "拒绝工具",
  "channels.*.teams.*.toolsBySender.*.deny.*": "拒绝工具条目",
  "channels.*.teams.*.replyStyle": "回复风格",
  "channels.*.teams.*.channels": "团队频道",
  "channels.*.teams.*.channels.*": "团队频道条目",
  "channels.*.teams.*.channels.*.requireMention": "频道要求提及",
  "channels.*.teams.*.channels.*.tools": "频道工具策略",
  "channels.*.teams.*.channels.*.tools.allow": "允许工具列表",
  "channels.*.teams.*.channels.*.tools.allow.*": "允许工具条目",
  "channels.*.teams.*.channels.*.tools.alsoAllow": "允许工具补充",
  "channels.*.teams.*.channels.*.tools.alsoAllow.*": "允许工具条目",
  "channels.*.teams.*.channels.*.tools.deny": "拒绝工具列表",
  "channels.*.teams.*.channels.*.tools.deny.*": "拒绝工具条目",
  "channels.*.teams.*.channels.*.toolsBySender": "按发送者的工具策略",
  "channels.*.teams.*.channels.*.toolsBySender.*": "发送者工具策略",
  "channels.*.teams.*.channels.*.toolsBySender.*.allow": "允许工具",
  "channels.*.teams.*.channels.*.toolsBySender.*.allow.*": "允许工具条目",
  "channels.*.teams.*.channels.*.toolsBySender.*.alsoAllow": "允许工具补充",
  "channels.*.teams.*.channels.*.toolsBySender.*.alsoAllow.*": "允许工具条目",
  "channels.*.teams.*.channels.*.toolsBySender.*.deny": "拒绝工具",
  "channels.*.teams.*.channels.*.toolsBySender.*.deny.*": "拒绝工具条目",
  "channels.*.teams.*.channels.*.replyStyle": "回复风格",
  "channels.*.sharePointSiteId": "SharePoint 站点 ID",
  "channels.*.accounts.*.serviceAccount": "服务账号",
  "channels.*.accounts.*.serviceAccountFile": "服务账号文件",
  "channels.*.accounts.*.audienceType": "受众类型",
  "channels.*.accounts.*.audience": "受众",
  "channels.*.accounts.*.botUser": "机器人用户",
  "channels.*.accounts.*.typingIndicator": "输入指示器",
  "channels.*.accounts.*.httpUrl": "HTTP 地址",
  "channels.*.accounts.*.httpHost": "HTTP 主机",
  "channels.*.accounts.*.httpPort": "HTTP 端口",
  "channels.*.accounts.*.autoStart": "自动启动",
  "channels.*.accounts.*.startupTimeoutMs": "启动超时（ms）",
  "channels.*.accounts.*.receiveMode": "接收模式",
  "channels.*.accounts.*.ignoreAttachments": "忽略附件",
  "channels.*.accounts.*.ignoreStories": "忽略动态",
  "channels.*.accounts.*.dbPath": "数据库路径",
  "channels.*.accounts.*.remoteHost": "远程主机",
  "channels.*.accounts.*.service": "服务名称",
  "channels.*.accounts.*.region": "区域",
  "channels.*.accounts.*.includeAttachments": "包含附件",
  "channels.*.accounts.*.serverUrl": "服务器地址",
  "channels.*.accounts.*.password": "密码",
  "channels.*.accounts.*.actions.edit": "允许编辑消息",
  "channels.*.accounts.*.actions.unsend": "允许撤回消息",
  "channels.*.accounts.*.actions.reply": "允许回复消息",
  "channels.*.accounts.*.actions.sendWithEffect": "允许特效发送",
  "channels.*.accounts.*.actions.renameGroup": "允许重命名群组",
  "channels.*.accounts.*.actions.setGroupIcon": "允许设置群头像",
  "channels.*.accounts.*.actions.addParticipant": "允许添加成员",
  "channels.*.accounts.*.actions.removeParticipant": "允许移除成员",
  "channels.*.accounts.*.actions.leaveGroup": "允许退出群组",
  "channels.*.accounts.*.actions.sendAttachment": "允许发送附件",
  "channels.*.accounts.*.appId": "App ID",
  "channels.*.accounts.*.appPassword": "App 密码",
  "channels.*.accounts.*.tenantId": "租户 ID",
  "channels.*.accounts.*.webhook": "Webhook 配置",
  "channels.*.accounts.*.webhook.port": "Webhook 端口",
  "channels.*.accounts.*.webhook.path": "Webhook 路径",
  "channels.*.accounts.*.mediaAllowHosts": "媒体允许主机",
  "channels.*.accounts.*.mediaAllowHosts.*": "媒体允许主机条目",
  "channels.*.accounts.*.mediaAuthAllowHosts": "媒体鉴权允许主机",
  "channels.*.accounts.*.mediaAuthAllowHosts.*": "媒体鉴权允许主机条目",
  "channels.*.accounts.*.replyStyle": "回复风格",
  "channels.*.accounts.*.teams": "团队配置",
  "channels.*.accounts.*.teams.*": "团队条目",
  "channels.*.accounts.*.teams.*.requireMention": "团队要求提及",
  "channels.*.accounts.*.teams.*.tools": "团队工具策略",
  "channels.*.accounts.*.teams.*.tools.allow": "允许工具列表",
  "channels.*.accounts.*.teams.*.tools.allow.*": "允许工具条目",
  "channels.*.accounts.*.teams.*.tools.alsoAllow": "允许工具补充",
  "channels.*.accounts.*.teams.*.tools.alsoAllow.*": "允许工具条目",
  "channels.*.accounts.*.teams.*.tools.deny": "拒绝工具列表",
  "channels.*.accounts.*.teams.*.tools.deny.*": "拒绝工具条目",
  "channels.*.accounts.*.teams.*.toolsBySender": "按发送者的工具策略",
  "channels.*.accounts.*.teams.*.toolsBySender.*": "发送者工具策略",
  "channels.*.accounts.*.teams.*.toolsBySender.*.allow": "允许工具",
  "channels.*.accounts.*.teams.*.toolsBySender.*.allow.*": "允许工具条目",
  "channels.*.accounts.*.teams.*.toolsBySender.*.alsoAllow": "允许工具补充",
  "channels.*.accounts.*.teams.*.toolsBySender.*.alsoAllow.*": "允许工具条目",
  "channels.*.accounts.*.teams.*.toolsBySender.*.deny": "拒绝工具",
  "channels.*.accounts.*.teams.*.toolsBySender.*.deny.*": "拒绝工具条目",
  "channels.*.accounts.*.teams.*.replyStyle": "回复风格",
  "channels.*.accounts.*.teams.*.channels": "团队频道",
  "channels.*.accounts.*.teams.*.channels.*": "团队频道条目",
  "channels.*.accounts.*.teams.*.channels.*.requireMention": "频道要求提及",
  "channels.*.accounts.*.teams.*.channels.*.tools": "频道工具策略",
  "channels.*.accounts.*.teams.*.channels.*.tools.allow": "允许工具列表",
  "channels.*.accounts.*.teams.*.channels.*.tools.allow.*": "允许工具条目",
  "channels.*.accounts.*.teams.*.channels.*.tools.alsoAllow": "允许工具补充",
  "channels.*.accounts.*.teams.*.channels.*.tools.alsoAllow.*": "允许工具条目",
  "channels.*.accounts.*.teams.*.channels.*.tools.deny": "拒绝工具列表",
  "channels.*.accounts.*.teams.*.channels.*.tools.deny.*": "拒绝工具条目",
  "channels.*.accounts.*.teams.*.channels.*.toolsBySender": "按发送者的工具策略",
  "channels.*.accounts.*.teams.*.channels.*.toolsBySender.*": "发送者工具策略",
  "channels.*.accounts.*.teams.*.channels.*.toolsBySender.*.allow": "允许工具",
  "channels.*.accounts.*.teams.*.channels.*.toolsBySender.*.allow.*": "允许工具条目",
  "channels.*.accounts.*.teams.*.channels.*.toolsBySender.*.alsoAllow": "允许工具补充",
  "channels.*.accounts.*.teams.*.channels.*.toolsBySender.*.alsoAllow.*": "允许工具条目",
  "channels.*.accounts.*.teams.*.channels.*.toolsBySender.*.deny": "拒绝工具",
  "channels.*.accounts.*.teams.*.channels.*.toolsBySender.*.deny.*": "拒绝工具条目",
  "channels.*.accounts.*.teams.*.channels.*.replyStyle": "回复风格",
  "channels.*.accounts.*.sharePointSiteId": "SharePoint 站点 ID",
  "channels.*.dmPolicy": "私聊策略",
  "channels.*.replyToMode": "回复模式",
  "channels.*.webhookUrl": "Webhook 地址",
  "channels.*.webhookPath": "Webhook 路径",
  "channels.*.webhookSecret": "Webhook 密钥",
  "channels.*.sendReadReceipts": "发送已读回执",
  "channels.*.commands": "渠道命令",
  "channels.*.commands.native": "原生命令",
  "channels.*.commands.nativeSkills": "原生技能命令",
  "channels.*.reactionNotifications": "反应通知",
  "channels.*.reactionLevel": "反应级别",
  "channels.*.reactionAllowlist": "反应允许列表",
  "channels.*.reactionAllowlist.*": "反应允许条目",
  "channels.*.dm": "私聊配置",
  "channels.*.dm.enabled": "启用私聊",
  "channels.*.dm.policy": "私聊策略",
  "channels.*.dm.allowFrom": "私聊允许来源",
  "channels.*.dm.allowFrom.*": "私聊允许来源条目",
  "channels.*.dm.groupEnabled": "私聊群转发",
  "channels.*.dm.groupChannels": "私聊群频道列表",
  "channels.*.dm.groupChannels.*": "私聊群频道条目",
  "channels.*.allowBots": "允许 Bot 消息",
  "channels.*.actions.polls": "允许投票",
  "channels.*.actions.permissions": "权限查询能力",
  "channels.*.actions.messages": "消息读取能力",
  "channels.*.actions.pins": "置顶消息能力",
  "channels.*.actions.search": "消息搜索能力",
  "channels.*.actions.memberInfo": "成员信息能力",
  "channels.*.actions.channelInfo": "频道信息能力",
  "channels.*.retry": "重试策略",
  "channels.*.retry.attempts": "重试次数",
  "channels.*.retry.minDelayMs": "重试最小延迟（ms）",
  "channels.*.retry.maxDelayMs": "重试最大延迟（ms）",
  "channels.*.retry.jitter": "重试抖动系数",
  "channels.*.botToken": "机器人令牌",
  "channels.*.tokenFile": "令牌文件",
  "channels.*.cliPath": "CLI 路径",
  "channels.*.messagePrefix": "消息前缀",
  "channels.*.authDir": "认证目录",
  "channels.*.selfChatMode": "自聊模式",
  "channels.*.ackReaction": "确认表情",
  "channels.*.ackReaction.emoji": "确认表情内容",
  "channels.*.ackReaction.direct": "私聊确认表情",
  "channels.*.ackReaction.group": "群聊确认表情",
  "channels.*.debounceMs": "消息防抖（ms）",
  "channels.*.customCommands": "自定义命令",
  "channels.*.customCommands.*": "自定义命令条目",
  "channels.*.customCommands.*.command": "命令名称",
  "channels.*.customCommands.*.description": "命令描述",
  "channels.*.groups.*.skills": "群组技能",
  "channels.*.groups.*.skills.*": "群组技能条目",
  "channels.*.groups.*.allowFrom": "群组允许来源",
  "channels.*.groups.*.allowFrom.*": "群组允许来源条目",
  "channels.*.groups.*.topics": "群组话题",
  "channels.*.groups.*.topics.*": "话题条目",
  "channels.*.groups.*.topics.*.requireMention": "话题要求提及",
  "channels.*.groups.*.topics.*.skills": "话题技能",
  "channels.*.groups.*.topics.*.skills.*": "话题技能条目",
  "channels.*.groups.*.topics.*.enabled": "话题启用",
  "channels.*.groups.*.topics.*.allowFrom": "话题允许来源",
  "channels.*.groups.*.topics.*.allowFrom.*": "话题允许来源条目",
  "channels.*.groups.*.topics.*.systemPrompt": "话题系统提示",
  "channels.*.draftChunk": "草稿分片",
  "channels.*.network": "网络配置",
  "channels.*.proxy": "代理地址",
  "channels.*.linkPreview": "链接预览",
  "channels.*.accounts.*.dmPolicy": "私聊策略",
  "channels.*.accounts.*.replyToMode": "回复模式",
  "channels.*.accounts.*.webhookUrl": "Webhook 地址",
  "channels.*.accounts.*.webhookPath": "Webhook 路径",
  "channels.*.accounts.*.webhookSecret": "Webhook 密钥",
  "channels.*.accounts.*.sendReadReceipts": "发送已读回执",
  "channels.*.accounts.*.commands": "渠道命令",
  "channels.*.accounts.*.commands.native": "原生命令",
  "channels.*.accounts.*.commands.nativeSkills": "原生技能命令",
  "channels.*.accounts.*.reactionNotifications": "反应通知",
  "channels.*.accounts.*.reactionLevel": "反应级别",
  "channels.*.accounts.*.reactionAllowlist": "反应允许列表",
  "channels.*.accounts.*.reactionAllowlist.*": "反应允许条目",
  "channels.*.accounts.*.dm": "私聊配置",
  "channels.*.accounts.*.dm.enabled": "启用私聊",
  "channels.*.accounts.*.dm.policy": "私聊策略",
  "channels.*.accounts.*.dm.allowFrom": "私聊允许来源",
  "channels.*.accounts.*.dm.allowFrom.*": "私聊允许来源条目",
  "channels.*.accounts.*.dm.groupEnabled": "私聊群转发",
  "channels.*.accounts.*.dm.groupChannels": "私聊群频道列表",
  "channels.*.accounts.*.dm.groupChannels.*": "私聊群频道条目",
  "channels.*.accounts.*.allowBots": "允许 Bot 消息",
  "channels.*.accounts.*.requireMention": "要求提及",
  "channels.*.accounts.*.actions.polls": "允许投票",
  "channels.*.accounts.*.actions.permissions": "权限查询能力",
  "channels.*.accounts.*.actions.messages": "消息读取能力",
  "channels.*.accounts.*.actions.pins": "置顶消息能力",
  "channels.*.accounts.*.actions.search": "消息搜索能力",
  "channels.*.accounts.*.actions.memberInfo": "成员信息能力",
  "channels.*.accounts.*.actions.channelInfo": "频道信息能力",
  "channels.*.accounts.*.retry": "重试策略",
  "channels.*.accounts.*.retry.attempts": "重试次数",
  "channels.*.accounts.*.retry.minDelayMs": "重试最小延迟（ms）",
  "channels.*.accounts.*.retry.maxDelayMs": "重试最大延迟（ms）",
  "channels.*.accounts.*.retry.jitter": "重试抖动系数",
  "channels.*.accounts.*.botToken": "机器人令牌",
  "channels.*.accounts.*.tokenFile": "令牌文件",
  "channels.*.accounts.*.cliPath": "CLI 路径",
  "channels.*.accounts.*.messagePrefix": "消息前缀",
  "channels.*.accounts.*.authDir": "认证目录",
  "channels.*.accounts.*.selfChatMode": "自聊模式",
  "channels.*.accounts.*.ackReaction": "确认表情",
  "channels.*.accounts.*.ackReaction.emoji": "确认表情内容",
  "channels.*.accounts.*.ackReaction.direct": "私聊确认表情",
  "channels.*.accounts.*.ackReaction.group": "群聊确认表情",
  "channels.*.accounts.*.debounceMs": "消息防抖（ms）",
  "channels.*.accounts.*.customCommands": "自定义命令",
  "channels.*.accounts.*.customCommands.*": "自定义命令条目",
  "channels.*.accounts.*.customCommands.*.command": "命令名称",
  "channels.*.accounts.*.customCommands.*.description": "命令描述",
  "channels.*.accounts.*.groups.*.skills": "群组技能",
  "channels.*.accounts.*.groups.*.skills.*": "群组技能条目",
  "channels.*.accounts.*.groups.*.allowFrom": "群组允许来源",
  "channels.*.accounts.*.groups.*.allowFrom.*": "群组允许来源条目",
  "channels.*.accounts.*.groups.*.topics": "群组话题",
  "channels.*.accounts.*.groups.*.topics.*": "话题条目",
  "channels.*.accounts.*.groups.*.topics.*.requireMention": "话题要求提及",
  "channels.*.accounts.*.groups.*.topics.*.skills": "话题技能",
  "channels.*.accounts.*.groups.*.topics.*.skills.*": "话题技能条目",
  "channels.*.accounts.*.groups.*.topics.*.enabled": "话题启用",
  "channels.*.accounts.*.groups.*.topics.*.allowFrom": "话题允许来源",
  "channels.*.accounts.*.groups.*.topics.*.allowFrom.*": "话题允许来源条目",
  "channels.*.accounts.*.groups.*.topics.*.systemPrompt": "话题系统提示",
  "channels.*.accounts.*.draftChunk": "草稿分片",
  "channels.*.accounts.*.network": "网络配置",
  "channels.*.accounts.*.proxy": "代理地址",
  "channels.*.accounts.*.linkPreview": "链接预览",
  "agents.list[].skills": "Agent 技能筛选",
  "agents.list[].identity.avatar": "Agent 头像",
  "discovery.mdns.mode": "mDNS 发现模式",
  "plugins.enabled": "启用插件",
  "plugins.allow": "插件允许列表",
  "plugins.deny": "插件拒绝列表",
  "plugins.load.paths": "插件加载路径",
  "plugins.slots": "插件槽位",
  "plugins.slots.memory": "记忆插件",
  "plugins.entries": "插件条目",
  "plugins.entries.*.enabled": "插件启用",
  "plugins.entries.*.config": "插件配置",
  "plugins.installs": "插件安装记录",
  "plugins.installs.*.source": "插件安装来源",
  "plugins.installs.*.spec": "插件安装 Spec",
  "plugins.installs.*.sourcePath": "插件安装来源路径",
  "plugins.installs.*.installPath": "插件安装路径",
  "plugins.installs.*.version": "插件安装版本",
  "plugins.installs.*.installedAt": "插件安装时间",
};

const FIELD_HELP: Record<string, string> = {
  "meta.lastTouchedVersion": "Auto-set when OpenClaw writes the config.",
  "meta.lastTouchedAt": "ISO timestamp of the last config write (auto-set).",
  "update.channel": 'Update channel for git + npm installs ("stable", "beta", or "dev").',
  "update.checkOnStart": "Check for npm updates when the gateway starts (default: true).",
  "gateway.remote.url": "Remote Gateway WebSocket URL (ws:// or wss://).",
  "gateway.remote.tlsFingerprint":
    "Expected sha256 TLS fingerprint for the remote gateway (pin to avoid MITM).",
  "gateway.remote.sshTarget":
    "Remote gateway over SSH (tunnels the gateway port to localhost). Format: user@host or user@host:port.",
  "gateway.remote.sshIdentity": "Optional SSH identity file path (passed to ssh -i).",
  "agents.list.*.skills":
    "Optional allowlist of skills for this agent (omit = all skills; empty = no skills).",
  "agents.list[].skills":
    "Optional allowlist of skills for this agent (omit = all skills; empty = no skills).",
  "agents.list[].identity.avatar":
    "Avatar image path (relative to the agent workspace only) or a remote URL/data URL.",
  "discovery.mdns.mode":
    'mDNS broadcast mode ("minimal" default, "full" includes cliPath/sshPort, "off" disables mDNS).',
  "gateway.auth.token":
    "Required by default for gateway access (unless using Tailscale Serve identity); required for non-loopback binds.",
  "gateway.auth.password": "Required for Tailscale funnel.",
  "gateway.controlUi.basePath":
    "Optional URL prefix where the Control UI is served (e.g. /openclaw).",
  "gateway.controlUi.root":
    "Optional filesystem root for Control UI assets (defaults to dist/control-ui).",
  "gateway.controlUi.allowedOrigins":
    "Allowed browser origins for Control UI/WebChat websocket connections (full origins only, e.g. https://control.example.com).",
  "gateway.controlUi.allowInsecureAuth":
    "Allow Control UI auth over insecure HTTP (token-only; not recommended).",
  "gateway.controlUi.dangerouslyDisableDeviceAuth":
    "DANGEROUS. Disable Control UI device identity checks (token/password only).",
  "gateway.http.endpoints.chatCompletions.enabled":
    "Enable the OpenAI-compatible `POST /v1/chat/completions` endpoint (default: false).",
  "gateway.reload.mode": 'Hot reload strategy for config changes ("hybrid" recommended).',
  "gateway.reload.debounceMs": "Debounce window (ms) before applying config changes.",
  "gateway.nodes.browser.mode":
    'Node browser routing ("auto" = pick single connected browser node, "manual" = require node param, "off" = disable).',
  "gateway.nodes.browser.node": "Pin browser routing to a specific node id or name (optional).",
  "gateway.nodes.allowCommands":
    "Extra node.invoke commands to allow beyond the gateway defaults (array of command strings).",
  "gateway.nodes.denyCommands":
    "Commands to block even if present in node claims or default allowlist.",
  "nodeHost.browserProxy.enabled": "Expose the local browser control server via node proxy.",
  "nodeHost.browserProxy.allowProfiles":
    "Optional allowlist of browser profile names exposed via the node proxy.",
  "diagnostics.flags":
    'Enable targeted diagnostics logs by flag (e.g. ["telegram.http"]). Supports wildcards like "telegram.*" or "*".',
  "diagnostics.cacheTrace.enabled":
    "Log cache trace snapshots for embedded agent runs (default: false).",
  "diagnostics.cacheTrace.filePath":
    "JSONL output path for cache trace logs (default: $OPENCLAW_STATE_DIR/logs/cache-trace.jsonl).",
  "diagnostics.cacheTrace.includeMessages":
    "Include full message payloads in trace output (default: true).",
  "diagnostics.cacheTrace.includePrompt": "Include prompt text in trace output (default: true).",
  "diagnostics.cacheTrace.includeSystem": "Include system prompt in trace output (default: true).",
  "tools.exec.applyPatch.enabled":
    "Experimental. Enables apply_patch for OpenAI models when allowed by tool policy.",
  "tools.exec.applyPatch.allowModels":
    'Optional allowlist of model ids (e.g. "gpt-5.2" or "openai/gpt-5.2").',
  "tools.exec.notifyOnExit":
    "When true (default), backgrounded exec sessions enqueue a system event and request a heartbeat on exit.",
  "tools.exec.pathPrepend": "Directories to prepend to PATH for exec runs (gateway/sandbox).",
  "tools.exec.safeBins":
    "Allow stdin-only safe binaries to run without explicit allowlist entries.",
  "tools.message.allowCrossContextSend":
    "Legacy override: allow cross-context sends across all providers.",
  "tools.message.crossContext.allowWithinProvider":
    "Allow sends to other channels within the same provider (default: true).",
  "tools.message.crossContext.allowAcrossProviders":
    "Allow sends across different providers (default: false).",
  "tools.message.crossContext.marker.enabled":
    "Add a visible origin marker when sending cross-context (default: true).",
  "tools.message.crossContext.marker.prefix":
    'Text prefix for cross-context markers (supports "{channel}").',
  "tools.message.crossContext.marker.suffix":
    'Text suffix for cross-context markers (supports "{channel}").',
  "tools.message.broadcast.enabled": "Enable broadcast action (default: true).",
  "tools.web.search.enabled": "Enable the web_search tool (requires a provider API key).",
  "tools.web.search.provider": 'Search provider ("brave" or "perplexity").',
  "tools.web.search.apiKey": "Brave Search API key (fallback: BRAVE_API_KEY env var).",
  "tools.web.search.maxResults": "Default number of results to return (1-10).",
  "tools.web.search.timeoutSeconds": "Timeout in seconds for web_search requests.",
  "tools.web.search.cacheTtlMinutes": "Cache TTL in minutes for web_search results.",
  "tools.web.search.perplexity.apiKey":
    "Perplexity or OpenRouter API key (fallback: PERPLEXITY_API_KEY or OPENROUTER_API_KEY env var).",
  "tools.web.search.perplexity.baseUrl":
    "Perplexity base URL override (default: https://openrouter.ai/api/v1 or https://api.perplexity.ai).",
  "tools.web.search.perplexity.model":
    'Perplexity model override (default: "perplexity/sonar-pro").',
  "tools.web.fetch.enabled": "Enable the web_fetch tool (lightweight HTTP fetch).",
  "tools.web.fetch.maxChars": "Max characters returned by web_fetch (truncated).",
  "tools.web.fetch.maxCharsCap":
    "Hard cap for web_fetch maxChars (applies to config and tool calls).",
  "tools.web.fetch.timeoutSeconds": "Timeout in seconds for web_fetch requests.",
  "tools.web.fetch.cacheTtlMinutes": "Cache TTL in minutes for web_fetch results.",
  "tools.web.fetch.maxRedirects": "Maximum redirects allowed for web_fetch (default: 3).",
  "tools.web.fetch.userAgent": "Override User-Agent header for web_fetch requests.",
  "tools.web.fetch.readability":
    "Use Readability to extract main content from HTML (fallbacks to basic HTML cleanup).",
  "tools.web.fetch.firecrawl.enabled": "Enable Firecrawl fallback for web_fetch (if configured).",
  "tools.web.fetch.firecrawl.apiKey": "Firecrawl API key (fallback: FIRECRAWL_API_KEY env var).",
  "tools.web.fetch.firecrawl.baseUrl":
    "Firecrawl base URL (e.g. https://api.firecrawl.dev or custom endpoint).",
  "tools.web.fetch.firecrawl.onlyMainContent":
    "When true, Firecrawl returns only the main content (default: true).",
  "tools.web.fetch.firecrawl.maxAgeMs":
    "Firecrawl maxAge (ms) for cached results when supported by the API.",
  "tools.web.fetch.firecrawl.timeoutSeconds": "Timeout in seconds for Firecrawl requests.",
  "channels.slack.allowBots":
    "Allow bot-authored messages to trigger Slack replies (default: false).",
  "channels.slack.thread.historyScope":
    'Scope for Slack thread history context ("thread" isolates per thread; "channel" reuses channel history).',
  "channels.slack.thread.inheritParent":
    "If true, Slack thread sessions inherit the parent channel transcript (default: false).",
  "channels.mattermost.botToken":
    "Bot token from Mattermost System Console -> Integrations -> Bot Accounts.",
  "channels.mattermost.baseUrl":
    "Base URL for your Mattermost server (e.g., https://chat.example.com).",
  "channels.mattermost.chatmode":
    'Reply to channel messages on mention ("oncall"), on trigger chars (">" or "!") ("onchar"), or on every message ("onmessage").',
  "channels.mattermost.oncharPrefixes": 'Trigger prefixes for onchar mode (default: [">", "!"]).',
  "channels.mattermost.requireMention":
    "Require @mention in channels before responding (default: true).",
  "auth.profiles": "Named auth profiles (provider + mode + optional email).",
  "auth.order": "Ordered auth profile IDs per provider (used for automatic failover).",
  "auth.cooldowns.billingBackoffHours":
    "Base backoff (hours) when a profile fails due to billing/insufficient credits (default: 5).",
  "auth.cooldowns.billingBackoffHoursByProvider":
    "Optional per-provider overrides for billing backoff (hours).",
  "auth.cooldowns.billingMaxHours": "Cap (hours) for billing backoff (default: 24).",
  "auth.cooldowns.failureWindowHours": "Failure window (hours) for backoff counters (default: 24).",
  "agents.defaults.bootstrapMaxChars":
    "Max characters of each workspace bootstrap file injected into the system prompt before truncation (default: 20000).",
  "agents.defaults.repoRoot":
    "Optional repository root shown in the system prompt runtime line (overrides auto-detect).",
  "agents.defaults.envelopeTimezone":
    'Timezone for message envelopes ("utc", "local", "user", or an IANA timezone string).',
  "agents.defaults.envelopeTimestamp":
    'Include absolute timestamps in message envelopes ("on" or "off").',
  "agents.defaults.envelopeElapsed": 'Include elapsed time in message envelopes ("on" or "off").',
  "agents.defaults.models": "Configured model catalog (keys are full provider/model IDs).",
  "agents.defaults.memorySearch":
    "Vector search over MEMORY.md and memory/*.md (per-agent overrides supported).",
  "agents.defaults.memorySearch.sources":
    'Sources to index for memory search (default: ["memory"]; add "sessions" to include session transcripts).',
  "agents.defaults.memorySearch.extraPaths":
    "Extra paths to include in memory search (directories or .md files; relative paths resolved from workspace).",
  "agents.defaults.memorySearch.experimental.sessionMemory":
    "Enable experimental session transcript indexing for memory search (default: false).",
  "agents.defaults.memorySearch.provider":
    'Embedding provider ("openai", "gemini", "voyage", or "local").',
  "agents.defaults.memorySearch.remote.baseUrl":
    "Custom base URL for remote embeddings (OpenAI-compatible proxies or Gemini overrides).",
  "agents.defaults.memorySearch.remote.apiKey": "Custom API key for the remote embedding provider.",
  "agents.defaults.memorySearch.remote.headers":
    "Extra headers for remote embeddings (merged; remote overrides OpenAI headers).",
  "agents.defaults.memorySearch.remote.batch.enabled":
    "Enable batch API for memory embeddings (OpenAI/Gemini; default: true).",
  "agents.defaults.memorySearch.remote.batch.wait":
    "Wait for batch completion when indexing (default: true).",
  "agents.defaults.memorySearch.remote.batch.concurrency":
    "Max concurrent embedding batch jobs for memory indexing (default: 2).",
  "agents.defaults.memorySearch.remote.batch.pollIntervalMs":
    "Polling interval in ms for batch status (default: 2000).",
  "agents.defaults.memorySearch.remote.batch.timeoutMinutes":
    "Timeout in minutes for batch indexing (default: 60).",
  "agents.defaults.memorySearch.local.modelPath":
    "Local GGUF model path or hf: URI (node-llama-cpp).",
  "agents.defaults.memorySearch.fallback":
    'Fallback provider when embeddings fail ("openai", "gemini", "local", or "none").',
  "agents.defaults.memorySearch.store.path":
    "SQLite index path (default: ~/.openclaw/memory/{agentId}.sqlite).",
  "agents.defaults.memorySearch.store.vector.enabled":
    "Enable sqlite-vec extension for vector search (default: true).",
  "agents.defaults.memorySearch.store.vector.extensionPath":
    "Optional override path to sqlite-vec extension library (.dylib/.so/.dll).",
  "agents.defaults.memorySearch.query.hybrid.enabled":
    "Enable hybrid BM25 + vector search for memory (default: true).",
  "agents.defaults.memorySearch.query.hybrid.vectorWeight":
    "Weight for vector similarity when merging results (0-1).",
  "agents.defaults.memorySearch.query.hybrid.textWeight":
    "Weight for BM25 text relevance when merging results (0-1).",
  "agents.defaults.memorySearch.query.hybrid.candidateMultiplier":
    "Multiplier for candidate pool size (default: 4).",
  "agents.defaults.memorySearch.cache.enabled":
    "Cache chunk embeddings in SQLite to speed up reindexing and frequent updates (default: true).",
  memory: "Memory backend configuration (global).",
  "memory.backend": 'Memory backend ("builtin" for OpenClaw embeddings, "qmd" for QMD sidecar).',
  "memory.citations": 'Default citation behavior ("auto", "on", or "off").',
  "memory.qmd.command": "Path to the qmd binary (default: resolves from PATH).",
  "memory.qmd.includeDefaultMemory":
    "Whether to automatically index MEMORY.md + memory/**/*.md (default: true).",
  "memory.qmd.paths":
    "Additional directories/files to index with QMD (path + optional glob pattern).",
  "memory.qmd.paths.path": "Absolute or ~-relative path to index via QMD.",
  "memory.qmd.paths.pattern": "Glob pattern relative to the path root (default: **/*.md).",
  "memory.qmd.paths.name":
    "Optional stable name for the QMD collection (default derived from path).",
  "memory.qmd.sessions.enabled":
    "Enable QMD session transcript indexing (experimental, default: false).",
  "memory.qmd.sessions.exportDir":
    "Override directory for sanitized session exports before indexing.",
  "memory.qmd.sessions.retentionDays":
    "Retention window for exported sessions before pruning (default: unlimited).",
  "memory.qmd.update.interval":
    "How often the QMD sidecar refreshes indexes (duration string, default: 5m).",
  "memory.qmd.update.debounceMs":
    "Minimum delay between successive QMD refresh runs (default: 15000).",
  "memory.qmd.update.onBoot": "Run QMD update once on gateway startup (default: true).",
  "memory.qmd.update.embedInterval":
    "How often QMD embeddings are refreshed (duration string, default: 60m). Set to 0 to disable periodic embed.",
  "memory.qmd.limits.maxResults": "Max QMD results returned to the agent loop (default: 6).",
  "memory.qmd.limits.maxSnippetChars": "Max characters per snippet pulled from QMD (default: 700).",
  "memory.qmd.limits.maxInjectedChars": "Max total characters injected from QMD hits per turn.",
  "memory.qmd.limits.timeoutMs": "Per-query timeout for QMD searches (default: 4000).",
  "memory.qmd.scope":
    "Session/channel scope for QMD recall (same syntax as session.sendPolicy; default: direct-only).",
  "agents.defaults.memorySearch.cache.maxEntries":
    "Optional cap on cached embeddings (best-effort).",
  "agents.defaults.memorySearch.sync.onSearch":
    "Lazy sync: schedule a reindex on search after changes.",
  "agents.defaults.memorySearch.sync.watch": "Watch memory files for changes (chokidar).",
  "agents.defaults.memorySearch.sync.sessions.deltaBytes":
    "Minimum appended bytes before session transcripts trigger reindex (default: 100000).",
  "agents.defaults.memorySearch.sync.sessions.deltaMessages":
    "Minimum appended JSONL lines before session transcripts trigger reindex (default: 50).",
  "plugins.enabled": "Enable plugin/extension loading (default: true).",
  "plugins.allow": "Optional allowlist of plugin ids; when set, only listed plugins load.",
  "plugins.deny": "Optional denylist of plugin ids; deny wins over allowlist.",
  "plugins.load.paths": "Additional plugin files or directories to load.",
  "plugins.slots": "Select which plugins own exclusive slots (memory, etc.).",
  "plugins.slots.memory":
    'Select the active memory plugin by id, or "none" to disable memory plugins.',
  "plugins.entries": "Per-plugin settings keyed by plugin id (enable/disable + config payloads).",
  "plugins.entries.*.enabled": "Overrides plugin enable/disable for this entry (restart required).",
  "plugins.entries.*.config": "Plugin-defined config payload (schema is provided by the plugin).",
  "plugins.installs":
    "CLI-managed install metadata (used by `openclaw plugins update` to locate install sources).",
  "plugins.installs.*.source": 'Install source ("npm", "archive", or "path").',
  "plugins.installs.*.spec": "Original npm spec used for install (if source is npm).",
  "plugins.installs.*.sourcePath": "Original archive/path used for install (if any).",
  "plugins.installs.*.installPath":
    "Resolved install directory (usually ~/.openclaw/extensions/<id>).",
  "plugins.installs.*.version": "Version recorded at install time (if available).",
  "plugins.installs.*.installedAt": "ISO timestamp of last install/update.",
  "agents.list.*.identity.avatar":
    "Agent avatar (workspace-relative path, http(s) URL, or data URI).",
  "agents.defaults.model.primary": "Primary model (provider/model).",
  "agents.defaults.model.fallbacks":
    "Ordered fallback models (provider/model). Used when the primary model fails.",
  "agents.defaults.imageModel.primary":
    "Optional image model (provider/model) used when the primary model lacks image input.",
  "agents.defaults.imageModel.fallbacks": "Ordered fallback image models (provider/model).",
  "agents.defaults.cliBackends": "Optional CLI backends for text-only fallback (claude-cli, etc.).",
  "agents.defaults.humanDelay.mode": 'Delay style for block replies ("off", "natural", "custom").',
  "agents.defaults.humanDelay.minMs": "Minimum delay in ms for custom humanDelay (default: 800).",
  "agents.defaults.humanDelay.maxMs": "Maximum delay in ms for custom humanDelay (default: 2500).",
  "commands.native":
    "Register native commands with channels that support it (Discord/Slack/Telegram).",
  "commands.nativeSkills":
    "Register native skill commands (user-invocable skills) with channels that support it.",
  "commands.text": "Allow text command parsing (slash commands only).",
  "commands.bash":
    "Allow bash chat command (`!`; `/bash` alias) to run host shell commands (default: false; requires tools.elevated).",
  "commands.bashForegroundMs":
    "How long bash waits before backgrounding (default: 2000; 0 backgrounds immediately).",
  "commands.config": "Allow /config chat command to read/write config on disk (default: false).",
  "commands.debug": "Allow /debug chat command for runtime-only overrides (default: false).",
  "commands.restart": "Allow /restart and gateway restart tool actions (default: false).",
  "commands.useAccessGroups": "Enforce access-group allowlists/policies for commands.",
  "commands.ownerAllowFrom":
    "Explicit owner allowlist for owner-only tools/commands. Use channel-native IDs (optionally prefixed like \"whatsapp:+15551234567\"). '*' is ignored.",
  "session.dmScope":
    'DM session scoping: "main" keeps continuity; "per-peer", "per-channel-peer", or "per-account-channel-peer" isolates DM history (recommended for shared inboxes/multi-account).',
  "session.identityLinks":
    "Map canonical identities to provider-prefixed peer IDs for DM session linking (example: telegram:123456).",
  "channels.telegram.configWrites":
    "Allow Telegram to write config in response to channel events/commands (default: true).",
  "channels.slack.configWrites":
    "Allow Slack to write config in response to channel events/commands (default: true).",
  "channels.mattermost.configWrites":
    "Allow Mattermost to write config in response to channel events/commands (default: true).",
  "channels.discord.configWrites":
    "Allow Discord to write config in response to channel events/commands (default: true).",
  "channels.whatsapp.configWrites":
    "Allow WhatsApp to write config in response to channel events/commands (default: true).",
  "channels.signal.configWrites":
    "Allow Signal to write config in response to channel events/commands (default: true).",
  "channels.imessage.configWrites":
    "Allow iMessage to write config in response to channel events/commands (default: true).",
  "channels.msteams.configWrites":
    "Allow Microsoft Teams to write config in response to channel events/commands (default: true).",
  "channels.discord.commands.native": 'Override native commands for Discord (bool or "auto").',
  "channels.discord.commands.nativeSkills":
    'Override native skill commands for Discord (bool or "auto").',
  "channels.telegram.commands.native": 'Override native commands for Telegram (bool or "auto").',
  "channels.telegram.commands.nativeSkills":
    'Override native skill commands for Telegram (bool or "auto").',
  "channels.slack.commands.native": 'Override native commands for Slack (bool or "auto").',
  "channels.slack.commands.nativeSkills":
    'Override native skill commands for Slack (bool or "auto").',
  "session.agentToAgent.maxPingPongTurns":
    "Max reply-back turns between requester and target (0–5).",
  "channels.telegram.customCommands":
    "Additional Telegram bot menu commands (merged with native; conflicts ignored).",
  "messages.ackReaction": "Emoji reaction used to acknowledge inbound messages (empty disables).",
  "messages.ackReactionScope":
    'When to send ack reactions ("group-mentions", "group-all", "direct", "all").',
  "messages.inbound.debounceMs":
    "Debounce window (ms) for batching rapid inbound messages from the same sender (0 to disable).",
  "channels.telegram.dmPolicy":
    'Direct message access control ("pairing" recommended). "open" requires channels.telegram.allowFrom=["*"].',
  "channels.telegram.streamMode":
    "Draft streaming mode for Telegram replies (off | partial | block). Separate from block streaming; requires private topics + sendMessageDraft.",
  "channels.telegram.draftChunk.minChars":
    'Minimum chars before emitting a Telegram draft update when channels.telegram.streamMode="block" (default: 200).',
  "channels.telegram.draftChunk.maxChars":
    'Target max size for a Telegram draft update chunk when channels.telegram.streamMode="block" (default: 800; clamped to channels.telegram.textChunkLimit).',
  "channels.telegram.draftChunk.breakPreference":
    "Preferred breakpoints for Telegram draft chunks (paragraph | newline | sentence). Default: paragraph.",
  "channels.telegram.retry.attempts":
    "Max retry attempts for outbound Telegram API calls (default: 3).",
  "channels.telegram.retry.minDelayMs": "Minimum retry delay in ms for Telegram outbound calls.",
  "channels.telegram.retry.maxDelayMs":
    "Maximum retry delay cap in ms for Telegram outbound calls.",
  "channels.telegram.retry.jitter": "Jitter factor (0-1) applied to Telegram retry delays.",
  "channels.telegram.network.autoSelectFamily":
    "Override Node autoSelectFamily for Telegram (true=enable, false=disable).",
  "channels.telegram.timeoutSeconds":
    "Max seconds before Telegram API requests are aborted (default: 500 per grammY).",
  "channels.whatsapp.dmPolicy":
    'Direct message access control ("pairing" recommended). "open" requires channels.whatsapp.allowFrom=["*"].',
  "channels.whatsapp.selfChatMode": "Same-phone setup (bot uses your personal WhatsApp number).",
  "channels.whatsapp.debounceMs":
    "Debounce window (ms) for batching rapid consecutive messages from the same sender (0 to disable).",
  "channels.signal.dmPolicy":
    'Direct message access control ("pairing" recommended). "open" requires channels.signal.allowFrom=["*"].',
  "channels.imessage.dmPolicy":
    'Direct message access control ("pairing" recommended). "open" requires channels.imessage.allowFrom=["*"].',
  "channels.bluebubbles.dmPolicy":
    'Direct message access control ("pairing" recommended). "open" requires channels.bluebubbles.allowFrom=["*"].',
  "channels.discord.dm.policy":
    'Direct message access control ("pairing" recommended). "open" requires channels.discord.dm.allowFrom=["*"].',
  "channels.discord.retry.attempts":
    "Max retry attempts for outbound Discord API calls (default: 3).",
  "channels.discord.retry.minDelayMs": "Minimum retry delay in ms for Discord outbound calls.",
  "channels.discord.retry.maxDelayMs": "Maximum retry delay cap in ms for Discord outbound calls.",
  "channels.discord.retry.jitter": "Jitter factor (0-1) applied to Discord retry delays.",
  "channels.discord.maxLinesPerMessage": "Soft max line count per Discord message (default: 17).",
  "channels.discord.intents.presence":
    "Enable the Guild Presences privileged intent. Must also be enabled in the Discord Developer Portal. Allows tracking user activities (e.g. Spotify). Default: false.",
  "channels.discord.intents.guildMembers":
    "Enable the Guild Members privileged intent. Must also be enabled in the Discord Developer Portal. Default: false.",
  "channels.discord.pluralkit.enabled":
    "Resolve PluralKit proxied messages and treat system members as distinct senders.",
  "channels.discord.pluralkit.token":
    "Optional PluralKit token for resolving private systems or members.",
  "channels.slack.dm.policy":
    'Direct message access control ("pairing" recommended). "open" requires channels.slack.dm.allowFrom=["*"].',
};

const FIELD_HELP_ZH: Record<string, string> = {
  "meta.lastTouchedVersion": "当 OpenClaw 写入配置时自动设置。",
  "meta.lastTouchedAt": "上次写入配置的 ISO 时间戳（自动设置）。",
  "update.channel": 'git + npm 安装的更新通道（"stable"、"beta" 或 "dev"）。',
  "update.checkOnStart": "网关启动时检查 npm 更新（默认：true）。",
  "gateway.remote.url": "远程网关 WebSocket URL（ws:// 或 wss://）。",
  "gateway.remote.tlsFingerprint": "远程网关的预期 sha256 TLS 指纹（用于防 MITM）。",
  "gateway.remote.sshTarget":
    "通过 SSH 连接远程网关（将网关端口隧道到本机）。格式：user@host 或 user@host:port。",
  "gateway.remote.sshIdentity": "可选 SSH 身份文件路径（传给 ssh -i）。",
  "agents.list.*.skills": "该 Agent 的可选技能允许列表（省略=所有技能；空=无技能）。",
  "agents.list[].skills": "该 Agent 的可选技能允许列表（省略=所有技能；空=无技能）。",
  "agents.list[].identity.avatar": "头像图片路径（仅相对 Agent 工作区）或远程 URL/data URL。",
  "discovery.mdns.mode":
    'mDNS 广播模式（默认 "minimal"；"full" 包含 cliPath/sshPort；"off" 关闭 mDNS）。',
  "gateway.auth.token":
    "默认需要 Token 访问网关（除非使用 Tailscale Serve 身份）；非 loopback 绑定必须设置。",
  "gateway.auth.password": "Tailscale funnel 需要密码。",
  "gateway.controlUi.basePath": "控制台服务的可选 URL 前缀（例如 /openclaw）。",
  "gateway.controlUi.root": "控制台资源的可选文件系统根目录（默认 dist/control-ui）。",
  "gateway.controlUi.allowInsecureAuth": "允许在不安全 HTTP 上进行控制台认证（仅 token；不推荐）。",
  "gateway.controlUi.dangerouslyDisableDeviceAuth":
    "危险：禁用控制台设备身份校验（仅 token/password）。",
  "gateway.http.endpoints.chatCompletions.enabled":
    "启用兼容 OpenAI 的 `POST /v1/chat/completions` 端点（默认：false）。",
  "gateway.reload.mode": '配置变更的热重载策略（推荐 "hybrid"）。',
  "gateway.reload.debounceMs": "应用配置变更前的防抖窗口（ms）。",
  "gateway.nodes.browser.mode":
    '节点浏览器路由（"auto"=选择唯一已连接浏览器节点；"manual"=要求节点参数；"off"=禁用）。',
  "gateway.nodes.browser.node": "将浏览器路由固定到某个节点 id 或名称（可选）。",
  "gateway.nodes.allowCommands": "允许超出默认的 node.invoke 命令（命令字符串数组）。",
  "gateway.nodes.denyCommands": "即使存在于节点声明或默认允许列表中也要阻止的命令。",
  "nodeHost.browserProxy.enabled": "通过节点代理暴露本地浏览器控制服务。",
  "nodeHost.browserProxy.allowProfiles": "可选：允许通过节点代理暴露的浏览器配置档。",
  "diagnostics.flags":
    '按标记启用定向诊断日志（例如 ["telegram.http"]）。支持通配符，如 "telegram.*" 或 "*".',
  "diagnostics.cacheTrace.enabled": "记录嵌入式 Agent 运行的缓存追踪快照（默认：false）。",
  "diagnostics.cacheTrace.filePath":
    "缓存追踪日志 JSONL 输出路径（默认：$OPENCLAW_STATE_DIR/logs/cache-trace.jsonl）。",
  "diagnostics.cacheTrace.includeMessages": "在追踪输出中包含完整消息负载（默认：true）。",
  "diagnostics.cacheTrace.includePrompt": "在追踪输出中包含 prompt 文本（默认：true）。",
  "diagnostics.cacheTrace.includeSystem": "在追踪输出中包含 system prompt（默认：true）。",
  "tools.exec.applyPatch.enabled": "实验性。允许在符合工具策略时为 OpenAI 模型启用 apply_patch。",
  "tools.exec.applyPatch.allowModels": '可选模型允许列表（例如 "gpt-5.2" 或 "openai/gpt-5.2"）。',
  "tools.exec.notifyOnExit": "为 true（默认）时，后台 exec 会在退出时排队系统事件并请求心跳。",
  "tools.exec.pathPrepend": "在 exec 运行时前置到 PATH 的目录（gateway/sandbox）。",
  "tools.exec.safeBins": "允许仅 stdin 的安全二进制无需显式允许列表即可运行。",
  "tools.message.allowCrossContextSend": "遗留开关：允许跨所有提供方的跨上下文发送。",
  "tools.message.crossContext.allowWithinProvider": "允许在同一提供方内跨渠道发送（默认：true）。",
  "tools.message.crossContext.allowAcrossProviders": "允许跨不同提供方发送（默认：false）。",
  "tools.message.crossContext.marker.enabled": "跨上下文发送时添加可见来源标记（默认：true）。",
  "tools.message.crossContext.marker.prefix": '跨上下文标记前缀文本（支持 "{channel}"）。',
  "tools.message.crossContext.marker.suffix": '跨上下文标记后缀文本（支持 "{channel}"）。',
  "tools.message.broadcast.enabled": "启用广播动作（默认：true）。",
  "tools.web.search.enabled": "启用 web_search 工具（需要提供方 API key）。",
  "tools.web.search.provider": '搜索提供方（"brave" 或 "perplexity"）。',
  "tools.web.search.apiKey": "Brave Search API key（回退：BRAVE_API_KEY 环境变量）。",
  "tools.web.search.maxResults": "默认返回结果数（1-10）。",
  "tools.web.search.timeoutSeconds": "web_search 请求超时（秒）。",
  "tools.web.search.cacheTtlMinutes": "web_search 结果缓存 TTL（分钟）。",
  "tools.web.search.perplexity.apiKey":
    "Perplexity 或 OpenRouter API key（回退：PERPLEXITY_API_KEY 或 OPENROUTER_API_KEY）。",
  "tools.web.search.perplexity.baseUrl":
    "Perplexity 基础 URL 覆盖（默认：https://openrouter.ai/api/v1 或 https://api.perplexity.ai）。",
  "tools.web.search.perplexity.model": 'Perplexity 模型覆盖（默认："perplexity/sonar-pro"）。',
  "tools.web.fetch.enabled": "启用 web_fetch 工具（轻量 HTTP 抓取）。",
  "tools.web.fetch.maxChars": "web_fetch 返回的最大字符数（会截断）。",
  "tools.web.fetch.timeoutSeconds": "web_fetch 请求超时（秒）。",
  "tools.web.fetch.cacheTtlMinutes": "web_fetch 结果缓存 TTL（分钟）。",
  "tools.web.fetch.maxRedirects": "web_fetch 允许的最大重定向（默认：3）。",
  "tools.web.fetch.userAgent": "覆盖 web_fetch 请求的 User-Agent 头。",
  "tools.web.fetch.readability": "使用 Readability 提取正文（无法时退回简单清理）。",
  "tools.web.fetch.firecrawl.enabled": "启用 Firecrawl 作为 web_fetch 回退（需配置）。",
  "tools.web.fetch.firecrawl.apiKey": "Firecrawl API key（回退：FIRECRAWL_API_KEY 环境变量）。",
  "tools.web.fetch.firecrawl.baseUrl": "Firecrawl base URL（例如 https://api.firecrawl.dev）。",
  "tools.web.fetch.firecrawl.onlyMainContent": "为 true 时，Firecrawl 仅返回主内容（默认：true）。",
  "tools.web.fetch.firecrawl.maxAgeMs": "Firecrawl 缓存结果的 maxAge（ms）。",
  "tools.web.fetch.firecrawl.timeoutSeconds": "Firecrawl 请求超时（秒）。",
  "channels.slack.allowBots": "允许由 Bot 发送的消息触发 Slack 回复（默认：false）。",
  "channels.slack.thread.historyScope":
    'Slack 线程历史范围（"thread" 按线程隔离；"channel" 复用频道历史）。',
  "channels.slack.thread.inheritParent": "为 true 时，Slack 线程会继承父频道会话（默认：false）。",
  "channels.mattermost.botToken":
    "Mattermost 控制台 -> Integrations -> Bot Accounts 的 Bot Token。",
  "channels.mattermost.baseUrl": "Mattermost 服务器基础 URL（例如 https://chat.example.com）。",
  "channels.mattermost.chatmode":
    '回复频道消息的模式：提及时 ("oncall")、触发字符 (">" 或 "!") 时 ("onchar")、或所有消息 ("onmessage")。',
  "channels.mattermost.oncharPrefixes": 'onchar 模式的触发前缀（默认：["\u003e","!"]）。',
  "channels.mattermost.requireMention": "频道内回复前要求 @mention（默认：true）。",
  "auth.profiles": "命名的认证配置档（提供方 + 模式 + 可选邮箱）。",
  "auth.order": "每个提供方的配置档顺序（用于自动故障切换）。",
  "auth.cooldowns.billingBackoffHours": "计费/余额不足时的基础退避（小时，默认：5）。",
  "auth.cooldowns.billingBackoffHoursByProvider": "按提供方覆盖计费退避（小时）。",
  "auth.cooldowns.billingMaxHours": "计费退避上限（小时，默认：24）。",
  "auth.cooldowns.failureWindowHours": "退避计数的故障窗口（小时，默认：24）。",
  "agents.defaults.bootstrapMaxChars":
    "每个工作区 bootstrap 文件注入系统提示前的最大字符数（默认：20000）。",
  "agents.defaults.repoRoot": "系统提示运行时行中显示的仓库根目录（覆盖自动检测）。",
  "agents.defaults.envelopeTimezone": '消息封装时区（"utc"、"local"、"user" 或 IANA 时区字符串）。',
  "agents.defaults.envelopeTimestamp": '消息封装中包含绝对时间戳（"on"/"off"）。',
  "agents.defaults.envelopeElapsed": '消息封装中包含耗时（"on"/"off"）。',
  "agents.defaults.models": "已配置的模型目录（键为 provider/model）。",
  "agents.defaults.memorySearch": "对 MEMORY.md 和 memory/*.md 的向量检索（支持按 Agent 覆盖）。",
  "agents.defaults.memorySearch.sources":
    '记忆检索来源（默认：["memory"]；加 "sessions" 包含会话记录）。',
  "agents.defaults.memorySearch.extraPaths":
    "额外记忆路径（目录或 .md 文件；相对路径以工作区为基准）。",
  "agents.defaults.memorySearch.experimental.sessionMemory":
    "启用会话记录索引（实验，默认：false）。",
  "agents.defaults.memorySearch.provider": '嵌入提供方（"openai"、"gemini" 或 "local"）。',
  "agents.defaults.memorySearch.remote.baseUrl":
    "远程嵌入的自定义 Base URL（OpenAI 兼容代理或 Gemini 覆盖）。",
  "agents.defaults.memorySearch.remote.apiKey": "远程嵌入提供方的自定义 API key。",
  "agents.defaults.memorySearch.remote.headers": "远程嵌入的额外请求头（合并；覆盖 OpenAI）。",
  "agents.defaults.memorySearch.remote.batch.enabled":
    "启用批量嵌入（OpenAI/Gemini；默认：true）。",
  "agents.defaults.memorySearch.remote.batch.wait": "索引时等待批处理完成（默认：true）。",
  "agents.defaults.memorySearch.remote.batch.concurrency": "嵌入批处理最大并发（默认：2）。",
  "agents.defaults.memorySearch.remote.batch.pollIntervalMs":
    "批处理状态轮询间隔（ms，默认：2000）。",
  "agents.defaults.memorySearch.remote.batch.timeoutMinutes": "批处理索引超时（分钟，默认：60）。",
  "agents.defaults.memorySearch.local.modelPath":
    "本地 GGUF 模型路径或 hf: URI（node-llama-cpp）。",
  "agents.defaults.memorySearch.fallback":
    '嵌入失败时的回退提供方（"openai"、"gemini"、"local" 或 "none"）。',
  "agents.defaults.memorySearch.store.path":
    "SQLite 索引路径（默认：~/.openclaw/memory/{agentId}.sqlite）。",
  "agents.defaults.memorySearch.store.vector.enabled":
    "启用 sqlite-vec 向量检索扩展（默认：true）。",
  "agents.defaults.memorySearch.store.vector.extensionPath":
    "sqlite-vec 扩展库路径（.dylib/.so/.dll）。",
  "agents.defaults.memorySearch.query.hybrid.enabled": "启用 BM25 + 向量的混合检索（默认：true）。",
  "agents.defaults.memorySearch.query.hybrid.vectorWeight": "合并结果时的向量权重（0-1）。",
  "agents.defaults.memorySearch.query.hybrid.textWeight": "合并结果时的文本权重（0-1）。",
  "agents.defaults.memorySearch.query.hybrid.candidateMultiplier": "候选池倍率（默认：4）。",
  "agents.defaults.memorySearch.cache.enabled":
    "将分块嵌入缓存到 SQLite 以加速重建和频繁更新（默认：true）。",
  memory: "记忆后端配置（全局）。",
  "memory.backend": '记忆后端（"builtin" 为 OpenClaw；"qmd" 为 QMD 侧车）。',
  "memory.citations": '默认引用行为（"auto"、"on" 或 "off"）。',
  "memory.qmd.command": "qmd 二进制路径（默认从 PATH 解析）。",
  "memory.qmd.includeDefaultMemory": "是否自动索引 MEMORY.md + memory/**/*.md（默认：true）。",
  "memory.qmd.paths": "QMD 额外索引目录/文件（路径 + 可选通配）。",
  "memory.qmd.paths.path": "QMD 索引路径（绝对或 ~ 相对）。",
  "memory.qmd.paths.pattern": "相对路径根的通配模式（默认：**/*.md）。",
  "memory.qmd.paths.name": "QMD 集合稳定名称（默认由路径推导）。",
  "memory.qmd.sessions.enabled": "启用 QMD 会话记录索引（实验，默认：false）。",
  "memory.qmd.sessions.exportDir": "会话导出目录覆盖（索引前的净化副本）。",
  "memory.qmd.sessions.retentionDays": "导出会话保留窗口（天，默认：无限）。",
  "memory.qmd.update.interval": "QMD 刷新索引的频率（时长字符串，默认：5m）。",
  "memory.qmd.update.debounceMs": "QMD 连续刷新之间的最小延迟（默认：15000）。",
  "memory.qmd.update.onBoot": "网关启动时运行一次 QMD 更新（默认：true）。",
  "memory.qmd.update.embedInterval":
    "QMD 嵌入刷新频率（时长字符串，默认：60m）。设为 0 关闭周期嵌入。",
  "memory.qmd.limits.maxResults": "QMD 返回给 Agent 的最大结果数（默认：6）。",
  "memory.qmd.limits.maxSnippetChars": "QMD 单个片段最大字符（默认：700）。",
  "memory.qmd.limits.maxInjectedChars": "每轮从 QMD 命中注入的最大字符总数。",
  "memory.qmd.limits.timeoutMs": "QMD 搜索单次超时（默认：4000）。",
  "memory.qmd.scope": "QMD 召回范围（同 session.sendPolicy 语法；默认：direct-only）。",
  "agents.defaults.memorySearch.cache.maxEntries": "嵌入缓存条目上限（尽力保证）。",
  "agents.defaults.memorySearch.sync.onSearch": "惰性同步：搜索后触发重建索引。",
  "agents.defaults.memorySearch.sync.watch": "监视记忆文件变化（chokidar）。",
  "agents.defaults.memorySearch.sync.sessions.deltaBytes":
    "触发会话重建所需最小字节增量（默认：100000）。",
  "agents.defaults.memorySearch.sync.sessions.deltaMessages":
    "触发会话重建所需最小 JSONL 行数（默认：50）。",
  "plugins.enabled": "启用插件/扩展加载（默认：true）。",
  "plugins.allow": "可选插件允许列表；设置后仅加载列出的插件。",
  "plugins.deny": "可选插件拒绝列表；拒绝优先生效。",
  "plugins.load.paths": "额外插件文件或目录。",
  "plugins.slots": "选择独占槽位的插件（memory 等）。",
  "plugins.slots.memory": '选择激活的记忆插件 ID，或 "none" 禁用记忆插件。',
  "plugins.entries": "按插件 ID 的配置（启用/禁用 + 配置负载）。",
  "plugins.entries.*.enabled": "覆盖该插件条目的启用/禁用（需重启）。",
  "plugins.entries.*.config": "插件自定义配置负载（schema 由插件提供）。",
  "plugins.installs": "CLI 管理的安装元数据（用于 `openclaw plugins update` 定位来源）。",
  "plugins.installs.*.source": '安装来源（"npm"、"archive" 或 "path"）。',
  "plugins.installs.*.spec": "安装时使用的 npm spec（如 source 为 npm）。",
  "plugins.installs.*.sourcePath": "安装时的原始 archive/path（如有）。",
  "plugins.installs.*.installPath": "解析后的安装目录（通常 ~/.openclaw/extensions/<id>）。",
  "plugins.installs.*.version": "安装时记录的版本（如可用）。",
  "plugins.installs.*.installedAt": "上次安装/更新的 ISO 时间戳。",
  "agents.list.*.identity.avatar": "Agent 头像（工作区相对路径、http(s) URL 或 data URI）。",
  "agents.defaults.model.primary": "主模型（provider/model）。",
  "agents.defaults.model.fallbacks": "按顺序的回退模型（provider/model）。主模型失败时使用。",
  "agents.defaults.imageModel.primary":
    "可选图像模型（provider/model），当主模型不支持图像时使用。",
  "agents.defaults.imageModel.fallbacks": "按顺序的图像模型回退（provider/model）。",
  "agents.defaults.cliBackends": "可选 CLI 后端，用于纯文本回退（claude-cli 等）。",
  "agents.defaults.humanDelay.mode": '阻塞回复的人类延迟风格（"off"、"natural"、"custom"）。',
  "agents.defaults.humanDelay.minMs": "自定义人类延迟最小值（ms，默认：800）。",
  "agents.defaults.humanDelay.maxMs": "自定义人类延迟最大值（ms，默认：2500）。",
  "commands.native": "在支持的渠道中注册原生命令（Discord/Slack/Telegram）。",
  "commands.nativeSkills": "在支持的渠道中注册原生技能命令（可由用户调用）。",
  "commands.text": "允许文本命令解析（仅斜杠命令）。",
  "commands.bash":
    "允许 Bash 聊天命令（`!`；`/bash` 别名）执行主机命令（默认：false；需要 tools.elevated）。",
  "commands.bashForegroundMs": "Bash 转入后台前的等待时间（默认：2000；0 表示立即后台）。",
  "commands.config": "允许 /config 聊天命令读写磁盘配置（默认：false）。",
  "commands.debug": "允许 /debug 聊天命令进行运行时覆盖（默认：false）。",
  "commands.restart": "允许 /restart 与网关重启工具动作（默认：false）。",
  "commands.useAccessGroups": "对命令执行访问组允许列表/策略。",
  "session.dmScope":
    '私聊会话范围："main" 保持连续；"per-peer"、"per-channel-peer" 或 "per-account-channel-peer" 进行隔离（共享收件箱/多账号建议）。',
  "session.identityLinks": "将规范身份映射到带提供方前缀的 peer ID（例：telegram:123456）。",
  "channels.telegram.configWrites": "允许 Telegram 响应事件/命令写配置（默认：true）。",
  "channels.slack.configWrites": "允许 Slack 响应事件/命令写配置（默认：true）。",
  "channels.mattermost.configWrites": "允许 Mattermost 响应事件/命令写配置（默认：true）。",
  "channels.discord.configWrites": "允许 Discord 响应事件/命令写配置（默认：true）。",
  "channels.whatsapp.configWrites": "允许 WhatsApp 响应事件/命令写配置（默认：true）。",
  "channels.signal.configWrites": "允许 Signal 响应事件/命令写配置（默认：true）。",
  "channels.imessage.configWrites": "允许 iMessage 响应事件/命令写配置（默认：true）。",
  "channels.msteams.configWrites": "允许 Microsoft Teams 响应事件/命令写配置（默认：true）。",
  "channels.discord.commands.native": '覆盖 Discord 原生命令（bool 或 "auto"）。',
  "channels.discord.commands.nativeSkills": '覆盖 Discord 原生技能命令（bool 或 "auto"）。',
  "channels.telegram.commands.native": '覆盖 Telegram 原生命令（bool 或 "auto"）。',
  "channels.telegram.commands.nativeSkills": '覆盖 Telegram 原生技能命令（bool 或 "auto"）。',
  "channels.slack.commands.native": '覆盖 Slack 原生命令（bool 或 "auto"）。',
  "channels.slack.commands.nativeSkills": '覆盖 Slack 原生技能命令（bool 或 "auto"）。',
  "session.agentToAgent.maxPingPongTurns": "Agent 间最大往返回复轮次（0–5）。",
  "channels.telegram.customCommands": "额外 Telegram 机器人菜单命令（与原生合并；冲突忽略）。",
  "messages.ackReaction": "用于确认入站消息的表情（为空则禁用）。",
  "messages.ackReactionScope":
    '发送确认表情的范围（"group-mentions"、"group-all"、"direct"、"all"）。',
  "messages.inbound.debounceMs": "同一发送者快速连续入站消息的防抖窗口（ms；0 禁用）。",
  "channels.telegram.dmPolicy":
    '私聊访问控制（推荐 "pairing"）。"open" 需 channels.telegram.allowFrom=["*"]。',
  "channels.telegram.streamMode":
    "Telegram 回复草稿流模式（off | partial | block）。与块级流式不同；需私密话题 + sendMessageDraft。",
  "channels.telegram.draftChunk.minChars":
    'channels.telegram.streamMode="block" 时，草稿更新最小字符数（默认：200）。',
  "channels.telegram.draftChunk.maxChars":
    'channels.telegram.streamMode="block" 时，草稿分片目标最大字符数（默认：800；受 textChunkLimit 约束）。',
  "channels.telegram.draftChunk.breakPreference":
    "Telegram 草稿分片断点偏好（paragraph | newline | sentence）。默认：paragraph。",
  "channels.telegram.retry.attempts": "Telegram 出站 API 调用的最大重试次数（默认：3）。",
  "channels.telegram.retry.minDelayMs": "Telegram 出站调用最小重试延迟（ms）。",
  "channels.telegram.retry.maxDelayMs": "Telegram 出站调用最大重试延迟（ms）。",
  "channels.telegram.retry.jitter": "Telegram 重试抖动系数（0-1）。",
  "channels.telegram.network.autoSelectFamily":
    "覆盖 Telegram 的 Node autoSelectFamily（true=启用，false=禁用）。",
  "channels.telegram.timeoutSeconds": "Telegram API 请求超时（秒，grammY 默认 500）。",
  "channels.whatsapp.dmPolicy":
    '私聊访问控制（推荐 "pairing"）。"open" 需 channels.whatsapp.allowFrom=["*"]。',
  "channels.whatsapp.selfChatMode": "同号自聊模式（机器人使用你的个人 WhatsApp 号码）。",
  "channels.whatsapp.debounceMs": "同一发送者快速连续消息的防抖窗口（ms；0 禁用）。",
  "channels.signal.dmPolicy":
    '私聊访问控制（推荐 "pairing"）。"open" 需 channels.signal.allowFrom=["*"]。',
  "channels.imessage.dmPolicy":
    '私聊访问控制（推荐 "pairing"）。"open" 需 channels.imessage.allowFrom=["*"]。',
  "channels.bluebubbles.dmPolicy":
    '私聊访问控制（推荐 "pairing"）。"open" 需 channels.bluebubbles.allowFrom=["*"]。',
  "channels.discord.dm.policy":
    '私聊访问控制（推荐 "pairing"）。"open" 需 channels.discord.dm.allowFrom=["*"]。',
  "channels.discord.retry.attempts": "Discord 出站 API 调用最大重试次数（默认：3）。",
  "channels.discord.retry.minDelayMs": "Discord 出站调用最小重试延迟（ms）。",
  "channels.discord.retry.maxDelayMs": "Discord 出站调用最大重试延迟（ms）。",
  "channels.discord.retry.jitter": "Discord 重试抖动系数（0-1）。",
  "channels.*": "渠道级通用配置（应用于该渠道的所有账号或实例）。",
  "channels.*.enabled": "是否启用该渠道。",
  "channels.*.name": "账号或连接的显示名称。",
  "channels.*.accounts": "多账号配置（按账号 ID 分组）。",
  "channels.*.accounts.*": "单个账号的配置项。",
  "channels.*.accounts.*.name": "账号显示名称。",
  "channels.*.accounts.*.enabled": "是否启用该账号。",
  "channels.*.accounts.*.configWrites": "是否允许该账号通过事件/命令写配置。",
  "channels.*.capabilities": "渠道能力开关集合。",
  "channels.*.capabilities.*": "单项能力开关。",
  "channels.*.accounts.*.capabilities": "账号能力开关集合。",
  "channels.*.accounts.*.capabilities.*": "单项能力开关。",
  "channels.*.groupPolicy": "群聊默认策略（allowlist/denylist 等）。",
  "channels.*.historyLimit": "该渠道历史消息保留上限（条数）。",
  "channels.*.dmHistoryLimit": "私聊历史消息保留上限（条数）。",
  "channels.*.dms": "私聊粒度的覆盖配置。",
  "channels.*.dms.*": "单个私聊会话配置。",
  "channels.*.dms.*.historyLimit": "私聊会话历史上限（条数）。",
  "channels.*.textChunkLimit": "单条消息最大字符数上限（超过会分片）。",
  "channels.*.chunkMode": "分片模式（按长度或按换行）。",
  "channels.*.blockStreaming": "是否启用阻塞流模式（以块为单位更新）。",
  "channels.*.blockStreamingCoalesce": "阻塞流合并策略。",
  "channels.*.blockStreamingCoalesce.minChars": "合并最小字符数。",
  "channels.*.blockStreamingCoalesce.maxChars": "合并最大字符数。",
  "channels.*.blockStreamingCoalesce.idleMs": "合并空闲时间（ms）。",
  "channels.*.mediaMaxMb": "媒体文件大小上限（MB）。",
  "channels.*.markdown": "Markdown 输出控制。",
  "channels.*.markdown.tables": "是否允许输出 Markdown 表格。",
  "channels.*.allowFrom": "允许的发送者列表。",
  "channels.*.allowFrom.*": "允许发送者条目。",
  "channels.*.groupAllowFrom": "允许的群聊列表。",
  "channels.*.groupAllowFrom.*": "允许群聊条目。",
  "channels.*.groups": "群组粒度的覆盖配置。",
  "channels.*.groups.*": "单个群组配置。",
  "channels.*.groups.*.requireMention": "是否要求提及机器人。",
  "channels.*.groups.*.tools": "群组工具策略。",
  "channels.*.groups.*.tools.allow": "允许的工具列表。",
  "channels.*.groups.*.tools.allow.*": "允许工具条目。",
  "channels.*.groups.*.tools.alsoAllow": "额外允许的工具列表。",
  "channels.*.groups.*.tools.alsoAllow.*": "额外允许工具条目。",
  "channels.*.groups.*.tools.deny": "拒绝的工具列表。",
  "channels.*.groups.*.tools.deny.*": "拒绝工具条目。",
  "channels.*.groups.*.toolsBySender": "按发送者的工具策略。",
  "channels.*.groups.*.toolsBySender.*.allow": "允许的工具列表。",
  "channels.*.groups.*.toolsBySender.*.allow.*": "允许工具条目。",
  "channels.*.groups.*.toolsBySender.*.alsoAllow": "额外允许的工具列表。",
  "channels.*.groups.*.toolsBySender.*.alsoAllow.*": "额外允许工具条目。",
  "channels.*.groups.*.toolsBySender.*.deny": "拒绝的工具列表。",
  "channels.*.groups.*.toolsBySender.*.deny.*": "拒绝工具条目。",
  "channels.*.actions": "渠道动作能力控制。",
  "channels.*.actions.reactions": "是否允许表情反应。",
  "channels.*.actions.sendMessage": "是否允许发送消息。",
  "channels.*.actions.deleteMessage": "是否允许删除消息。",
  "channels.*.actions.sticker": "是否允许发送贴纸。",
  "channels.*.heartbeat": "心跳消息显示设置。",
  "channels.*.heartbeat.showOk": "是否显示正常心跳。",
  "channels.*.heartbeat.showAlerts": "是否显示告警心跳。",
  "channels.*.heartbeat.useIndicator": "是否使用状态指示器。",
  "channels.*.accounts.*.groupPolicy": "群聊默认策略（allowlist/denylist 等）。",
  "channels.*.accounts.*.historyLimit": "该账号历史消息保留上限（条数）。",
  "channels.*.accounts.*.dmHistoryLimit": "该账号私聊历史上限（条数）。",
  "channels.*.accounts.*.dms": "该账号私聊覆盖配置。",
  "channels.*.accounts.*.dms.*": "该账号单个私聊配置。",
  "channels.*.accounts.*.dms.*.historyLimit": "该账号私聊会话历史上限（条数）。",
  "channels.*.accounts.*.textChunkLimit": "该账号单条消息最大字符数上限。",
  "channels.*.accounts.*.chunkMode": "该账号分片模式。",
  "channels.*.accounts.*.blockStreaming": "该账号阻塞流模式。",
  "channels.*.accounts.*.blockStreamingCoalesce": "该账号阻塞流合并策略。",
  "channels.*.accounts.*.blockStreamingCoalesce.minChars": "该账号合并最小字符数。",
  "channels.*.accounts.*.blockStreamingCoalesce.maxChars": "该账号合并最大字符数。",
  "channels.*.accounts.*.blockStreamingCoalesce.idleMs": "该账号合并空闲时间（ms）。",
  "channels.*.accounts.*.mediaMaxMb": "该账号媒体大小上限（MB）。",
  "channels.*.accounts.*.markdown": "该账号 Markdown 输出控制。",
  "channels.*.accounts.*.markdown.tables": "该账号是否允许 Markdown 表格。",
  "channels.*.accounts.*.allowFrom": "该账号允许的发送者列表。",
  "channels.*.accounts.*.allowFrom.*": "该账号允许发送者条目。",
  "channels.*.accounts.*.groupAllowFrom": "该账号允许的群聊列表。",
  "channels.*.accounts.*.groupAllowFrom.*": "该账号允许群聊条目。",
  "channels.*.accounts.*.groups": "该账号群组覆盖配置。",
  "channels.*.accounts.*.groups.*": "该账号单个群组配置。",
  "channels.*.accounts.*.groups.*.requireMention": "该账号群组是否要求提及。",
  "channels.*.accounts.*.groups.*.tools": "该账号群组工具策略。",
  "channels.*.accounts.*.groups.*.tools.allow": "该账号群组允许工具列表。",
  "channels.*.accounts.*.groups.*.tools.allow.*": "该账号群组允许工具条目。",
  "channels.*.accounts.*.groups.*.tools.alsoAllow": "该账号群组额外允许工具列表。",
  "channels.*.accounts.*.groups.*.tools.alsoAllow.*": "该账号群组额外允许工具条目。",
  "channels.*.accounts.*.groups.*.tools.deny": "该账号群组拒绝工具列表。",
  "channels.*.accounts.*.groups.*.tools.deny.*": "该账号群组拒绝工具条目。",
  "channels.*.accounts.*.groups.*.toolsBySender": "该账号群组按发送者的工具策略。",
  "channels.*.accounts.*.groups.*.toolsBySender.*.allow": "该账号群组允许工具列表。",
  "channels.*.accounts.*.groups.*.toolsBySender.*.allow.*": "该账号群组允许工具条目。",
  "channels.*.accounts.*.groups.*.toolsBySender.*.alsoAllow": "该账号群组额外允许工具列表。",
  "channels.*.accounts.*.groups.*.toolsBySender.*.alsoAllow.*": "该账号群组额外允许工具条目。",
  "channels.*.accounts.*.groups.*.toolsBySender.*.deny": "该账号群组拒绝工具列表。",
  "channels.*.accounts.*.groups.*.toolsBySender.*.deny.*": "该账号群组拒绝工具条目。",
  "channels.*.accounts.*.actions": "该账号动作能力控制。",
  "channels.*.accounts.*.actions.reactions": "该账号是否允许表情反应。",
  "channels.*.accounts.*.actions.sendMessage": "该账号是否允许发送消息。",
  "channels.*.accounts.*.actions.deleteMessage": "该账号是否允许删除消息。",
  "channels.*.accounts.*.actions.sticker": "该账号是否允许发送贴纸。",
  "channels.*.accounts.*.heartbeat": "该账号心跳消息显示设置。",
  "channels.*.accounts.*.heartbeat.showOk": "该账号是否显示正常心跳。",
  "channels.*.accounts.*.heartbeat.showAlerts": "该账号是否显示告警心跳。",
  "channels.*.accounts.*.heartbeat.useIndicator": "该账号是否使用状态指示器。",
  "channels.*.dmPolicy": "私聊访问控制策略。",
  "channels.*.replyToMode": "回复模式（跟随/引用/线程等，具体取决于渠道）。",
  "channels.*.webhookUrl": "Webhook 回调地址。",
  "channels.*.webhookPath": "Webhook 路径（相对路径）。",
  "channels.*.webhookSecret": "Webhook 共享密钥。",
  "channels.*.sendReadReceipts": "是否发送已读回执。",
  "channels.*.commands": "渠道命令相关设置。",
  "channels.*.commands.native": "是否启用原生命令。",
  "channels.*.commands.nativeSkills": "是否启用原生技能命令。",
  "channels.*.reactionNotifications": "反应通知范围。",
  "channels.*.reactionLevel": "反应反馈级别。",
  "channels.*.reactionAllowlist": "允许触发反应的用户列表。",
  "channels.*.reactionAllowlist.*": "允许触发反应的用户条目。",
  "channels.*.dm": "私聊配置。",
  "channels.*.dm.enabled": "是否启用私聊处理。",
  "channels.*.dm.policy": "私聊访问控制策略。",
  "channels.*.dm.allowFrom": "允许进入私聊的发送者列表。",
  "channels.*.dm.allowFrom.*": "允许进入私聊的发送者条目。",
  "channels.*.dm.groupEnabled": "是否允许把私聊转发到群。",
  "channels.*.dm.groupChannels": "私聊可转发的群频道列表。",
  "channels.*.dm.groupChannels.*": "私聊可转发群频道条目。",
  "channels.*.allowBots": "是否允许其他 Bot 触发消息。",
  "channels.*.requireMention": "是否要求提及机器人。",
  "channels.*.actions.polls": "是否允许投票相关操作。",
  "channels.*.actions.permissions": "是否允许权限查询。",
  "channels.*.actions.messages": "是否允许读取历史消息。",
  "channels.*.actions.pins": "是否允许置顶/取消置顶。",
  "channels.*.actions.search": "是否允许搜索消息。",
  "channels.*.actions.memberInfo": "是否允许读取成员信息。",
  "channels.*.actions.channelInfo": "是否允许读取频道/群信息。",
  "channels.*.retry": "出站请求重试策略。",
  "channels.*.retry.attempts": "最大重试次数。",
  "channels.*.retry.minDelayMs": "最小重试延迟（ms）。",
  "channels.*.retry.maxDelayMs": "最大重试延迟（ms）。",
  "channels.*.retry.jitter": "重试抖动系数（0-1）。",
  "channels.*.botToken": "机器人令牌。",
  "channels.*.tokenFile": "从文件读取令牌。",
  "channels.*.cliPath": "CLI 可执行文件路径。",
  "channels.*.messagePrefix": "消息前缀（用于识别机器人消息）。",
  "channels.*.authDir": "认证数据目录。",
  "channels.*.selfChatMode": "是否启用自聊模式。",
  "channels.*.ackReaction": "确认表情设置。",
  "channels.*.ackReaction.emoji": "确认用的表情内容。",
  "channels.*.ackReaction.direct": "私聊确认表情。",
  "channels.*.ackReaction.group": "群聊确认表情。",
  "channels.*.debounceMs": "消息防抖时间（ms）。",
  "channels.*.customCommands": "自定义命令列表。",
  "channels.*.customCommands.*": "自定义命令条目。",
  "channels.*.customCommands.*.command": "命令名称。",
  "channels.*.customCommands.*.description": "命令描述。",
  "channels.*.groups.*.skills": "群组可用技能列表。",
  "channels.*.groups.*.skills.*": "群组技能条目。",
  "channels.*.groups.*.allowFrom": "群组允许来源列表。",
  "channels.*.groups.*.allowFrom.*": "群组允许来源条目。",
  "channels.*.groups.*.topics": "话题配置（如 Telegram topics）。",
  "channels.*.groups.*.topics.*": "话题条目。",
  "channels.*.groups.*.topics.*.requireMention": "话题是否要求提及。",
  "channels.*.groups.*.topics.*.skills": "话题技能列表。",
  "channels.*.groups.*.topics.*.skills.*": "话题技能条目。",
  "channels.*.groups.*.topics.*.enabled": "话题是否启用。",
  "channels.*.groups.*.topics.*.allowFrom": "话题允许来源列表。",
  "channels.*.groups.*.topics.*.allowFrom.*": "话题允许来源条目。",
  "channels.*.groups.*.topics.*.systemPrompt": "话题系统提示。",
  "channels.*.draftChunk": "草稿分片设置。",
  "channels.*.network": "网络配置。",
  "channels.*.proxy": "代理地址。",
  "channels.*.linkPreview": "是否启用链接预览。",
  "channels.*.accounts.*.dmPolicy": "私聊访问控制策略。",
  "channels.*.accounts.*.replyToMode": "回复模式。",
  "channels.*.accounts.*.webhookUrl": "Webhook 回调地址。",
  "channels.*.accounts.*.webhookPath": "Webhook 路径。",
  "channels.*.accounts.*.webhookSecret": "Webhook 共享密钥。",
  "channels.*.accounts.*.sendReadReceipts": "是否发送已读回执。",
  "channels.*.accounts.*.commands": "渠道命令相关设置。",
  "channels.*.accounts.*.commands.native": "是否启用原生命令。",
  "channels.*.accounts.*.commands.nativeSkills": "是否启用原生技能命令。",
  "channels.*.accounts.*.reactionNotifications": "反应通知范围。",
  "channels.*.accounts.*.reactionLevel": "反应反馈级别。",
  "channels.*.accounts.*.reactionAllowlist": "允许触发反应的用户列表。",
  "channels.*.accounts.*.reactionAllowlist.*": "允许触发反应的用户条目。",
  "channels.*.accounts.*.dm": "私聊配置。",
  "channels.*.accounts.*.dm.enabled": "是否启用私聊处理。",
  "channels.*.accounts.*.dm.policy": "私聊访问控制策略。",
  "channels.*.accounts.*.dm.allowFrom": "允许进入私聊的发送者列表。",
  "channels.*.accounts.*.dm.allowFrom.*": "允许进入私聊的发送者条目。",
  "channels.*.accounts.*.dm.groupEnabled": "是否允许把私聊转发到群。",
  "channels.*.accounts.*.dm.groupChannels": "私聊可转发的群频道列表。",
  "channels.*.accounts.*.dm.groupChannels.*": "私聊可转发群频道条目。",
  "channels.*.accounts.*.allowBots": "是否允许其他 Bot 触发消息。",
  "channels.*.accounts.*.requireMention": "是否要求提及机器人。",
  "channels.*.accounts.*.actions.polls": "是否允许投票相关操作。",
  "channels.*.accounts.*.actions.permissions": "是否允许权限查询。",
  "channels.*.accounts.*.actions.messages": "是否允许读取历史消息。",
  "channels.*.accounts.*.actions.pins": "是否允许置顶/取消置顶。",
  "channels.*.accounts.*.actions.search": "是否允许搜索消息。",
  "channels.*.accounts.*.actions.memberInfo": "是否允许读取成员信息。",
  "channels.*.accounts.*.actions.channelInfo": "是否允许读取频道/群信息。",
  "channels.*.accounts.*.retry": "出站请求重试策略。",
  "channels.*.accounts.*.retry.attempts": "最大重试次数。",
  "channels.*.accounts.*.retry.minDelayMs": "最小重试延迟（ms）。",
  "channels.*.accounts.*.retry.maxDelayMs": "最大重试延迟（ms）。",
  "channels.*.accounts.*.retry.jitter": "重试抖动系数（0-1）。",
  "channels.*.accounts.*.botToken": "机器人令牌。",
  "channels.*.accounts.*.tokenFile": "从文件读取令牌。",
  "channels.*.accounts.*.cliPath": "CLI 可执行文件路径。",
  "channels.*.accounts.*.messagePrefix": "消息前缀。",
  "channels.*.accounts.*.authDir": "认证数据目录。",
  "channels.*.accounts.*.selfChatMode": "是否启用自聊模式。",
  "channels.*.accounts.*.ackReaction": "确认表情设置。",
  "channels.*.accounts.*.ackReaction.emoji": "确认用的表情内容。",
  "channels.*.accounts.*.ackReaction.direct": "私聊确认表情。",
  "channels.*.accounts.*.ackReaction.group": "群聊确认表情。",
  "channels.*.accounts.*.debounceMs": "消息防抖时间（ms）。",
  "channels.*.accounts.*.customCommands": "自定义命令列表。",
  "channels.*.accounts.*.customCommands.*": "自定义命令条目。",
  "channels.*.accounts.*.customCommands.*.command": "命令名称。",
  "channels.*.accounts.*.customCommands.*.description": "命令描述。",
  "channels.*.accounts.*.groups.*.skills": "群组可用技能列表。",
  "channels.*.accounts.*.groups.*.skills.*": "群组技能条目。",
  "channels.*.accounts.*.groups.*.allowFrom": "群组允许来源列表。",
  "channels.*.accounts.*.groups.*.allowFrom.*": "群组允许来源条目。",
  "channels.*.accounts.*.groups.*.topics": "话题配置（如 Telegram topics）。",
  "channels.*.accounts.*.groups.*.topics.*": "话题条目。",
  "channels.*.accounts.*.groups.*.topics.*.requireMention": "话题是否要求提及。",
  "channels.*.accounts.*.groups.*.topics.*.skills": "话题技能列表。",
  "channels.*.accounts.*.groups.*.topics.*.skills.*": "话题技能条目。",
  "channels.*.accounts.*.groups.*.topics.*.enabled": "话题是否启用。",
  "channels.*.accounts.*.groups.*.topics.*.allowFrom": "话题允许来源列表。",
  "channels.*.accounts.*.groups.*.topics.*.allowFrom.*": "话题允许来源条目。",
  "channels.*.accounts.*.groups.*.topics.*.systemPrompt": "话题系统提示。",
  "channels.*.accounts.*.draftChunk": "草稿分片设置。",
  "channels.*.accounts.*.network": "网络配置。",
  "channels.*.accounts.*.proxy": "代理地址。",
  "channels.*.accounts.*.linkPreview": "是否启用链接预览。",
  "channels.discord.maxLinesPerMessage": "Discord 单条消息建议最大行数（默认：17）。",
  "channels.discord.intents.presence":
    "启用 Guild Presences 特权 Intent。需在 Discord Developer Portal 中启用；用于跟踪用户活动（如 Spotify）。默认：false。",
  "channels.discord.intents.guildMembers":
    "启用 Guild Members 特权 Intent。需在 Discord Developer Portal 中启用。默认：false。",
  "channels.discord.pluralkit.enabled": "解析 PluralKit 代理消息并将系统成员视为独立发送者。",
  "channels.discord.pluralkit.token": "用于解析私有系统或成员的可选 PluralKit token。",
  "channels.slack.dm.policy":
    '私聊访问控制（推荐 "pairing"）。"open" 需 channels.slack.dm.allowFrom=["*"]。',
};

const FIELD_PLACEHOLDERS: Record<string, string> = {
  "gateway.remote.url": "ws://host:18789",
  "gateway.remote.tlsFingerprint": "sha256:ab12cd34…",
  "gateway.remote.sshTarget": "user@host",
  "gateway.controlUi.basePath": "/openclaw",
  "gateway.controlUi.root": "dist/control-ui",
  "gateway.controlUi.allowedOrigins": "https://control.example.com",
  "channels.mattermost.baseUrl": "https://chat.example.com",
  "agents.list[].identity.avatar": "avatars/openclaw.png",
};

const FIELD_PLACEHOLDERS_ZH: Record<string, string> = {
  "gateway.remote.url": "ws://host:18789",
  "gateway.remote.tlsFingerprint": "sha256:ab12cd34…",
  "gateway.remote.sshTarget": "user@host",
  "gateway.controlUi.basePath": "/openclaw",
  "gateway.controlUi.root": "dist/control-ui",
  "channels.mattermost.baseUrl": "https://chat.example.com",
  "agents.list[].identity.avatar": "avatars/openclaw.png",
};

const SENSITIVE_PATTERNS = [/token/i, /password/i, /secret/i, /api.?key/i];

function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(path));
}

type JsonSchemaObject = JsonSchemaNode & {
  type?: string | string[];
  properties?: Record<string, JsonSchemaObject>;
  required?: string[];
  additionalProperties?: JsonSchemaObject | boolean;
  items?: JsonSchemaObject | JsonSchemaObject[];
  anyOf?: JsonSchemaObject[];
  oneOf?: JsonSchemaObject[];
  allOf?: JsonSchemaObject[];
  title?: string;
  description?: string;
};

function cloneSchema<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function asSchemaObject(value: unknown): JsonSchemaObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonSchemaObject;
}

function isObjectSchema(schema: JsonSchemaObject): boolean {
  const type = schema.type;
  if (type === "object") {
    return true;
  }
  if (Array.isArray(type) && type.includes("object")) {
    return true;
  }
  return Boolean(schema.properties || schema.additionalProperties);
}

function mergeObjectSchema(base: JsonSchemaObject, extension: JsonSchemaObject): JsonSchemaObject {
  const mergedRequired = new Set<string>([...(base.required ?? []), ...(extension.required ?? [])]);
  const merged: JsonSchemaObject = {
    ...base,
    ...extension,
    properties: {
      ...base.properties,
      ...extension.properties,
    },
  };
  if (mergedRequired.size > 0) {
    merged.required = Array.from(mergedRequired);
  }
  const additional = extension.additionalProperties ?? base.additionalProperties;
  if (additional !== undefined) {
    merged.additionalProperties = additional;
  }
  return merged;
}

function buildBaseHints(locale: ConfigLocale): ConfigUiHints {
  const hints: ConfigUiHints = {};
  const groupLabels = mergeLocalizedMap(GROUP_LABELS, GROUP_LABELS_ZH, locale);
  const fieldLabels = mergeLocalizedMap(FIELD_LABELS, FIELD_LABELS_ZH, locale);
  const fieldHelp = mergeLocalizedMap(FIELD_HELP, FIELD_HELP_ZH, locale);
  const fieldPlaceholders = mergeLocalizedMap(FIELD_PLACEHOLDERS, FIELD_PLACEHOLDERS_ZH, locale);
  for (const [group, label] of Object.entries(groupLabels)) {
    hints[group] = {
      label,
      group: label,
      order: GROUP_ORDER[group],
    };
  }
  for (const [path, label] of Object.entries(fieldLabels)) {
    const normalized = normalizeHintKey(path);
    const current = hints[normalized];
    hints[normalized] = current ? { ...current, label } : { label };
  }
  for (const [path, help] of Object.entries(fieldHelp)) {
    const normalized = normalizeHintKey(path);
    const current = hints[normalized];
    hints[normalized] = current ? { ...current, help } : { help };
  }
  for (const [path, placeholder] of Object.entries(fieldPlaceholders)) {
    const normalized = normalizeHintKey(path);
    const current = hints[normalized];
    hints[normalized] = current ? { ...current, placeholder } : { placeholder };
  }
  return hints;
}

function hintForPath(path: string[], hints: ConfigUiHints): ConfigUiHint | undefined {
  const key = path.join(".");
  const direct = hints[key];
  if (direct) {
    return direct;
  }
  const segments = key.split(".");
  for (const [hintKey, hint] of Object.entries(hints)) {
    if (!hintKey.includes("*")) {
      continue;
    }
    const hintSegments = hintKey.split(".");
    if (hintSegments.length !== segments.length) {
      continue;
    }
    let match = true;
    for (let i = 0; i < segments.length; i += 1) {
      if (hintSegments[i] !== "*" && hintSegments[i] !== segments[i]) {
        match = false;
        break;
      }
    }
    if (match) {
      return hint;
    }
  }
  return undefined;
}

function applyLocalizedSchema(schema: ConfigSchema, hints: ConfigUiHints): ConfigSchema {
  const next = cloneSchema(schema);

  const visit = (node: JsonSchemaObject, path: string[]) => {
    const hint = hintForPath(path, hints);
    if (hint?.label) {
      node.title = hint.label;
    }
    if (hint?.help) {
      node.description = hint.help;
    }

    const properties = node.properties ?? {};
    for (const [key, value] of Object.entries(properties)) {
      const child = asSchemaObject(value);
      if (!child) {
        continue;
      }
      visit(child, [...path, key]);
    }

    const items = node.items;
    if (items && typeof items === "object") {
      const entry = Array.isArray(items) ? items[0] : items;
      const child = asSchemaObject(entry);
      if (child) {
        visit(child, [...path, "*"]);
      }
    }

    const additional = node.additionalProperties;
    if (additional && typeof additional === "object") {
      const child = asSchemaObject(additional);
      if (child) {
        visit(child, [...path, "*"]);
      }
    }

    const unions = [node.anyOf, node.oneOf, node.allOf];
    for (const variants of unions) {
      if (!variants) {
        continue;
      }
      for (const variant of variants) {
        const child = asSchemaObject(variant);
        if (child) {
          visit(child, path);
        }
      }
    }
  };

  const root = asSchemaObject(next);
  if (root) {
    visit(root, []);
  }

  return next;
}

function applySensitiveHints(hints: ConfigUiHints): ConfigUiHints {
  const next = { ...hints };
  for (const key of Object.keys(next)) {
    if (isSensitivePath(key)) {
      next[key] = { ...next[key], sensitive: true };
    }
  }
  return next;
}

function applyPluginHints(
  hints: ConfigUiHints,
  plugins: PluginUiMetadata[],
  locale: ConfigLocale,
): ConfigUiHints {
  const preserveLocalized = locale === "zh-CN";
  const next: ConfigUiHints = { ...hints };
  for (const plugin of plugins) {
    const id = plugin.id.trim();
    if (!id) {
      continue;
    }
    const name = (plugin.name ?? id).trim() || id;
    const basePath = `plugins.entries.${id}`;

    const pluginHelp = plugin.description
      ? locale === "zh-CN"
        ? `${plugin.description}（插件：${id}）`
        : `${plugin.description} (plugin: ${id})`
      : locale === "zh-CN"
        ? `插件条目：${id}。`
        : `Plugin entry for ${id}.`;
    const baseCurrent = next[basePath] ?? {};
    next[basePath] = {
      ...baseCurrent,
      label: preserveLocalized ? (baseCurrent.label ?? name) : name,
      help: preserveLocalized ? (baseCurrent.help ?? pluginHelp) : pluginHelp,
    };
    const enabledCurrent = next[`${basePath}.enabled`] ?? {};
    const enableLabel = locale === "zh-CN" ? `启用 ${name}` : `Enable ${name}`;
    next[`${basePath}.enabled`] = {
      ...enabledCurrent,
      label: preserveLocalized ? (enabledCurrent.label ?? enableLabel) : enableLabel,
    };
    const configCurrent = next[`${basePath}.config`] ?? {};
    const configLabel = locale === "zh-CN" ? `${name} 配置` : `${name} Config`;
    const configHelp =
      locale === "zh-CN"
        ? `由插件定义的配置内容：${id}。`
        : `Plugin-defined config payload for ${id}.`;
    next[`${basePath}.config`] = {
      ...configCurrent,
      label: preserveLocalized ? (configCurrent.label ?? configLabel) : configLabel,
      help: preserveLocalized ? (configCurrent.help ?? configHelp) : configHelp,
    };

    const uiHints = plugin.configUiHints ?? {};
    for (const [relPathRaw, hint] of Object.entries(uiHints)) {
      const relPath = relPathRaw.trim().replace(/^\./, "");
      if (!relPath) {
        continue;
      }
      const key = normalizeHintKey(`${basePath}.config.${relPath}`);
      const current = next[key] ?? {};
      next[key] = {
        ...current,
        ...hint,
        ...(preserveLocalized && current.label ? { label: current.label } : {}),
        ...(preserveLocalized && current.help ? { help: current.help } : {}),
      };
    }
  }
  return next;
}

function applyChannelHints(
  hints: ConfigUiHints,
  channels: ChannelUiMetadata[],
  locale: ConfigLocale,
): ConfigUiHints {
  const preserveLocalized = locale === "zh-CN";
  const next: ConfigUiHints = { ...hints };
  for (const channel of channels) {
    const id = channel.id.trim();
    if (!id) {
      continue;
    }
    const basePath = `channels.${id}`;
    const current = next[basePath] ?? {};
    const label = channel.label?.trim();
    const help = channel.description?.trim();
    next[basePath] = {
      ...current,
      ...(label ? { label: preserveLocalized ? (current.label ?? label) : label } : {}),
      ...(help ? { help: preserveLocalized ? (current.help ?? help) : help } : {}),
    };

    const uiHints = channel.configUiHints ?? {};
    for (const [relPathRaw, hint] of Object.entries(uiHints)) {
      const relPath = relPathRaw.trim().replace(/^\./, "");
      if (!relPath) {
        continue;
      }
      const key = normalizeHintKey(`${basePath}.${relPath}`);
      const currentHint = next[key] ?? {};
      next[key] = {
        ...currentHint,
        ...hint,
        ...(preserveLocalized && currentHint.label ? { label: currentHint.label } : {}),
        ...(preserveLocalized && currentHint.help ? { help: currentHint.help } : {}),
      };
    }
  }
  return next;
}

function listHeartbeatTargetChannels(channels: ChannelUiMetadata[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const id of CHANNEL_IDS) {
    const normalized = id.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    ordered.push(normalized);
  }
  for (const channel of channels) {
    const normalized = channel.id.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    ordered.push(normalized);
  }
  return ordered;
}

function applyHeartbeatTargetHints(
  hints: ConfigUiHints,
  channels: ChannelUiMetadata[],
  locale: ConfigLocale,
): ConfigUiHints {
  const next: ConfigUiHints = { ...hints };
  const channelList = listHeartbeatTargetChannels(channels);
  const channelHelp = channelList.length
    ? locale === "zh-CN"
      ? ` 已知渠道：${channelList.join(", ")}。`
      : ` Known channels: ${channelList.join(", ")}.`
    : "";
  const help =
    locale === "zh-CN"
      ? `投递目标（"last"、"none" 或渠道 ID）。${channelHelp}`
      : `Delivery target ("last", "none", or a channel id).${channelHelp}`;
  const paths = ["agents.defaults.heartbeat.target", "agents.list.*.heartbeat.target"];
  for (const path of paths) {
    const current = next[path] ?? {};
    next[path] = {
      ...current,
      help: current.help ?? help,
      placeholder: current.placeholder ?? "last",
    };
  }
  return next;
}

function applyPluginSchemas(schema: ConfigSchema, plugins: PluginUiMetadata[]): ConfigSchema {
  const next = cloneSchema(schema);
  const root = asSchemaObject(next);
  const pluginsNode = asSchemaObject(root?.properties?.plugins);
  const entriesNode = asSchemaObject(pluginsNode?.properties?.entries);
  if (!entriesNode) {
    return next;
  }

  const entryBase = asSchemaObject(entriesNode.additionalProperties);
  const entryProperties = entriesNode.properties ?? {};
  entriesNode.properties = entryProperties;

  for (const plugin of plugins) {
    if (!plugin.configSchema) {
      continue;
    }
    const entrySchema = entryBase
      ? cloneSchema(entryBase)
      : ({ type: "object" } as JsonSchemaObject);
    const entryObject = asSchemaObject(entrySchema) ?? ({ type: "object" } as JsonSchemaObject);
    const baseConfigSchema = asSchemaObject(entryObject.properties?.config);
    const pluginSchema = asSchemaObject(plugin.configSchema);
    const nextConfigSchema =
      baseConfigSchema &&
      pluginSchema &&
      isObjectSchema(baseConfigSchema) &&
      isObjectSchema(pluginSchema)
        ? mergeObjectSchema(baseConfigSchema, pluginSchema)
        : cloneSchema(plugin.configSchema);

    entryObject.properties = {
      ...entryObject.properties,
      config: nextConfigSchema,
    };
    entryProperties[plugin.id] = entryObject;
  }

  return next;
}

function applyChannelSchemas(schema: ConfigSchema, channels: ChannelUiMetadata[]): ConfigSchema {
  const next = cloneSchema(schema);
  const root = asSchemaObject(next);
  const channelsNode = asSchemaObject(root?.properties?.channels);
  if (!channelsNode) {
    return next;
  }
  const channelProps = channelsNode.properties ?? {};
  channelsNode.properties = channelProps;

  for (const channel of channels) {
    if (!channel.configSchema) {
      continue;
    }
    const existing = asSchemaObject(channelProps[channel.id]);
    const incoming = asSchemaObject(channel.configSchema);
    if (existing && incoming && isObjectSchema(existing) && isObjectSchema(incoming)) {
      channelProps[channel.id] = mergeObjectSchema(existing, incoming);
    } else {
      channelProps[channel.id] = cloneSchema(channel.configSchema);
    }
  }

  return next;
}

function stripChannelSchema(schema: ConfigSchema): ConfigSchema {
  const next = cloneSchema(schema);
  const root = asSchemaObject(next);
  if (!root || !root.properties) {
    return next;
  }
  const channelsNode = asSchemaObject(root.properties.channels);
  if (channelsNode) {
    channelsNode.properties = {};
    channelsNode.required = [];
    channelsNode.additionalProperties = true;
  }
  return next;
}

const cachedBaseByLocale = new Map<ConfigLocale, ConfigSchemaResponse>();

function buildBaseConfigSchema(locale: ConfigLocale): ConfigSchemaResponse {
  const cached = cachedBaseByLocale.get(locale);
  if (cached) {
    return cached;
  }
  const schema = OpenClawSchema.toJSONSchema({
    target: "draft-07",
    unrepresentable: "any",
  });
  schema.title = "OpenClawConfig";
  const hints = applyAutoHintsFromSchema(
    schema,
    applySensitiveHints(buildBaseHints(locale)),
    locale,
  );
  const next = {
    schema: stripChannelSchema(schema),
    uiHints: hints,
    version: VERSION,
    generatedAt: new Date().toISOString(),
  };
  cachedBaseByLocale.set(locale, next);
  return next;
}

export function buildConfigSchema(params?: {
  locale?: string;
  plugins?: PluginUiMetadata[];
  channels?: ChannelUiMetadata[];
}): ConfigSchemaResponse {
  const locale = normalizeConfigLocale(params?.locale);
  const base = buildBaseConfigSchema(locale);
  const plugins = params?.plugins ?? [];
  const channels = params?.channels ?? [];
  if (plugins.length === 0 && channels.length === 0) {
    return {
      ...base,
      schema: applyLocalizedSchema(base.schema, base.uiHints),
    };
  }
  const mergedHints = applySensitiveHints(
    applyHeartbeatTargetHints(
      applyChannelHints(applyPluginHints(base.uiHints, plugins, locale), channels, locale),
      channels,
      locale,
    ),
  );
  const mergedSchema = applyChannelSchemas(applyPluginSchemas(base.schema, plugins), channels);
  const localizedMergedHints = applyAutoHintsFromSchema(mergedSchema, mergedHints, locale);
  return {
    ...base,
    schema: applyLocalizedSchema(mergedSchema, localizedMergedHints),
    uiHints: localizedMergedHints,
  };
}
