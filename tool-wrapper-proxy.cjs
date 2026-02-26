#!/usr/bin/env node
// OpenClaw Tool Wrapper Proxy v10.3
// v10.3: systematic fix — unified intent routing, persistent state, Haiku capability injection
// v10.2: mac-agentd integration — structured host execution replacing claude -p
// v10.1: GLM-4.7-Flash Ollama-first routing with Claude fallback
// v10: Mem0 memory layer — persistent cross-session memory via mem0-service (:8002)
// v9: Smart intent (strong/weak signals), /health, /metrics, rate limiting, error handling
// v8: Dev mode — spawn `claude -p` for development tasks (read/write/test)
// v7: CLI tools integration (summarize, gh)
// v6: Multi-skill routing (web_search, system_status, scheduler, google_workspace, etc.)

const http = require("http");
const { execFile, spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
// Note: p-limit uses ES6 modules, extract default export
const pLimitModule = require("p-limit");
const pLimit = pLimitModule.default || pLimitModule;
const ollamaRouter = require("./ollama-router.cjs");
const { ModelFailover } = require("./model-failover.cjs");
const agentRouter = require("./agent-router.cjs");
const { IntentDetector } = require("./intent-detector-optimized.cjs");
const { WebSearchService } = require("./websearch-service.cjs");
const { SpecManager } = require("./spec-manager.cjs");
const {
  withTimeout,
  initRequestMetadata,
  logStructuredTiming,
  injectToolsIntoSystemPrompt,
  executeToolWithConcurrency,
  CircuitBreaker,
  HybridIntentClassifier,
  KeywordMatcher,
} = require("./p1-improvements.cjs");
const {
  initializeLastDevProject,
  getLastDevProject,
  setLastDevProject,
} = require("./lib/openclaw-p0.2-last-dev-project.cjs");
const { DecisionEngine } = require("./decision-engine.cjs");
const { OllamaKeepalive } = require("./infra/ollama-keepalive.cjs");

const UPSTREAM_HOST = "localhost";
const UPSTREAM_PORT = 3456;
const LISTEN_PORT = 3457;
const SKILL_API_PORT = 8000;
const MEM0_PORT = 8002;
const VERSION = "10.4.0";
const startedAt = Date.now();

// ─── Phase -1: Request Trace — structured observability ──────────────
const TRACE_LOG_PATH = path.join(__dirname, "logs", "request-trace.jsonl");
const _traceBuffer = [];
const TRACE_FLUSH_INTERVAL = 1000; // 1s batch write

function createTrace(reqId) {
  return {
    trace_id: crypto.randomUUID(),
    req_id: reqId,
    ts: Date.now(),
    spans: [],
    decision_ms: 0,
    executor: "",
    executor_ms: 0,
    total_ms: 0,
    fallback: false,
    model_switch: false,
    intent_cache_hit: false,
    ollama_quality_score: 0,
    route_path: "",
    _start: Date.now(),
  };
}

function traceSpan(trace, stage) {
  const start = Date.now();
  return {
    end(meta) {
      const ms = Date.now() - start;
      trace.spans.push({ stage, ms, ...meta });
      return ms;
    },
  };
}

function finalizeTrace(trace, executor, extra) {
  trace.executor = executor || trace.executor || "unknown";
  trace.total_ms = Date.now() - trace._start;
  if (extra) {
    Object.assign(trace, extra);
  }
  delete trace._start;
  _traceBuffer.push(JSON.stringify(trace));
}

// Batch flush trace buffer to disk
setInterval(() => {
  if (_traceBuffer.length === 0) {
    return;
  }
  const batch = _traceBuffer.splice(0, _traceBuffer.length);
  fs.appendFile(TRACE_LOG_PATH, batch.join("\n") + "\n", (err) => {
    if (err) {
      console.error(`[trace] write error: ${err.message}`);
    }
  });
}, TRACE_FLUSH_INTERVAL);

// ─── P1.4: Config Manager — 統一管理敏感配置 ──────────────────────

/**
 * 配置管理器：從環境變數讀取所有敏感信息
 * 所有 API key、token 都應該外部化，不應硬編碼
 */
class ConfigManager {
  constructor() {
    this.config = {};
    this.requiredKeys = [];
    this.optionalKeys = [];
  }

  /**
   * 標記必需的配置項
   * @param {string} key - 環境變數名稱
   * @param {string} description - 描述
   */
  required(key, description) {
    this.requiredKeys.push({ key, description });
    const value = process.env[key];
    if (!value) {
      console.error(`[CONFIG] 必需環境變數缺失: ${key} (${description})`);
      throw new Error(`Missing required config: ${key}`);
    }
    this.config[key] = value;
    return value;
  }

  /**
   * 標記可選的配置項（有預設值）
   * @param {string} key - 環境變數名稱
   * @param {*} defaultValue - 預設值
   * @param {string} description - 描述
   */
  optional(key, defaultValue, description) {
    this.optionalKeys.push({ key, description, defaultValue });
    const value = process.env[key] || defaultValue;
    this.config[key] = value;
    if (!process.env[key]) {
      console.warn(`[CONFIG] ${key} 未設置，使用預設值`);
    }
    return value;
  }

  /**
   * 獲取配置值
   */
  get(key) {
    return this.config[key];
  }

  /**
   * 驗證啟動時的配置狀態
   */
  validate() {
    console.log(`[CONFIG] 已加載 ${Object.keys(this.config).length} 個配置項`);
    if (this.requiredKeys.length > 0) {
      console.log(`[CONFIG] 必需: ${this.requiredKeys.map((r) => r.key).join(", ")}`);
    }
    if (this.optionalKeys.length > 0) {
      console.log(
        `[CONFIG] 可選: ${this.optionalKeys.map((r) => `${r.key}(預設: ${r.defaultValue})`).join(", ")}`,
      );
    }
  }
}

const config = new ConfigManager();

// ─── Metrics ─────────────────────────────────────────────────────

const metrics = {
  requests: 0,
  devMode: 0,
  skillCalls: 0,
  cliCalls: 0,
  normalChat: 0,
  errors: 0,
  rateLimited: 0,
  memorySearches: 0,
  memoryAdds: 0,
  memoryErrors: 0,
  progressQueries: 0,
  ollamaRouted: 0,
  ollamaFallback: 0,
};

// ─── Model Failover Automation ──────────────────────────────

const failover = new ModelFailover({
  models: ["claude-haiku", "ollama"],
  recoveryWindow: 30, // 分鐘
  failureWindow: 5, // 分鐘
  failureThreshold: 2,
});

// ─── Multi-Agent System ─────────────────────────────────────

agentRouter.loadAgentsConfig(path.join(__dirname, "agents-config.json"));

// ─── Intent Detection (Optimized) ───────────────────────

const intentDetector = new IntentDetector({
  ollamaUrl: "http://localhost:11434",
  model: "qwen2.5-coder:7b",
  temperature: 0.1,
  cacheTTL: 3600,
});

// ─── WebSearch Service ──────────────────────────────────

const webSearchService = new WebSearchService({
  braveApiKey: config.optional("BRAVE_API_KEY", null, "Brave search API key"),
  cacheTTL: 3600,
  maxResults: 10,
  resultTruncation: 5,
  monthlyLimit: 1000,
});

// ─── Spec-Driven Development ────────────────────────────

const specManager = new SpecManager({
  specsPath: path.join(process.env.HOME || "/root", ".claude", "specs"),
  metricsPath: path.join(process.env.HOME || "/root", ".claude", "logs", "spec-metrics.jsonl"),
});

// ─── Decision Engine (Phase 0) ──────────────────────────────

const decisionEngine = new DecisionEngine();
const ollamaKeepalive = new OllamaKeepalive();
ollamaKeepalive.start();

// ─── P1.9 + P1.11: Circuit Breaker ──────────────────────────────

const circuitBreaker = new CircuitBreaker({
  threshold: 5,
  resetMs: 60000,
});

// ─── P1.10: Concurrency Limits ──────────────────────────────────

const cpuLimit = pLimit(1); // docker build, shell, heavy ops
const ioLimit = pLimit(3); // web search, file operations

// ─── P1.1: Intent Classifier ────────────────────────────────────

const intentClassifier = new HybridIntentClassifier({
  ollamaUrl: "http://localhost:11434",
  model: "qwen2.5-coder:7b",
  confidenceThreshold: 0.8,
});

const AGENT_ROUTING_LOG = path.join(
  process.env.HOME || "/root",
  ".claude",
  "logs",
  "agent-routing.jsonl",
);

// ─── Token Usage Tracking (Rex-AI Dashboard) ─────────────────────

function trackTokenUsage(model, provider, usage, durationMs) {
  if (!usage) {
    return;
  }
  const payload = {
    model: model || "unknown",
    provider: provider || "anthropic",
    input_tokens: usage.input_tokens || usage.prompt_tokens || 0,
    output_tokens: usage.output_tokens || usage.completion_tokens || 0,
    cache_read: usage.cache_read_input_tokens || 0,
    cache_write: usage.cache_creation_input_tokens || 0,
    source: "openclaw",
    duration_ms: durationMs ? Math.round(durationMs) : null,
  };
  const body = JSON.stringify(payload);
  const req = http.request({
    hostname: "localhost",
    port: 8004,
    path: "/api/v1/token-usage",
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    timeout: 3000,
  });
  req.on("error", () => {});
  req.on("timeout", () => req.destroy());
  req.write(body);
  req.end();
}

// ─── Rate Limiting ──────────────────────────────────────────────

const rateLimits = {
  dev: { max: 10, windowMs: 5 * 60 * 1000, hits: [] }, // 10 per 5 min
  skill: { max: 30, windowMs: 60 * 1000, hits: [] }, // 30 per min
};

function checkRateLimit(type) {
  const limit = rateLimits[type];
  if (!limit) {
    return true;
  }
  const now = Date.now();
  limit.hits = limit.hits.filter((t) => now - t < limit.windowMs);
  if (limit.hits.length >= limit.max) {
    metrics.rateLimited++;
    return false;
  }
  limit.hits.push(now);
  return true;
}

// ─── Dev Mode Configuration ──────────────────────────────────────

// v10.3: Unified DEV_ACTION_WORDS (merged strong+weak, no longer split)
const DEV_ACTION_WORDS = [
  // 操作類（中文）
  "查看",
  "看一下",
  "看看",
  "幫我看",
  "檢查",
  "分析",
  "優化",
  "改善",
  "改一下",
  "修復",
  "修",
  "重構",
  "實作",
  "開發",
  "寫",
  "加",
  "新增",
  "提交",
  "commit",
  "推送",
  "push",
  "跑測試",
  "測試",
  "執行測試",
  "重啟",
  "重啟容器",
  "restart",
  "看 log",
  "logs",
  "日誌",
  "狀態",
  "status",
  "diff",
  "檔案",
  "讀取",
  "列出",
  "修改",
  "清理",
  "效能優化",
  "讀檔案",
  "程式碼審查",
  "部署",
  "建構",
  "編譯",
  "修 bug",
  "找 bug",
  "進行改善",
  "直接改善",
  "幫我改",
  "寫一個",
  "寫個",
  "加一個",
  "加個",
  "新增功能",
  "改這個",
  // 確認/執行類（follow-up 常見）
  "執行",
  "做",
  "做吧",
  "好",
  "繼續",
  "開始",
  "進行",
  "處理",
  "do it",
  "go",
  "execute",
  "proceed",
  "yes",
  "ok",
  // 操作類（英文）
  "check",
  "analyze",
  "optimize",
  "improve",
  "fix",
  "refactor",
  "implement",
  "develop",
  "run test",
  "run tests",
  "deploy",
  "build",
  "write code",
  "create function",
  "add feature",
  "debug",
  "review code",
  "modify",
  "read file",
  "check code",
];

// Last dev-mode project (for follow-up messages without project keyword)
// v10.3: Persisted to /tmp/mac-agentd/last-dev-project.json
// P0.2: lastDevProject 使用 Redis + session 檔案持久化
// (由 openclaw-p0.2-last-dev-project.js 管理，此處只做 wrapper)
let lastDevProject = null;

async function saveLastProject(dir) {
  lastDevProject = dir;
  try {
    await setLastDevProject(dir);
  } catch (e) {
    console.error(`[wrapper] save lastProject error: ${e.message}`);
  }
}

async function loadLastProject() {
  try {
    const project = await getLastDevProject();
    if (project) {
      lastDevProject = project;
      console.log(`[wrapper] restored lastDevProject: ${project}`);
    }
  } catch (e) {
    console.error(`[wrapper] load lastProject error: ${e.message}`);
  }
}

// P0.2 初始化：容器啟動時 async 調用
// (稍後在 server 啟動前執行)

// ─── Financial Agent Routing ──────────────────────────────────

// ─── Taiwan Stock MVP Integration ──────────────────────────────
const COMMON_STOCKS = {
  2330: "TSMC（台積電）",
  2454: "MediaTek（聯發科）",
  2882: "Cathay Pacific",
  2891: "CTBC（中信銀）",
  "0050": "元大50",
  "0056": "元大高息",
};

function detectStockSymbol(userText) {
  const lowerText = userText.toLowerCase();
  for (const [code, name] of Object.entries(COMMON_STOCKS)) {
    if (lowerText.includes(code) || lowerText.includes(name)) {
      return code;
    }
  }
  return null;
}

async function fetchTaiwanStockIndicators(stockId, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      return resolve(null);
    }
    const http = require("http");
    const url = "http://localhost:8888/api/v1/indicators/" + stockId + "/latest";
    const req = http.get(url, { timeout: 2000 }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (signal && signal.aborted) {
          return resolve(null);
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          req.destroy();
          resolve(null);
        },
        { once: true },
      );
    }
  });
}

const FINANCIAL_KEYWORDS = [
  "股票",
  "股市",
  "台股",
  "TAIEX",
  "TWII",
  "0050",
  "0056",
  "0080",
  "外資",
  "投信",
  "自營商",
  "法人",
  "技術分析",
  "基本面",
  "估值",
  "PE",
  "PB",
  "股息",
  "dividend",
  "均線",
  "MA",
  "RSI",
  "MACD",
  "Bollinger",
  "支撐",
  "阻力",
  "突破",
  "進場",
  "出場",
  "停損",
  "停利",
  "波動",
  "走勢",
  "行情",
  "盤勢",
  "個股",
  "漲跌",
  "成交量",
  "營收",
  "ROE",
  "ROA",
  "EPS",
  "淨利率",
  "stock",
  "market",
  "invest",
  "trading",
  "portfolio",
];

function detectFinancialIntent(userText) {
  if (!userText) {
    return null;
  }
  const lowerText = userText.toLowerCase();
  let matchCount = 0;
  for (const kw of FINANCIAL_KEYWORDS) {
    if (lowerText.includes(kw.toLowerCase())) {
      matchCount++;
    }
    if (matchCount >= 2) {
      return { type: "financial", keywords: [kw] };
    }
  }
  return null;
}

const PROJECT_ROUTES = [
  {
    keywords: [
      "taiwan-stock",
      "taiwan stock",
      "台股系統",
      "股票系統",
      "台灣股票",
      "股票專案",
      "stock mvp",
      "stock-mvp",
    ],
    dir: "~/Project/active_projects/taiwan-stock-mvp",
  },
  {
    keywords: ["personal-ai", "personal ai", "pai", "個人助理", "助理系統"],
    dir: "~/Project/active_projects/personal-ai-assistant",
  },
  { keywords: ["openclaw", "telegram bot", "bot設定", "bot 設定"], dir: "~/openclaw" },
  {
    keywords: ["ai-news", "ai news", "新聞摘要", "新聞系統"],
    dir: "~/Project/active_projects/ai-news-digest",
  },
  { keywords: ["stationery", "文具", "文具店"], dir: "~/Project/active_projects/stationery_shop" },
  {
    keywords: ["sales-visit", "sales visit", "業務拜訪", "拜訪"],
    dir: "~/Project/active_projects/sales-visit",
  },
  { keywords: ["central-hub", "central hub", "中央", "控制中心"], dir: "~/Project/central-hub" },
  { keywords: ["channels", "channel", "頻道"], dir: "~/Project/active_projects/channels" },
  { keywords: ["mac mini", "mac-mini", "macmini", "主機", "伺服器", "server"], dir: "~/openclaw" },
];

const ALLOWED_DEV_PATHS = [
  "/Users/rexmacmini/Project/active_projects",
  "/Users/rexmacmini/Project/central-hub",
  "/Users/rexmacmini/openclaw",
];

const DEV_TIMEOUT_MS = 180000; // 3 minutes
const DEV_MAX_OUTPUT = 4000; // chars
const DEV_TOOLS = "Bash,Edit,Read,Glob,Grep,Write";

// ─── Skill Intent Router ───────────────────────────────────────
const SKILL_ROUTES = [
  {
    name: "web_search",
    keywords: [
      "搜尋",
      "搜索",
      "查詢",
      "查一下",
      "幫我找",
      "幫我查",
      "新聞",
      "search",
      "find",
      "look up",
      "google",
    ],
    buildParams: (text) => ({ query: text, max_results: 5 }),
  },
  {
    name: "system_status",
    keywords: [
      "系統狀態",
      "系統健康",
      "cpu",
      "記憶體",
      "ram",
      "磁碟",
      "磁碟空間",
      "服務狀態",
      "健康檢查",
      "system status",
      "disk",
      "memory",
      "佔用",
      "使用率",
      "容器狀態",
      "docker status",
    ],
    buildParams: () => ({ mode: "full" }),
  },
  {
    name: "scheduler",
    keywords: ["排程", "提醒我", "定時", "鬧鐘", "提醒", "排班", "schedule", "remind"],
    subIntents: {
      add: ["新增", "加", "設定", "建立", "add", "create", "set"],
      cancel: ["取消", "刪除", "移除", "cancel", "delete", "remove"],
      list: [],
    },
    buildParams: (text) => {
      for (const [action, kws] of Object.entries(SKILL_ROUTES[2].subIntents)) {
        if (kws.some((k) => text.toLowerCase().includes(k))) {
          return { action, description: text };
        }
      }
      return { action: "list" };
    },
  },
  {
    name: "google_workspace",
    keywords: [
      "行程",
      "日曆",
      "會議",
      "約會",
      "calendar",
      "郵件",
      "信件",
      "email",
      "gmail",
      "雲端硬碟",
      "drive",
      "過濾",
      "退訂",
      "取消訂閱",
      "filter",
      "unsubscribe",
      "封鎖",
    ],
    subIntents: {
      "calendar.list": ["行程", "日曆", "會議", "約會", "calendar", "今天行程", "明天行程"],
      "calendar.create": ["新增行程", "加行程", "建立會議", "排會議"],
      "gmail.batch_delete": [
        "刪除郵件",
        "刪郵件",
        "清理郵件",
        "批量刪除",
        "刪除垃圾",
        "delete email",
        "delete mail",
        "trash email",
      ],
      "gmail.filter_create": [
        "過濾",
        "過濾規則",
        "自動刪除",
        "封鎖寄件者",
        "封鎖",
        "filter",
        "block sender",
        "block",
      ],
      "gmail.unsubscribe": ["取消訂閱", "退訂", "unsubscribe"],
      "gmail.list": ["郵件", "信件", "email", "gmail", "收件匣", "inbox"],
      "gmail.send": ["寄信", "發郵件", "發信", "send email"],
      "drive.list": ["雲端硬碟", "drive", "檔案列表"],
    },
    buildParams: (text) => {
      const lower = text.toLowerCase();
      for (const [mode, kws] of Object.entries(SKILL_ROUTES[3].subIntents)) {
        if (kws.some((k) => lower.includes(k))) {
          // Gmail filter_create: extract sender from text
          if (mode === "gmail.filter_create") {
            const senderInfo = extractSenderFromText(text);
            return { mode, from_address: senderInfo.address, filter_action: senderInfo.action };
          }
          // Gmail unsubscribe: needs to search sender first, handled by wrapper
          if (mode === "gmail.unsubscribe") {
            return { mode: "gmail.unsubscribe", query: text };
          }
          // Gmail: convert natural language to Gmail search syntax
          if (mode === "gmail.list") {
            let gmailQuery = "is:unread";
            if (lower.includes("已讀") || lower.includes("read")) {
              gmailQuery = "is:read";
            }
            if (lower.includes("starred") || lower.includes("星號") || lower.includes("重要")) {
              gmailQuery += " is:starred";
            }
            if (lower.includes("今天") || lower.includes("today")) {
              gmailQuery += " newer_than:1d";
            }
            if (lower.includes("這週") || lower.includes("this week")) {
              gmailQuery += " newer_than:7d";
            }
            return { mode, query: gmailQuery, max_results: 5 };
          }
          return { mode, query: text, max_results: 5 };
        }
      }
      return { mode: "calendar.list", max_results: 5 };
    },
  },
  {
    name: "file_organizer",
    keywords: ["整理檔案", "清理檔案", "整理桌面", "清理下載", "organize files", "cleanup"],
    buildParams: (text) => ({ mode: "organize", description: text }),
  },
  {
    name: "finance",
    keywords: ["投資分析", "roi", "風險評估", "投資組合", "報酬率", "finance"],
    buildParams: (text) => ({ mode: "roi", description: text }),
  },
  {
    name: "data_analysis",
    keywords: ["分析數據", "數據分析", "統計", "趨勢", "analyze data", "statistics"],
    buildParams: (text) => ({ mode: "summary", description: text }),
  },
  {
    name: "docker_control",
    keywords: [
      "重啟",
      "restart",
      "容器",
      "container",
      "docker ps",
      "docker 狀態",
      "docker logs",
      "看 logs",
      "容器列表",
      "docker",
    ],
    buildParams: (text) => {
      const lower = text.toLowerCase();
      // Detect action
      if (lower.includes("重啟") || lower.includes("restart")) {
        // Extract container name
        const containerMatch = text.match(/(?:重啟|restart)\s+(\S+)/i);
        const container = containerMatch ? containerMatch[1] : "";
        return { action: "restart", container };
      }
      if (lower.includes("logs") || lower.includes("日誌") || lower.includes("看 log")) {
        const containerMatch =
          text.match(/(?:logs?|日誌)\s+(\S+)/i) || text.match(/(\S+)\s+(?:logs?|日誌)/i);
        const container = containerMatch ? containerMatch[1] : "";
        return { action: "logs", container, lines: 50 };
      }
      if (lower.includes("stats") || lower.includes("資源")) {
        return { action: "stats" };
      }
      return { action: "list" };
    },
  },
  {
    name: "work_tracker_query",
    keywords: [
      "工作統計",
      "工作記錄",
      "這週做了什麼",
      "今天記了",
      "今天做了",
      "work tracker",
      "本週工作",
      "最近工作",
      "工時",
    ],
    buildParams: (text) => {
      const lower = text.toLowerCase();
      if (lower.includes("這週") || lower.includes("本週") || lower.includes("week")) {
        if (lower.includes("工時") || lower.includes("hours") || lower.includes("時間")) {
          return { mode: "hours" };
        }
        return { mode: "week" };
      }
      if (lower.includes("最近") || lower.includes("recent")) {
        return { mode: "recent", limit: 10 };
      }
      return { mode: "today" };
    },
  },
  {
    name: "rex_ai_dashboard",
    keywords: ["rex", "dashboard", "儀表板", "rex-ai", "服務狀態", "專案狀態", "backlog", "待辦"],
    buildParams: (text) => {
      const lower = text.toLowerCase();
      if (lower.includes("backlog") || lower.includes("待辦")) {
        return { mode: "backlog" };
      }
      if (lower.includes("worklog") || lower.includes("工作記錄")) {
        return { mode: "worklog" };
      }
      if (lower.includes("alert") || lower.includes("警報")) {
        return { mode: "alerts" };
      }
      if (lower.includes("摘要") || lower.includes("summary")) {
        return { mode: "summary" };
      }
      return { mode: "status" };
    },
  },
];

// ─── Skill Tools Definition for Claude Tool-Use (fallback routing) ─

const SKILL_TOOLS = [
  {
    type: "function",
    function: {
      name: "system_status",
      description:
        "查詢系統狀態和資源使用情況。包括 CPU、記憶體、磁碟、容器狀態等。當用戶問「RAM 佔用多少」、「系統怎樣」、「CPU 使用率」、「容器狀態」、「磁碟空間」等問題時調用。",
      parameters: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            description: "查詢模式：full（完整狀態）或 quick（快速檢查）",
            enum: ["full", "quick"],
          },
        },
        required: ["mode"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "搜尋網路資訊。當用戶要求搜索、查詢最新資訊、新聞時調用。返回相關的網頁結果。",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "搜尋關鍵詞",
          },
          max_results: {
            type: "integer",
            description: "最多返回的結果數（1-10）",
            default: 5,
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "google_workspace",
      description:
        "操作 Google 服務（Gmail、Google Calendar、Google Drive）。支持的操作：gmail.list（查看郵件）、gmail.read（讀取特定郵件）、gmail.send（發送郵件）、gmail.delete（刪除郵件）、gmail.batch_delete（批量刪除）、gmail.unsubscribe（取消訂閱）、gmail.filter_create（建立過濾規則）、gmail.filter_list（查看過濾規則）、calendar.list（查看行程）、calendar.create（建立行程）、drive.list（列出雲端硬碟檔案）。",
      parameters: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            description: "執行的操作模式",
            enum: [
              "gmail.list",
              "gmail.read",
              "gmail.send",
              "gmail.delete",
              "gmail.batch_delete",
              "gmail.unsubscribe",
              "gmail.filter_create",
              "gmail.filter_list",
              "calendar.list",
              "calendar.create",
              "drive.list",
            ],
          },
          query: {
            type: "string",
            description: "搜尋或操作的查詢文本",
          },
          max_results: {
            type: "integer",
            description: "最多返回的結果數",
          },
        },
        required: ["mode"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "docker_control",
      description:
        "控制 Docker 容器。支持的操作：list（列出容器）、restart（重啟容器）、logs（查看日誌）、stats（查看資源使用）。當用戶要求重啟容器、查看容器狀態、查看日誌時調用。",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "執行的操作",
            enum: ["list", "restart", "logs", "stats"],
          },
          container: {
            type: "string",
            description: "容器名稱或 ID（如果適用）",
          },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "work_tracker_query",
      description:
        "查詢工作追蹤數據。支持的查詢：today（今天的工作記錄）、week（本週工作統計）、hours（本週工時統計）、recent（最近的工作記錄）。當用戶問「今天做了什麼」、「這週做了什麼」、「工時統計」等時調用。",
      parameters: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            description: "查詢模式",
            enum: ["today", "week", "hours", "recent"],
          },
        },
        required: ["mode"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "scheduler",
      description:
        "管理排程和提醒。支持的操作：add（新增排程）、cancel（取消排程）、list（查看排程）。當用戶要求設定提醒、排程、鬧鐘時調用。",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "排程操作",
            enum: ["add", "cancel", "list"],
          },
          description: {
            type: "string",
            description: "排程的描述或內容",
          },
        },
        required: ["action"],
      },
    },
  },
];

// ─── CLI Tool Routes ──────────────────────────────────────────
const CLI_ROUTES = [
  {
    name: "summarize",
    keywords: ["摘要", "總結", "幫我看這個", "幫我讀", "summarize", "summary", "tldr"],
    buildCmd: (text) => {
      const urlMatch = text.match(/https?:\/\/[^\s]+/);
      if (urlMatch) {
        return [
          "summarize",
          urlMatch[0],
          "--extract",
          "--format",
          "md",
          "--plain",
          "--max-extract-characters",
          "3000",
        ];
      }
      return null;
    },
    noUrlMsg: "需要提供 URL 才能摘要。例如「摘要 https://example.com」",
  },
  {
    name: "github",
    keywords: ["github", "pr", "issue", "pull request", "拉取請求", "議題"],
    subIntents: {
      pr_list: ["pr", "pull request", "拉取請求", "pr列表", "pr 列表"],
      issue_list: ["issue", "議題", "issues"],
      pr_view: ["pr #", "pull request #"],
      repo_view: ["repo", "repository", "倉庫"],
    },
    buildCmd: (text) => {
      const lower = text.toLowerCase();
      const repoMatch = text.match(/([a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+)/);
      const repo = repoMatch ? repoMatch[1] : null;
      const numMatch = text.match(/#(\d+)/);
      const num = numMatch ? numMatch[1] : null;

      if (num && (lower.includes("pr") || lower.includes("pull"))) {
        const args = ["gh", "pr", "view", num, "--json", "title,state,body,reviews,url"];
        if (repo) {
          args.push("-R", repo);
        }
        return args;
      }
      if (num && lower.includes("issue")) {
        const args = ["gh", "issue", "view", num, "--json", "title,state,body,comments,url"];
        if (repo) {
          args.push("-R", repo);
        }
        return args;
      }
      if (lower.includes("issue")) {
        const args = [
          "gh",
          "issue",
          "list",
          "--limit",
          "10",
          "--json",
          "number,title,state,updatedAt",
        ];
        if (repo) {
          args.push("-R", repo);
        }
        return args;
      }
      const args = ["gh", "pr", "list", "--limit", "10", "--json", "number,title,state,updatedAt"];
      if (repo) {
        args.push("-R", repo);
      }
      return args;
    },
  },
];

// Note: P1.3 Runtime Tool Injection — buildAvailableToolsList() will be defined after AGENTD_TOOLS

// P1.3: Haiku Capability Injection — 強化 Claude Haiku 的自信心和邊界認知
const BOT_SYSTEM_PROMPT = `你是 Claude Haiku，Rex 的 Telegram 開發助理。你可靠、高效，熟悉他的專案且可透過技能系統執行實際操作。

【你的能力 — 直接執行（系統自動處理，你只需要指示）】

開發任務（你的專長）:
- 讀/寫/修改程式碼 — 說「實作」「修改」「讀這個檔案」等即可觸發
- 跑測試/檢查測試結果
- Git 操作（commit、push、diff、log、status）
- 代碼審查、bug 修復
- 簡單重構和優化

系統管理:
- 查詢系統狀態（CPU/記憶體/磁碟/容器運作狀態）
- Docker 容器管理（重啟、查看 logs）
- 簡單的部署和配置檢查

資訊檢索:
- 搜尋網路資訊
- 摘要網頁/文章（提供 URL 即可）
- GitHub PR/Issue 查詢

生產力:
- Google Workspace 操作（日曆/郵件/Drive）
- 整理檔案
- 管理排程和提醒
- 投資和數據分析

【你的能力邊界 — 清楚知道】
✓ 做的很好：單檔案改動、bug 修復、測試、簡單自動化、數據分析
✓ 可以做：跨多檔案的改動、系統集成（有明確指引時）
✗ 轉給 Claude Opus：架構設計、複雜系統設計、大型重構、安全審查、業務決策

【你的風格】
- 繁體中文、簡潔（3-5句，技術討論可長些）
- 不用 emoji、直接行動
- 不問「需要更多幫助嗎」「要不要我」等冗餘問句
- 操作結果會自動附在對話中，你直接根據結果回答
- 遇到邊界外的任務，直接說「這個需要 Claude Opus 處理」（不推卸責任，是分流）

【禁忌】
- 不提 MEMORY.md、CLAUDE.md、.state 等內部檔案名稱
- 不假裝有你沒有的能力
- 不假裝無法做你能做的事
`;

// ─── Ollama System Prompt (compact for faster inference + Haiku identity) ────────

const OLLAMA_SYSTEM_PROMPT = `你是 Claude Haiku，Rex 的 Telegram 助理。快速、可靠、直接。

能力: 開發（code/test/git）、系統狀態、搜尋、日曆/郵件、投資分析。
邊界: 架構設計/複雜系統設計 → 轉 Opus。
風格: 繁體中文、3-5 句、直接、不用 emoji、不問「需要更多幫助嗎」`;

function prepareOllamaMessages(messages, memoryContext) {
  if (!messages || !messages.length) {
    return messages;
  }
  let msgs = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ ...m, content: normalizeContent(m.content) }));

  let sys = OLLAMA_SYSTEM_PROMPT;
  // Include memory but keep it short (max 500 chars)
  if (memoryContext) {
    const shortMemory = memoryContext.slice(0, 500);
    sys += `\n\n用戶資訊:\n${shortMemory}`;
  }

  // Only keep last 4 messages to reduce context
  if (msgs.length > 4) {
    msgs = msgs.slice(-4);
  }

  return [{ role: "system", content: sys }, ...msgs];
}

// ─── Memory Layer (Mem0) ─────────────────────────────────────────

function mem0Request(path, method, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : "";
    const opts = {
      hostname: "localhost",
      port: MEM0_PORT,
      path,
      method,
      headers: {
        "Content-Type": "application/json",
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
      },
      // /memory/add needs more time for embedding + pgvector write
      timeout: (() => {
        if (path.includes("/add_batch")) {
          return 30000;
        } // 批量 30s
        if (path.includes("/add")) {
          return 15000;
        } // 單筆 15s
        if (path.includes("/delete")) {
          return 5000;
        } // DELETE 5s
        if (path.includes("/update")) {
          return 10000;
        } // UPDATE 10s
        return 5000; // 其他 (search) 5s
      })(),
    };

    const req = http.request(opts, (res) => {
      let chunks = "";
      res.on("data", (c) => (chunks += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(chunks));
        } catch (e) {
          reject(new Error(`mem0 parse: ${e.message}`));
        }
      });
    });
    req.on("error", (e) => reject(e));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("mem0 timeout"));
    });
    if (data) {
      req.write(data);
    }
    req.end();
  });
}

async function fetchMemories(query, userId = "rex", limit = 5) {
  try {
    const result = await mem0Request("/memory/search", "POST", { query, user_id: userId, limit });
    metrics.memorySearches++;
    const memories = result?.memories || [];
    if (memories.length === 0) {
      return null;
    }
    const formatted = memories
      .map((m) => `- ${m.memory || m.text || JSON.stringify(m)}`)
      .join("\n");
    console.log(`[wrapper] mem0 search: ${memories.length} results for "${query.slice(0, 50)}"`);
    return formatted;
  } catch (e) {
    metrics.memoryErrors++;
    console.error(`[wrapper] mem0 search error: ${e.message}`);
    return null;
  }
}

function storeMemory(userText, assistantText, userId = "rex") {
  // Fire-and-forget: send full conversation to mem0 for LLM-based extraction
  if (!userText || !assistantText) {
    return;
  }
  // Skip very short or trivial exchanges
  if (userText.length < 10 && assistantText.length < 20) {
    return;
  }
  // Skip greetings and trivial messages
  const trivial = /^(你好|嗨|hi|hello|hey|ok|好的|謝謝|thanks|bye|掰|test|測試)[\s!！.。?？]*$/i;
  if (trivial.test(userText.trim())) {
    return;
  }

  const messages = [
    { role: "user", content: userText.slice(0, 2000) },
    { role: "assistant", content: assistantText.slice(0, 2000) },
  ];
  mem0Request("/memory/add", "POST", { user_id: userId, messages })
    .then((r) => {
      metrics.memoryAdds++;
      const added = r?.result?.results?.length || 0;
      if (added > 0) {
        console.log(`[wrapper] mem0 add: extracted ${added} memories for user=${userId}`);
      }
    })
    .catch((e) => {
      metrics.memoryErrors++;
      console.error(`[wrapper] mem0 add error: ${e.message}`);
    });
}

// ─── Utility Functions ─────────────────────────────────────────

function normalizeContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((c) => c.type === "text" || typeof c === "string")
      .map((c) => (typeof c === "string" ? c : c.text || ""))
      .join("");
  }
  return String(content || "");
}

// ─── Gmail Filter/Unsubscribe Helpers ─────────────────────────

// Known sender domains for filter creation
const KNOWN_SENDERS = {
  104: { address: "104.com.tw", name: "104人力銀行" },
  人力銀行: { address: "104.com.tw", name: "104人力銀行" },
  tailscale: { address: "tailscale.com", name: "Tailscale" },
  razer: { address: "razer.com", name: "Razer" },
  "google alerts": { address: "googlealerts-noreply@google.com", name: "Google Alerts" },
  "google 快訊": { address: "googlealerts-noreply@google.com", name: "Google Alerts" },
  嘖嘖: { address: "zeczec.com", name: "嘖嘖" },
  zeczec: { address: "zeczec.com", name: "嘖嘖" },
  nintendo: { address: "nintendo", name: "Nintendo" },
  任天堂: { address: "nintendo", name: "Nintendo" },
  facebook: { address: "facebookmail.com", name: "Facebook" },
  fb: { address: "facebookmail.com", name: "Facebook" },
  pubu: { address: "pubu.com.tw", name: "Pubu" },
  元大: { address: "yuanta", name: "元大" },
  github: { address: "github.com", name: "GitHub" },
};

function extractSenderFromText(text) {
  const lower = text.toLowerCase();

  // Check known senders
  for (const [kw, info] of Object.entries(KNOWN_SENDERS)) {
    if (lower.includes(kw.toLowerCase())) {
      // Determine action from text
      let action = "trash"; // default: auto-delete
      if (lower.includes("標記已讀") || lower.includes("mark read")) {
        action = "read";
      }
      if (lower.includes("封存") || lower.includes("archive")) {
        action = "archive";
      }
      if (lower.includes("星號") || lower.includes("star")) {
        action = "star";
      }
      return { address: info.address, action, name: info.name };
    }
  }

  // Try to extract email address from text
  const emailMatch = text.match(/[\w.-]+@[\w.-]+\.\w+/);
  if (emailMatch) {
    let action = "trash";
    if (lower.includes("標記已讀") || lower.includes("mark read")) {
      action = "read";
    }
    if (lower.includes("封存") || lower.includes("archive")) {
      action = "archive";
    }
    return { address: emailMatch[0], action };
  }

  // Try to extract domain-like string
  const domainMatch = text.match(/[\w.-]+\.\w{2,}/);
  if (domainMatch) {
    return { address: domainMatch[0], action: "trash" };
  }

  // Fallback: use the text after action keywords as sender
  const afterBlock = text.match(/(?:封鎖|過濾|block|filter)\s+(.+)/i);
  if (afterBlock) {
    return { address: afterBlock[1].trim(), action: "trash" };
  }

  return { address: text, action: "trash" };
}

async function handleGmailFilterCreate(reqId, userText, wantsStream, res) {
  const senderInfo = extractSenderFromText(userText);
  console.log(
    `[wrapper] #${reqId} gmail filter_create: from=${senderInfo.address} action=${senderInfo.action}`,
  );

  try {
    const result = await callSkill("google_workspace", {
      mode: "gmail.filter_create",
      from_address: senderInfo.address,
      filter_action: senderInfo.action,
    });

    const content = result?.result?.content
      ? JSON.parse(result.result.content)
      : result?.content
        ? JSON.parse(result.content)
        : result;
    if (content?.status === "created") {
      const actionDesc = { trash: "自動刪除", read: "標記已讀", archive: "封存", star: "加星號" };
      const response = `已建立過濾規則：來自 ${senderInfo.name || senderInfo.address} 的郵件將${actionDesc[senderInfo.action] || "自動刪除"}。\n\n規則 ID: ${content.filter_id}`;
      return sendDirectResponse(reqId, response, wantsStream, res);
    }

    const errorMsg = content?.error || "未知錯誤";
    return sendDirectResponse(reqId, `建立過濾規則失敗：${errorMsg}`, wantsStream, res);
  } catch (e) {
    console.error(`[wrapper] #${reqId} gmail filter_create error: ${e.message}`);
    return sendDirectResponse(reqId, `建立過濾規則失敗：${e.message}`, wantsStream, res);
  }
}

async function handleGmailUnsubscribe(reqId, userText, wantsStream, res) {
  console.log(`[wrapper] #${reqId} gmail unsubscribe: "${userText.slice(0, 80)}"`);

  try {
    // Step 1: Extract sender from text and search for their emails
    const senderInfo = extractSenderFromText(userText);
    const searchQuery = `from:${senderInfo.address}`;

    const searchResult = await callSkill("google_workspace", {
      mode: "gmail.list",
      query: searchQuery,
      max_results: 1,
    });

    const searchContent = searchResult?.result?.content
      ? JSON.parse(searchResult.result.content)
      : searchResult?.content
        ? JSON.parse(searchResult.content)
        : null;

    if (!searchContent?.messages?.length) {
      return sendDirectResponse(
        reqId,
        `找不到來自 ${senderInfo.name || senderInfo.address} 的郵件，無法執行退訂。`,
        wantsStream,
        res,
      );
    }

    const messageId = searchContent.messages[0].id;
    const sender = searchContent.messages[0].from || senderInfo.address;

    // Step 2: Call unsubscribe with the message ID
    const unsubResult = await callSkill("google_workspace", {
      mode: "gmail.unsubscribe",
      message_id: messageId,
    });

    const unsubContent = unsubResult?.result?.content
      ? JSON.parse(unsubResult.result.content)
      : unsubResult?.content
        ? JSON.parse(unsubResult.content)
        : unsubResult;

    if (unsubContent?.status === "unsubscribed") {
      const method =
        unsubContent.method === "http_post"
          ? "HTTP 退訂連結"
          : unsubContent.method === "http_get"
            ? "HTTP 退訂連結"
            : "退訂郵件";
      return sendDirectResponse(
        reqId,
        `已退訂 ${sender} — 透過${method}完成。\n後續郵件可能需要幾天才會停止。`,
        wantsStream,
        res,
      );
    }

    if (unsubContent?.status === "no_unsubscribe") {
      return sendDirectResponse(
        reqId,
        `${sender} 的郵件沒有退訂連結 (List-Unsubscribe header)。\n建議改用「封鎖 ${senderInfo.address}」建立過濾規則自動刪除。`,
        wantsStream,
        res,
      );
    }

    const errorMsg = unsubContent?.error || "退訂失敗";
    return sendDirectResponse(reqId, `退訂 ${sender} 失敗：${errorMsg}`, wantsStream, res);
  } catch (e) {
    console.error(`[wrapper] #${reqId} gmail unsubscribe error: ${e.message}`);
    return sendDirectResponse(reqId, `退訂失敗：${e.message}`, wantsStream, res);
  }
}

// ─── Skill Intent Detection ────────────────────────────────────

// P1.2: Multi-intent Detection (支持檢測多個意圖)
/**
 * 檢測文本中的多個 skill 意圖，返回排序陣列
 * @param {string} text - 用戶文本
 * @returns {Array} 意圖陣列，按置信度降序排列
 *   [{skillName, params, confidence}, ...]
 */
function detectMultiSkillIntent(text) {
  if (!text) {
    return [];
  }

  const intents = [];
  const lower = text.toLowerCase();
  const matcher = new KeywordMatcher();

  // Priority override: gmail/calendar operations with highest confidence
  const gmailActionWords = [
    "刪除郵件",
    "刪郵件",
    "清理郵件",
    "批量刪除",
    "刪除垃圾",
    "未讀郵件",
    "查看郵件",
    "寄信",
    "發郵件",
    "收件匣",
    "過濾",
    "過濾規則",
    "封鎖寄件者",
    "封鎖",
    "取消訂閱",
    "退訂",
    "delete email",
    "trash email",
    "inbox",
    "send email",
    "filter",
    "block sender",
    "unsubscribe",
  ];

  // Check gmail with high priority
  if (gmailActionWords.some((kw) => lower.includes(kw))) {
    const gws = SKILL_ROUTES.find((r) => r.name === "google_workspace");
    if (gws) {
      intents.push({
        skillName: gws.name,
        params: gws.buildParams(text),
        confidence: 1.0, // 高優先級
        priority: 10,
      });
    }
  }

  // Scan all routes with KeywordMatcher confidence scoring
  for (const route of SKILL_ROUTES) {
    if (route.name === "google_workspace" && intents.length > 0) {
      continue; // 已處理
    }

    // 計算該 route 的置信度
    const match = matcher.match(text, route.keywords, "auto");
    if (match.matched) {
      intents.push({
        skillName: route.name,
        params: route.buildParams(text),
        confidence: match.confidence,
        priority: route.priority || 5, // 預設優先級
      });
    }
  }

  // 按優先級和置信度排序
  intents.sort((a, b) => {
    if (b.priority !== a.priority) {
      return b.priority - a.priority;
    }
    return b.confidence - a.confidence;
  });

  return intents;
}

/**
 * 向後相容的單意圖檢測（返回最高置信度意圖）
 * @param {string} text - 用戶文本
 * @returns {Object|null} 單個意圖或 null
 */
function detectSkillIntent(text) {
  const intents = detectMultiSkillIntent(text);
  return intents.length > 0 ? intents[0] : null;
}

// ─── CLI Tool Detection ───────────────────────────────────────

function detectCliIntent(text) {
  if (!text) {
    return null;
  }
  const lower = text.toLowerCase();

  for (const route of CLI_ROUTES) {
    if (route.keywords.some((kw) => lower.includes(kw))) {
      const cmd = route.buildCmd(text);
      if (!cmd && route.noUrlMsg) {
        return { cliName: route.name, error: route.noUrlMsg };
      }
      if (cmd) {
        return { cliName: route.name, cmd };
      }
    }
  }
  return null;
}

// ─── System Monitor Commands (Telegram) ─────────────────────────

function detectSystemIntent(userText) {
  const lower = userText.toLowerCase();
  const patterns = [
    {
      type: "system_status",
      match: [
        "系統狀態",
        "system status",
        "/status",
        "健康檢查",
        "health check",
        "proxy狀態",
        "代理狀態",
      ],
    },
    {
      type: "agent_list",
      match: ["agent列表", "agents列表", "代理列表", "查看agent", "list agents"],
    },
    {
      type: "failover_status",
      match: ["failover", "容災", "容災狀態", "模型狀態", "model status"],
    },
    { type: "intent_stats", match: ["intent統計", "intent stats", "分類統計", "意圖統計"] },
    { type: "websearch_stats", match: ["搜尋統計", "websearch stats", "search stats", "搜索統計"] },
    { type: "full_dashboard", match: ["/dashboard", "儀表板", "總覽", "overview", "系統總覽"] },
  ];
  for (const p of patterns) {
    if (p.match.some((kw) => lower.includes(kw))) {
      return { type: p.type };
    }
  }
  return null;
}

function localGet(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://localhost:3457${urlPath}`, { timeout: 5000 }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error("Parse error"));
        }
      });
    });
    req.on("error", (e) => reject(e));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

async function handleSystemCommand(type) {
  try {
    switch (type) {
      case "system_status": {
        const h = await localGet("/health");
        const m = await localGet("/metrics");
        return [
          `[系統狀態]`,
          `Proxy: ${h.status} (v${h.version})`,
          `Uptime: ${h.uptime_human}`,
          `Model: ${h.model}`,
          `Requests: ${m.requests} (errors: ${m.errors})`,
          `Ollama: ${m.ollamaRouted} routed, ${m.ollamaFallback} fallback`,
          `Distribution: dev ${m.distribution.dev_pct}, skill ${m.distribution.skill_pct}, cli ${m.distribution.cli_pct}`,
        ].join("\n");
      }
      case "agent_list": {
        const d = await localGet("/api/agents/list");
        const agents = d.agents || [];
        const lines = ["[Agent 列表]"];
        for (const a of agents) {
          lines.push(`- ${a.name} (${a.model}, ${a.cost_tier})`);
        }
        return lines.join("\n");
      }
      case "failover_status": {
        const f = await localGet("/metrics/failover");
        return [
          `[模型容災]`,
          `Active: ${f.activeModel}`,
          `Failover: ${f.isFailover ? "YES" : "No"}`,
          f.failoverDuration_sec ? `Duration: ${f.failoverDuration_sec}s` : "",
        ]
          .filter(Boolean)
          .join("\n");
      }
      case "intent_stats": {
        const s = await localGet("/api/intent/stats");
        return [
          `[Intent 統計]`,
          `Total: ${s.classification.total_calls}`,
          `Ollama: ${s.classification.ollama_calls}, Fallback: ${s.classification.fallback_calls}`,
          `Cache: ${s.cache.hit_rate} hit rate (${s.cache.in_memory} in memory)`,
          `Avg latency: ${s.classification.avg_latency_ms}ms`,
        ].join("\n");
      }
      case "websearch_stats": {
        const w = await localGet("/api/websearch/stats");
        return [
          `[WebSearch 統計]`,
          `API calls: ${w.api.calls} (errors: ${w.api.errors})`,
          `Cache: ${w.cache.hit_rate} hit rate`,
          `Quota: ${w.quota.monthly_usage}/${w.quota.monthly_limit} (${w.quota.usage_percent})`,
        ].join("\n");
      }
      case "full_dashboard": {
        const [h, m, f, a, i, w] = await Promise.all([
          localGet("/health").catch(() => null),
          localGet("/metrics").catch(() => null),
          localGet("/metrics/failover").catch(() => null),
          localGet("/api/agents/list").catch(() => null),
          localGet("/api/intent/stats").catch(() => null),
          localGet("/api/websearch/stats").catch(() => null),
        ]);
        const lines = ["[OpenClaw Dashboard]", ""];
        if (h) {
          lines.push(`Proxy: ${h.status} v${h.version} (${h.uptime_human})`);
        }
        if (m) {
          lines.push(`Requests: ${m.requests} | Errors: ${m.errors} | Ollama: ${m.ollamaRouted}`);
        }
        if (f) {
          lines.push(`Model: ${f.activeModel} ${f.isFailover ? "(FAILOVER)" : ""}`);
        }
        if (a) {
          lines.push(`Agents: ${a.agents.length} configured`);
        }
        if (i) {
          lines.push(`Intent: ${i.classification.total_calls} calls, cache ${i.cache.hit_rate}`);
        }
        if (w) {
          lines.push(`Search: ${w.quota.monthly_usage}/${w.quota.monthly_limit} quota used`);
        }
        return lines.join("\n");
      }
      default:
        return "[系統] 未知指令";
    }
  } catch (e) {
    return `[系統] 查詢失敗: ${e.message}`;
  }
}

// ─── CLI Command Executor ─────────────────────────────────────

function runCliCommand(cmd) {
  // P1.11: Circuit breaker check
  if (circuitBreaker.isCircuitOpen("cli")) {
    return Promise.reject(new Error("[CIRCUIT OPEN] CLI tools temporarily disabled"));
  }

  return new Promise((resolve, reject) => {
    const [bin, ...args] = cmd;
    const needsRepo = bin === "gh" && !args.includes("-R");
    const cwd = needsRepo
      ? "/Users/rexmacmini/Project/active_projects/taiwan-stock-mvp"
      : process.env.HOME || "/Users/rexmacmini";
    execFile(
      bin,
      args,
      {
        cwd,
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" },
      },
      (err, stdout, stderr) => {
        if (err) {
          circuitBreaker.recordFailure("cli");
          reject(new Error(stderr || err.message));
        } else {
          circuitBreaker.recordSuccess("cli");
          resolve(stdout.trim());
        }
      },
    );
  });
}

// ─── Generic Skill API Caller ──────────────────────────────────

function callSkill(skillName, params) {
  // P1.11: Circuit breaker check
  if (circuitBreaker.isCircuitOpen("skill_api")) {
    return Promise.reject(new Error("[CIRCUIT OPEN] Skill API temporarily unavailable"));
  }

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      skill_name: skillName,
      params,
    });

    const opts = {
      hostname: "localhost",
      port: SKILL_API_PORT,
      path: `/api/v1/skills/${skillName}/execute`,
      method: method || "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 15000,
    };

    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          circuitBreaker.recordSuccess("skill_api");
          resolve(JSON.parse(data));
        } catch (e) {
          circuitBreaker.recordFailure("skill_api");
          reject(new Error(`Parse error: ${e.message}`));
        }
      });
    });
    req.on("error", (e) => {
      circuitBreaker.recordFailure("skill_api");
      reject(new Error(`Skill API unreachable: ${e.message}`));
    });
    req.on("timeout", () => {
      circuitBreaker.recordFailure("skill_api");
      req.destroy();
      reject(new Error("Skill timeout (15s)"));
    });
    if (method !== "GET") {
      req.write(body);
    }
    req.end();
  });
}

// ─── Format Skill Results ──────────────────────────────────────

function formatSkillResult(skillName, result) {
  try {
    const content = result?.result?.content || result?.content || "";
    if (typeof content === "string" && content.length > 0) {
      return `[${skillName} 結果]\n${content}`;
    }
    if (result?.result?.data && Array.isArray(result.result.data)) {
      const items = result.result.data.map((r, i) => {
        const parts = [];
        if (r.title) {
          parts.push(r.title);
        }
        if (r.url) {
          parts.push(r.url);
        }
        if (r.snippet || r.description) {
          parts.push(r.snippet || r.description);
        }
        return `${i + 1}. ${parts.join("\n   ")}`;
      });
      return `[${skillName} 結果]\n${items.join("\n\n")}`;
    }
    if (result?.result?.status || result?.result?.metrics) {
      return `[${skillName} 結果]\n${JSON.stringify(result.result, null, 2).slice(0, 2000)}`;
    }
    const str = JSON.stringify(result, null, 2);
    return `[${skillName} 結果]\n${str.slice(0, 2000)}`;
  } catch (e) {
    return `[${skillName} 錯誤] ${e.message}`;
  }
}

// ─── Gmail Batch Delete Handler ───────────────────────────────

async function handleGmailBatchDelete(reqId, userText, wantsStream, res) {
  // Parse sender filters from natural language
  const lower = userText.toLowerCase();
  const senderFilters = [];

  // Common spam/promo senders detection
  const knownFilters = [
    { kw: ["104", "人力銀行", "104人力"], query: "from:104.com.tw" },
    { kw: ["tailscale"], query: "from:tailscale.com" },
    { kw: ["razer"], query: "from:razer.com" },
    { kw: ["google alerts", "google 快訊"], query: "from:googlealerts-noreply@google.com" },
    { kw: ["嘖嘖", "zeczec"], query: "from:zeczec.com" },
    { kw: ["nintendo", "任天堂"], query: "from:nintendo" },
    { kw: ["facebook", "fb"], query: "from:facebookmail.com" },
    { kw: ["pubu"], query: "from:pubu.com.tw" },
    { kw: ["元大"], query: "from:yuanta" },
    { kw: ["github"], query: "from:github.com" },
    { kw: ["促銷", "promotions", "行銷"], query: "category:promotions" },
    { kw: ["垃圾", "spam"], query: "is:unread category:promotions" },
  ];

  for (const f of knownFilters) {
    if (f.kw.some((k) => lower.includes(k))) {
      senderFilters.push(f.query);
    }
  }

  // If no specific filter detected, default to promotions
  if (senderFilters.length === 0) {
    senderFilters.push("is:unread category:promotions");
  }

  let totalDeleted = 0;
  const deletedSummary = [];

  for (const filter of senderFilters) {
    try {
      // Step 1: Search
      const searchResult = await callSkill("google_workspace", {
        mode: "gmail.list",
        query: filter,
        max_results: 50,
      });

      const content = searchResult?.content
        ? JSON.parse(searchResult.content)
        : searchResult?.result?.content
          ? JSON.parse(searchResult.result.content)
          : null;
      if (!content || !content.messages || content.messages.length === 0) {
        continue;
      }

      // Step 2: Delete each message
      let count = 0;
      for (const msg of content.messages) {
        try {
          await callSkill("google_workspace", {
            mode: "gmail.delete",
            message_id: msg.id,
          });
          count++;
        } catch (e) {
          console.error(`[wrapper] #${reqId} gmail delete error: ${e.message}`);
        }
      }

      totalDeleted += count;
      const senderName = content.messages[0]?.from?.split("<")[0]?.trim() || filter;
      deletedSummary.push(`- ${senderName}: ${count} 封已移至垃圾桶`);
      console.log(
        `[wrapper] #${reqId} gmail batch delete: ${filter} → ${count}/${content.messages.length} deleted`,
      );
    } catch (e) {
      console.error(`[wrapper] #${reqId} gmail batch search error for ${filter}: ${e.message}`);
    }
  }

  const response =
    totalDeleted > 0
      ? "已批量清理 " +
        totalDeleted +
        " 封郵件（移至垃圾桶，30 天內可還原）：\n\n" +
        deletedSummary.join("\n")
      : "未找到符合條件的郵件可刪除。";

  return sendDirectResponse(reqId, response, wantsStream, res);
}

// ─── Dev Mode Detection (v9: Smart Intent) ───────────────────────

// v10.3: Simplified detectDevIntent — unified logic

function resolveHome(dir) {
  const home = process.env.HOME || "/Users/rexmacmini";
  return dir.replace(/^~/, home);
}

function isAllowedPath(dir) {
  const resolved = resolveHome(dir);
  return ALLOWED_DEV_PATHS.some((allowed) => resolved.startsWith(allowed));
}

function projectNameFromDir(dir) {
  const parts = dir.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || "misc";
}

function logDevWork(project, prompt, durationSec, success) {
  const desc = prompt.slice(0, 120).replace(/"/g, '\\"');
  const status = success ? "" : " [failed]";
  const cmd = `${process.env.HOME || "/Users/rexmacmini"}/.claude/scripts/wt-log.sh "${project}" "code" "dev-mode: ${desc}${status}" ${Math.max(1, Math.round(durationSec / 60))} "auto" null null null 5000`;
  execFile("/bin/bash", ["-c", cmd], { timeout: 5000 }, (err) => {
    if (err) {
      console.error(`[wrapper] wt-log error: ${err.message}`);
    } else {
      console.log(`[wrapper] wt-log: ${project}/code dev-mode recorded`);
    }
  });
}

// ─── Unified Error Formatter (v10.3) ─────────────────────────────

function formatDevError(category, message, hint) {
  let out = `[${category}] ${message}`;
  if (hint) {
    out += `\n提示: ${hint}`;
  }
  return out;
}

// ─── mac-agentd Integration ───────────────────────────────────

const AGENTD_HOST = "127.0.0.1";
const AGENTD_PORT = 7777;
const AGENTD_TIMEOUT = 30000; // 30s per request
let AGENTD_TOKEN = null;

// Load agentd token
try {
  AGENTD_TOKEN = fs
    .readFileSync(path.join(process.env.HOME || "/Users/rexmacmini", ".agentd-token"), "utf8")
    .trim();
  console.log("[wrapper] agentd token loaded");
} catch (e) {
  console.error("[wrapper] WARNING: cannot read agentd token:", e.message);
}

// ─── AGENTD Dev Tools (v11 Tool Calling) ──────────────────────────────

const AGENTD_TOOLS = [
  {
    type: "function",
    function: {
      name: "git_log",
      description: "查看 Git 提交歷史",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "專案名稱或路徑（如 openclaw, taiwan-stock）" },
        },
        required: ["project"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_status",
      description: "查看 Git 工作區狀態",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "專案名稱或路徑" },
        },
        required: ["project"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_diff",
      description: "查看程式碼變更（未提交的 diff）",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "專案名稱或路徑" },
        },
        required: ["project"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_add",
      description: "暫存檔案 (git add)",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "專案名稱或路徑" },
          files: { type: "array", items: { type: "string" }, description: "檔案列表（預設 .）" },
        },
        required: ["project"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_commit",
      description: "提交改動 (git commit)",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "專案名稱或路徑" },
          message: { type: "string", description: "Commit 訊息" },
        },
        required: ["project", "message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_push",
      description: "推送 commit 到遠端 (git push)。用於將已提交的改動推送到 GitHub。",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "專案名稱或路徑" },
          remote: { type: "string", description: "遠端名稱（如 origin, fork），預設 origin" },
          branch: { type: "string", description: "分支名稱，預設 main" },
        },
        required: ["project"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "讀取檔案內容",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "檔案的完整路徑" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "寫入檔案",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "檔案的完整路徑" },
          content: { type: "string", description: "檔案內容" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "列出目錄內容",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "專案名稱或路徑" },
        },
        required: ["project"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "docker_ps",
      description: "列出所有 Docker 容器",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "docker_restart",
      description: "重啟 Docker 容器",
      parameters: {
        type: "object",
        properties: {
          container: { type: "string", description: "容器名稱（如 openclaw, postgres）" },
        },
        required: ["container"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "docker_logs",
      description: "查看容器日誌",
      parameters: {
        type: "object",
        properties: {
          container: { type: "string", description: "容器名稱" },
          tail: { type: "integer", description: "最後 N 行（預設 50）", default: 50 },
        },
        required: ["container"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_tests",
      description: "執行專案測試",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "專案名稱或路徑" },
        },
        required: ["project"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "system_info",
      description: "查看系統資訊",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "privileged_task",
      description:
        "執行需要系統特權的任務（git push、SSH、deploy 等）。會透過 session-bridge 啟動一個有完整權限的 Claude session 來執行。只在其他工具無法完成時使用。",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: '要執行的任務描述（如 "git push origin main in openclaw"）',
          },
          project: { type: "string", description: "專案名稱（如 openclaw, taiwan-stock）" },
        },
        required: ["task"],
      },
    },
  },
];

// P1.3: Runtime Tool Injection — extract tool names and descriptions from AGENTD_TOOLS
function buildAvailableToolsList() {
  if (!AGENTD_TOOLS || !Array.isArray(AGENTD_TOOLS)) {
    return "（無可用工具）";
  }
  return AGENTD_TOOLS.map((t) => {
    if (t.type === "function" && t.function) {
      const name = t.function.name;
      const desc = t.function.description || name;
      return `- ${name}: ${desc}`;
    }
    return null;
  })
    .filter((t) => t)
    .join("\n");
}

const AVAILABLE_TOOLS_LIST = buildAvailableToolsList();

// ─── Dev Tool Loop Helper Functions ───────────────────────────────────

function shouldInjectDevTools(userText) {
  if (!userText) {
    return false;
  }
  const lower = userText.toLowerCase();

  // Has project keyword → true
  const hasProjectKw = PROJECT_ROUTES.some((r) => r.keywords.some((kw) => lower.includes(kw)));
  if (hasProjectKw) {
    return true;
  }

  // Has lastDevProject → true (follow-up)
  if (lastDevProject) {
    return true;
  }

  // Has docker/system keyword → true
  const devKeywords = [
    "docker",
    "容器",
    "log",
    "git",
    "commit",
    "push",
    "test",
    "部署",
    "deploy",
    "檔案",
    "讀取",
    "列出",
    "restart",
    "status",
    "diff",
    "ssh",
  ];
  const hasDevKw = devKeywords.some((kw) => lower.includes(kw));
  if (hasDevKw && DEV_ACTION_WORDS.some((w) => lower.includes(w))) {
    return true;
  }

  return false;
}

// Deterministic intent mapping — LLM outputs intent, wrapper maps to endpoint
const INTENT_MAP = {
  show_git_log: { endpoint: "/git/log", paramsFn: (target) => ({ repo: resolveProject(target) }) },
  show_git_status: {
    endpoint: "/git/status",
    paramsFn: (target) => ({ repo: resolveProject(target) }),
  },
  show_git_diff: {
    endpoint: "/git/diff",
    paramsFn: (target) => ({ repo: resolveProject(target) }),
  },
  read_file: { endpoint: "/fs/read", paramsFn: (target, extra) => ({ path: extra.path }) },
  write_file: {
    endpoint: "/fs/write",
    paramsFn: (target, extra) => ({ path: extra.path, content: extra.content }),
  },
  list_files: { endpoint: "/fs/list", paramsFn: (target) => ({ path: resolveProject(target) }) },
  restart_container: {
    endpoint: "/docker/restart",
    paramsFn: (target) => ({ container: resolveContainer(target) }),
  },
  show_logs: {
    endpoint: "/docker/logs",
    paramsFn: (target) => ({ container: resolveContainer(target), tail: 50 }),
  },
  run_tests: {
    endpoint: "/project/test",
    paramsFn: (target) => ({ repo: resolveProject(target) }),
  },
  show_containers: { endpoint: "/docker/ps", paramsFn: () => ({}) },
  system_info: { endpoint: "/system/info", paramsFn: () => ({}), method: "GET" },
  git_add: {
    endpoint: "/git/add",
    paramsFn: (target, extra) => ({ repo: resolveProject(target), files: extra.files || ["."] }),
  },
  git_commit: {
    endpoint: "_commit_flow",
    paramsFn: (target, extra) => ({
      repo: resolveProject(target),
      message: extra.message || "chore: commit pending changes via OpenClaw",
    }),
    multi: true,
  },
  project_overview: {
    endpoint: "_multi",
    paramsFn: (target) => ({ repo: resolveProject(target) }),
    multi: true,
  },
  docker_overview: { endpoint: "_multi_docker", paramsFn: () => ({}), multi: true },
  test_and_analyze: {
    endpoint: "_multi_test",
    paramsFn: (target) => ({ repo: resolveProject(target) }),
    multi: true,
  },
};

// Container alias mapping
// v10.3: Extended aliases for all containers
const CONTAINER_ALIASES = {
  openclaw: "openclaw-agent",
  "openclaw-bot": "openclaw-agent",
  bot: "openclaw-agent",
  stock: "taiwan-stock-backend",
  "taiwan-stock": "taiwan-stock-backend",
  grafana: "taiwan-stock-grafana",
  prometheus: "taiwan-stock-prometheus",
  pg: "postgres",
  db: "postgres",
  database: "postgres",
  pai: "personal-ai-gateway",
  "personal-ai": "personal-ai-gateway",
  "rex-ai": "rex-ai",
  dashboard: "rex-ai",
  redis: "taiwan-stock-redis",
  "stock-pg": "taiwan-stock-postgres",
  "stock-redis": "taiwan-stock-redis",
};

function resolveContainer(name) {
  if (!name) {
    return name;
  }
  return CONTAINER_ALIASES[name.toLowerCase()] || name;
}

function resolveProject(target) {
  if (!target) {
    return "/Users/rexmacmini/openclaw";
  }
  const lower = target.toLowerCase();
  for (const route of PROJECT_ROUTES) {
    if (route.keywords.some((kw) => lower.includes(kw))) {
      return resolveHome(route.dir);
    }
  }
  // If target looks like a path, use it directly
  if (target.startsWith("/") || target.startsWith("~")) {
    return resolveHome(target);
  }
  return "/Users/rexmacmini/openclaw";
}

function callAgentd(endpoint, params, timeout, method) {
  return new Promise((resolve, reject) => {
    if (!AGENTD_TOKEN) {
      reject(new Error("agentd token not loaded"));
      return;
    }
    const httpMethod = method || "POST";
    const body = httpMethod !== "GET" ? JSON.stringify(params) : "";
    const headers = {
      Authorization: `Bearer ${AGENTD_TOKEN}`,
    };
    if (httpMethod !== "GET") {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(body);
    }
    const req = http.request(
      {
        hostname: AGENTD_HOST,
        port: AGENTD_PORT,
        path: endpoint,
        method: httpMethod,
        headers,
        timeout: timeout || AGENTD_TIMEOUT,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode >= 400) {
              reject(new Error(parsed.error || `agentd returned ${res.statusCode}`));
            } else {
              resolve(parsed);
            }
          } catch {
            reject(new Error(`agentd invalid response: ${data.slice(0, 200)}`));
          }
        });
      },
    );
    req.on("error", (e) => reject(new Error(`agentd unreachable: ${e.message}`)));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("agentd timeout"));
    });
    if (httpMethod !== "GET") {
      req.write(body);
    }
    req.end();
  });
}

// ─── Session Bridge Integration ───────────────────────────────────────

const SESSION_BRIDGE_PORT = 7788;
const SESSION_BRIDGE_TIMEOUT = 180000; // 3 min max

// ─── Session Gate — prevent spawn storm (max 1 concurrent session) ────
let _activeSessions = 0;
const MAX_CONCURRENT_SESSIONS = 1;
const _sessionQueue = [];

// ─── Anti-Thrashing Controls ────────────────────────────────────────
let _lastSessionSpawn = 0;
const SESSION_COOLDOWN_MS = 20000; // 20s between session spawns
const SWITCH_THRESHOLD = 1.35; // hysteresis: 35% cost difference needed to switch
const FAILURE_PENALTY = 1.8; // multiply cost by this on recent failure
const _lastRouteByIntent = {}; // track last route per intent for hysteresis

// ─── Self-Learning Router — adaptive routing based on execution history ────
const ROUTING_STATS_PATH = path.join(
  process.env.OPENCLAW_CONFIG_DIR || "/Users/rexmacmini/.openclaw",
  "routing-stats.json",
);
const MIN_SAMPLES_FOR_LEARNING = 5; // fallback to rule-based below this

function loadRoutingStats() {
  try {
    if (fs.existsSync(ROUTING_STATS_PATH)) {
      return JSON.parse(fs.readFileSync(ROUTING_STATS_PATH, "utf8"));
    }
  } catch (e) {
    console.error("[wrapper] Failed to load routing stats:", e.message);
  }
  return {};
}

function saveRoutingStats(stats) {
  try {
    fs.writeFileSync(ROUTING_STATS_PATH, JSON.stringify(stats, null, 2), "utf8");
  } catch (e) {
    console.error("[wrapper] Failed to save routing stats:", e.message);
  }
}

// Intent fingerprint — stable, explainable, near-zero cost
function extractIntent(text) {
  const lower = text.toLowerCase();
  if (/docker|container|image|volume/.test(lower)) {
    return "docker";
  }
  if (/git|commit|diff|branch|push|pull|merge/.test(lower)) {
    return "git";
  }
  if (/endpoint|api|feature|module|component/.test(lower)) {
    return "implementation";
  }
  if (/memory|disk|process|cpu|系統|system_info/.test(lower)) {
    return "system";
  }
  if (/deploy|部署|上線|release/.test(lower)) {
    return "deploy";
  }
  if (/cleanup|清理|刪除|remove|prune/.test(lower)) {
    return "cleanup";
  }
  if (/config|設定|configure/.test(lower)) {
    return "config";
  }
  if (/test|測試|spec/.test(lower)) {
    return "test";
  }
  if (/file|檔案|read|write|list|目錄|directory|backup|備份/.test(lower)) {
    return "file_ops";
  }
  if (/install|安裝|update|更新|upgrade/.test(lower)) {
    return "install";
  }
  if (/restart|重啟|start|stop|啟動|停止/.test(lower)) {
    return "service_ops";
  }
  if (/refactor|重構|migrate|遷移|整合|integrate/.test(lower)) {
    return "refactor";
  }
  if (/design|設計|architecture|架構/.test(lower)) {
    return "design";
  }
  return "general";
}

// Expected cost = latency / success_rate (lower is better)
function expectedCost(stats) {
  if (!stats || stats.success + stats.fail === 0) {
    return Infinity;
  }
  const successRate = stats.success / Math.max(1, stats.success + stats.fail);
  return stats.avg_latency / Math.max(successRate, 0.2);
}

// Decide routing based on historical performance
// Includes: hysteresis (anti-thrashing), failure penalty, cooldown enforcement
// Returns: { route: "dev_loop"|"session_bridge", reason: string }
function learningRoute(intent, ruleBasedDecision) {
  const allStats = loadRoutingStats();
  const intentStats = allStats[intent];

  // Safety guard: not enough data → fallback to rule-based
  if (!intentStats) {
    return { route: ruleBasedDecision, reason: "no_history" };
  }
  const devSamples = intentStats.dev_loop
    ? intentStats.dev_loop.success + intentStats.dev_loop.fail
    : 0;
  const sesSamples = intentStats.session_bridge
    ? intentStats.session_bridge.success + intentStats.session_bridge.fail
    : 0;

  if (devSamples < MIN_SAMPLES_FOR_LEARNING && sesSamples < MIN_SAMPLES_FOR_LEARNING) {
    return { route: ruleBasedDecision, reason: `low_samples(dev=${devSamples},ses=${sesSamples})` };
  }

  // Compute costs with failure penalty
  let devCost = expectedCost(intentStats.dev_loop);
  let sesCost = expectedCost(intentStats.session_bridge);

  // Apply failure penalty: if recent failure rate > 30%, increase cost
  if (intentStats.dev_loop && intentStats.dev_loop.fail > 0) {
    const devFailRate =
      intentStats.dev_loop.fail / (intentStats.dev_loop.success + intentStats.dev_loop.fail);
    if (devFailRate > 0.3) {
      devCost *= FAILURE_PENALTY;
    }
  }
  if (intentStats.session_bridge && intentStats.session_bridge.fail > 0) {
    const sesFailRate =
      intentStats.session_bridge.fail /
      (intentStats.session_bridge.success + intentStats.session_bridge.fail);
    if (sesFailRate > 0.3) {
      sesCost *= FAILURE_PENALTY;
    }
  }

  // Mode bias: coding mode reduces session cost (favors Claude), ops mode increases it
  const _lrMode = getActiveMode();
  if (_lrMode) {
    const _adj = getModeAdjustments(_lrMode);
    sesCost *= _adj.sessionCostMultiplier;
  }

  // Cooldown enforcement: if session was spawned recently, bias toward dev_loop
  const effectiveCooldown =
    (_lrMode && getModeAdjustments(_lrMode).cooldownOverride) || SESSION_COOLDOWN_MS;
  const timeSinceLastSession = Date.now() - _lastSessionSpawn;
  if (timeSinceLastSession < effectiveCooldown) {
    return {
      route: "dev_loop",
      reason: `cooldown(${Math.round((SESSION_COOLDOWN_MS - timeSinceLastSession) / 1000)}s remaining)`,
    };
  }

  // Hysteresis: require SWITCH_THRESHOLD cost ratio to change from last route
  const lastRoute = _lastRouteByIntent[intent];
  let route;
  if (lastRoute === "dev_loop" && sesCost < devCost / SWITCH_THRESHOLD) {
    route = "session_bridge";
  } else if (lastRoute === "session_bridge" && devCost < sesCost / SWITCH_THRESHOLD) {
    route = "dev_loop";
  } else if (lastRoute) {
    // Not enough difference — stay on current route (stability)
    route = lastRoute;
  } else {
    // No history — use cost comparison
    route = devCost <= sesCost ? "dev_loop" : "session_bridge";
  }

  _lastRouteByIntent[intent] = route;
  const switched = route !== ruleBasedDecision;
  return {
    route,
    reason: `${switched ? "learned" : "confirmed"}(dev=${devCost.toFixed(1)},ses=${sesCost.toFixed(1)},hysteresis=${SWITCH_THRESHOLD},last=${lastRoute || "none"})`,
  };
}

// Record execution outcome — called after task completes
function recordRoutingOutcome(intent, executor, success, latencyMs) {
  const allStats = loadRoutingStats();
  if (!allStats[intent]) {
    allStats[intent] = {};
  }
  if (!allStats[intent][executor]) {
    allStats[intent][executor] = { success: 0, fail: 0, avg_latency: 0, samples: 0 };
  }
  const s = allStats[intent][executor];
  s.samples = (s.samples || 0) + 1;
  if (success) {
    s.success++;
  } else {
    s.fail++;
  }
  // Exponential moving average for latency (alpha=0.3 for responsiveness)
  const alpha = 0.3;
  s.avg_latency = s.avg_latency === 0 ? latencyMs : s.avg_latency * (1 - alpha) + latencyMs * alpha;
  saveRoutingStats(allStats);
  console.log(
    `[wrapper] ROUTING_FEEDBACK: intent=${intent} executor=${executor} success=${success} latency=${latencyMs}ms avg=${s.avg_latency.toFixed(0)}ms samples=${s.samples}`,
  );
}

// ─── Intent Momentum — adaptive mode system with decay ────────────────
const MODE_DECAY = 0.85; // decay factor per task
const MODE_BOOST = 2; // boost for matching intent
const MODE_PENALTY = -0.5; // penalty for non-matching
const MODE_THRESHOLD = 3; // minimum score to activate mode

const _modeScores = {
  coding: 0, // implementation, refactor, design
  ops: 0, // docker, service_ops, deploy, cleanup
  debugging: 0, // git (diff/log), system, test
  research: 0, // general, config, file_ops, install
};

// Map intents to modes
const INTENT_TO_MODE = {
  implementation: "coding",
  refactor: "coding",
  design: "coding",
  docker: "ops",
  service_ops: "ops",
  deploy: "ops",
  cleanup: "ops",
  git: "debugging",
  system: "debugging",
  test: "debugging",
  general: "research",
  config: "research",
  file_ops: "research",
  install: "research",
};

function updateMomentum(intent) {
  const targetMode = INTENT_TO_MODE[intent] || "research";

  // Decay all scores
  for (const mode of Object.keys(_modeScores)) {
    _modeScores[mode] *= MODE_DECAY;
  }
  // Boost matching mode
  _modeScores[targetMode] += MODE_BOOST;
  // Small penalty to others (keeps modes competitive)
  for (const mode of Object.keys(_modeScores)) {
    if (mode !== targetMode) {
      _modeScores[mode] += MODE_PENALTY;
    }
    if (_modeScores[mode] < 0) {
      _modeScores[mode] = 0;
    }
  }
}

function getActiveMode() {
  let best = null;
  let bestScore = MODE_THRESHOLD; // must exceed threshold
  for (const [mode, score] of Object.entries(_modeScores)) {
    if (score > bestScore) {
      best = mode;
      bestScore = score;
    }
  }
  return best; // null = no dominant mode
}

// Mode effects on routing parameters (only touches control plane)
function getModeAdjustments(mode) {
  switch (mode) {
    case "coding":
      return { sessionCostMultiplier: 0.8, cooldownOverride: 5000, predictionThreshold: 0.45 };
    case "ops":
      return { sessionCostMultiplier: 1.5, cooldownOverride: null, predictionThreshold: 0.7 };
    case "debugging":
      return { sessionCostMultiplier: 1.0, cooldownOverride: null, predictionThreshold: 0.6 };
    case "research":
      return { sessionCostMultiplier: 1.2, cooldownOverride: null, predictionThreshold: 0.65 };
    default:
      return {
        sessionCostMultiplier: 1.0,
        cooldownOverride: null,
        predictionThreshold: PREDICTION_CONFIDENCE,
      };
  }
}

// ─── Control Plane Event Logging — append-only observability ──────────
const CP_EVENTS_PATH = path.join(
  process.env.OPENCLAW_CONFIG_DIR || "/Users/rexmacmini/.openclaw",
  "routing-events.jsonl",
);
const CP_MODE_HISTORY_PATH = path.join(
  process.env.OPENCLAW_CONFIG_DIR || "/Users/rexmacmini/.openclaw",
  "mode-history.jsonl",
);
const _predictionTracker = { hits: 0, misses: 0, total: 0, falseWarms: 0 };
const _routingEvents = []; // in-memory ring buffer (last 200)
const MAX_EVENTS = 200;

function recordRoutingEvent(event) {
  event.ts = Date.now();
  _routingEvents.push(event);
  if (_routingEvents.length > MAX_EVENTS) {
    _routingEvents.shift();
  }
  // Append to file (non-blocking)
  try {
    fs.appendFile(CP_EVENTS_PATH, JSON.stringify(event) + "\n", () => {});
  } catch {}
  updateDrift(event);
}

function recordModeSnapshot() {
  const snapshot = {
    ts: Date.now(),
    mode: getActiveMode(),
    scores: { ..._modeScores },
    lastIntent: _lastIntent,
  };
  try {
    fs.appendFile(CP_MODE_HISTORY_PATH, JSON.stringify(snapshot) + "\n", () => {});
  } catch {}
  return snapshot;
}

function trackPrediction(predicted, actual) {
  if (!predicted) {
    return;
  } // no prediction made
  _predictionTracker.total++;
  if (predicted === actual) {
    _predictionTracker.hits++;
  } else {
    _predictionTracker.misses++;
    if (predicted === "session_bridge" && actual === "dev_loop") {
      _predictionTracker.falseWarms++;
    }
  }
  recordFalseWarmDrift(predicted === "session_bridge" && actual === "dev_loop");
}

// ─── Drift Detection ──────────────────────────────────────────────
const DRIFT_ALPHA = 0.1;
const DRIFT_BASELINE_MIN = 30;

const _driftState = {
  baselinePredAcc: null,
  baselineLatency: null,
  baselineSessionRatio: null,
  baselineFalseWarm: null,
  samplesForBaseline: 0,
  currentPredAcc: null,
  currentLatency: null,
  currentSessionRatio: null,
  currentFalseWarm: null,
  recentModes: [],
  lastStatsUpdate: Date.now(),
  alerts: [],
};

function updateDrift(event) {
  const s = _driftState;
  s.samplesForBaseline++;
  s.lastStatsUpdate = Date.now();
  if (event.predicted) {
    const hit = event.predicted === event.executor ? 1 : 0;
    s.currentPredAcc =
      s.currentPredAcc === null ? hit : s.currentPredAcc * (1 - DRIFT_ALPHA) + hit * DRIFT_ALPHA;
  }
  const isSes = event.executor === "session_bridge" ? 1 : 0;
  s.currentSessionRatio =
    s.currentSessionRatio === null
      ? isSes
      : s.currentSessionRatio * (1 - DRIFT_ALPHA) + isSes * DRIFT_ALPHA;
  if (event.mode) {
    s.recentModes.push(event.mode);
    if (s.recentModes.length > 20) {
      s.recentModes.shift();
    }
  }
  if (s.samplesForBaseline === DRIFT_BASELINE_MIN) {
    s.baselinePredAcc = s.currentPredAcc;
    s.baselineSessionRatio = s.currentSessionRatio;
  }
  if (s.samplesForBaseline > DRIFT_BASELINE_MIN) {
    checkDriftAlerts();
  }
}

function recordLatencyDrift(latencyMs) {
  const s = _driftState;
  s.currentLatency =
    s.currentLatency === null
      ? latencyMs
      : s.currentLatency * (1 - DRIFT_ALPHA) + latencyMs * DRIFT_ALPHA;
  if (s.samplesForBaseline === DRIFT_BASELINE_MIN && s.baselineLatency === null) {
    s.baselineLatency = s.currentLatency;
  }
}

function recordFalseWarmDrift(isFalseWarm) {
  const s = _driftState;
  const v = isFalseWarm ? 1 : 0;
  s.currentFalseWarm =
    s.currentFalseWarm === null ? v : s.currentFalseWarm * (1 - DRIFT_ALPHA) + v * DRIFT_ALPHA;
  if (s.samplesForBaseline === DRIFT_BASELINE_MIN && s.baselineFalseWarm === null) {
    s.baselineFalseWarm = s.currentFalseWarm;
  }
}

function checkDriftAlerts() {
  const s = _driftState;
  const now = Date.now();
  const alerts = [];
  if (s.baselinePredAcc !== null && s.currentPredAcc !== null) {
    const drop = s.baselinePredAcc - s.currentPredAcc;
    if (drop > 0.15) {
      alerts.push({
        type: "pred_accuracy",
        severity: drop > 0.25 ? "critical" : "warning",
        msg: "預測準確率下降 " + (drop * 100).toFixed(0) + "%",
        baseline: s.baselinePredAcc,
        current: s.currentPredAcc,
      });
    }
  }
  if (s.baselineLatency !== null && s.currentLatency !== null) {
    const inc = (s.currentLatency - s.baselineLatency) / s.baselineLatency;
    if (inc > 0.3) {
      alerts.push({
        type: "latency",
        severity: inc > 0.5 ? "critical" : "warning",
        msg: "延遲上升 " + (inc * 100).toFixed(0) + "%",
        baseline: s.baselineLatency,
        current: s.currentLatency,
      });
    }
  }
  if (s.recentModes.length >= 10) {
    let sw = 0;
    for (let i = 1; i < s.recentModes.length; i++) {
      if (s.recentModes[i] !== s.recentModes[i - 1]) {
        sw++;
      }
    }
    const rate = sw / (s.recentModes.length - 1);
    if (rate > 0.25) {
      alerts.push({
        type: "mode_oscillation",
        severity: rate > 0.4 ? "critical" : "warning",
        msg: "模式震盪率 " + (rate * 100).toFixed(0) + "%",
        rate,
      });
    }
  }
  if (s.baselineSessionRatio !== null && s.currentSessionRatio !== null) {
    const shift = Math.abs(s.currentSessionRatio - s.baselineSessionRatio);
    if (shift > 0.2) {
      alerts.push({
        type: "executor_imbalance",
        severity: shift > 0.35 ? "critical" : "warning",
        msg: "執行器比例偏移 " + (shift * 100).toFixed(0) + "%",
        baseline: s.baselineSessionRatio,
        current: s.currentSessionRatio,
      });
    }
  }
  if (now - s.lastStatsUpdate > 2 * 3600 * 1000) {
    alerts.push({
      type: "staleness",
      severity: "warning",
      msg: "學習數據已 " + ((now - s.lastStatsUpdate) / 3600000).toFixed(1) + "h 未更新",
    });
  }
  if (s.currentFalseWarm !== null && s.currentFalseWarm > 0.3) {
    alerts.push({
      type: "false_warm",
      severity: s.currentFalseWarm > 0.45 ? "critical" : "warning",
      msg: "誤預熱率 " + (s.currentFalseWarm * 100).toFixed(0) + "%",
      rate: s.currentFalseWarm,
    });
  }
  for (const a of alerts) {
    a.ts = now;
    const idx = s.alerts.findIndex((x) => x.type === a.type);
    if (idx !== -1) {
      s.alerts[idx] = a;
    } else {
      s.alerts.push(a);
    }
    if (s.alerts.length > 50) {
      s.alerts.shift();
    }
  }
  const activeTypes = new Set(alerts.map((a) => a.type));
  s.alerts = s.alerts.filter((a) => activeTypes.has(a.type) || now - a.ts < 600000);
}

function getDriftAnalysis() {
  const s = _driftState;
  const msr =
    s.recentModes.length >= 2
      ? (() => {
          let sw = 0;
          for (let i = 1; i < s.recentModes.length; i++) {
            if (s.recentModes[i] !== s.recentModes[i - 1]) {
              sw++;
            }
          }
          return ((sw / (s.recentModes.length - 1)) * 100).toFixed(1) + "%";
        })()
      : null;
  return {
    status: s.alerts.some((a) => a.severity === "critical")
      ? "critical"
      : s.alerts.length > 0
        ? "warning"
        : "healthy",
    samples: s.samplesForBaseline,
    baselineEstablished: s.samplesForBaseline >= DRIFT_BASELINE_MIN,
    baselines: {
      predAccuracy: s.baselinePredAcc !== null ? (s.baselinePredAcc * 100).toFixed(1) + "%" : null,
      latency: s.baselineLatency !== null ? Math.round(s.baselineLatency) + "ms" : null,
      sessionRatio:
        s.baselineSessionRatio !== null ? (s.baselineSessionRatio * 100).toFixed(1) + "%" : null,
      falseWarmRate:
        s.baselineFalseWarm !== null ? (s.baselineFalseWarm * 100).toFixed(1) + "%" : null,
    },
    current: {
      predAccuracy: s.currentPredAcc !== null ? (s.currentPredAcc * 100).toFixed(1) + "%" : null,
      latency: s.currentLatency !== null ? Math.round(s.currentLatency) + "ms" : null,
      sessionRatio:
        s.currentSessionRatio !== null ? (s.currentSessionRatio * 100).toFixed(1) + "%" : null,
      falseWarmRate:
        s.currentFalseWarm !== null ? (s.currentFalseWarm * 100).toFixed(1) + "%" : null,
      modeSwitchRate: msr,
    },
    alerts: s.alerts,
    lastUpdate: s.lastStatsUpdate,
  };
}

// ─── Predictive Routing — task transition tracking + executor prediction ───
const TRANSITIONS_PATH = path.join(
  process.env.OPENCLAW_CONFIG_DIR || "/Users/rexmacmini/.openclaw",
  "task-transitions.json",
);
const PREDICTION_CONFIDENCE = 0.6; // minimum probability to act on prediction
let _lastIntent = null;

function loadTransitions() {
  try {
    if (fs.existsSync(TRANSITIONS_PATH)) {
      return JSON.parse(fs.readFileSync(TRANSITIONS_PATH, "utf8"));
    }
  } catch (e) {
    console.error("[wrapper] Failed to load transitions:", e.message);
  }
  return {};
}

function saveTransitions(data) {
  try {
    fs.writeFileSync(TRANSITIONS_PATH, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    console.error("[wrapper] Failed to save transitions:", e.message);
  }
}

// Record intent-to-executor transition (not intent-to-intent)
function recordTransition(intent, executor) {
  if (!intent) {
    return;
  }
  const data = loadTransitions();
  if (!data[intent]) {
    data[intent] = { dev_loop: 0, session_bridge: 0 };
  }
  data[intent][executor] = (data[intent][executor] || 0) + 1;
  saveTransitions(data);
}

// Predict which executor the next task for this intent will need
// Returns: "session_bridge" | null (null = no prediction / not confident enough)
function predictExecutor(intent) {
  const data = loadTransitions();
  const stats = data[intent];
  if (!stats) {
    return null;
  }

  const total = (stats.dev_loop || 0) + (stats.session_bridge || 0);
  if (total < MIN_SAMPLES_FOR_LEARNING) {
    return null;
  }

  const probSession = (stats.session_bridge || 0) / total;
  if (probSession > PREDICTION_CONFIDENCE) {
    return "session_bridge";
  }
  return null;
}

// Soft pre-warm: notify session bridge to prepare (non-blocking)
function softPreWarm(project) {
  // Fire-and-forget: just ping session bridge health to keep connection warm
  // In future: can send prepare signal with project context
  callSessionBridgeAPI("GET", "/health", null).catch(() => {});
  console.log(
    "[wrapper] PREDICTIVE_PREWARM: pinged session-bridge" + (project ? " for " + project : ""),
  );
}

function callSessionBridgeAPI(method, path, body) {
  return new Promise((resolve, reject) => {
    const postBody = body ? JSON.stringify(body) : "";
    const opts = {
      hostname: "127.0.0.1",
      port: SESSION_BRIDGE_PORT,
      path,
      method,
      headers: { "Content-Type": "application/json" },
      timeout: SESSION_BRIDGE_TIMEOUT,
    };
    if (method !== "GET") {
      opts.headers["Content-Length"] = Buffer.byteLength(postBody);
    }
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          resolve({ ...JSON.parse(data), _status: res.statusCode });
        } catch {
          reject(new Error("session-bridge invalid response"));
        }
      });
    });
    req.on("error", (e) => reject(new Error(`session-bridge unreachable: ${e.message}`)));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("session-bridge timeout"));
    });
    if (method !== "GET") {
      req.write(postBody);
    }
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Bounded Autonomy v1 — Policy Interceptor + Safety Guards
// ---------------------------------------------------------------------------

function unwrapCommand(cmd) {
  let prev,
    current = cmd;
  do {
    prev = current;
    const m = current.match(/(?:bash|sh)\s+-c\s+["'](.+)["']/);
    if (m) {
      current = m[1];
    }
  } while (current !== prev);
  return current;
}

function classifyCommand(cmd) {
  const normalized = unwrapCommand(cmd);
  if (
    /rm\s+-rf|rm\s+-r\s+\/|docker\s+(?:system\s+)?prune|drop\s+table|truncate/i.test(normalized)
  ) {
    return "destructive";
  }
  if (/git\s+push\s+--force|git\s+reset\s+--hard|chmod\s+777/i.test(normalized)) {
    return "destructive";
  }
  if (/docker\s+restart|docker\s+stop|launchctl|kill\s+-9|systemctl/i.test(normalized)) {
    return "operational";
  }
  return "safe";
}

function injectVerificationStep(task, classification) {
  if (classification === "destructive") {
    return (
      `[VERIFICATION REQUIRED]\n` +
      `Classification: ${classification}. Before executing:\n` +
      `(1) verify exact target (2) confirm recoverability (3) prefer reversible alternative.\n\n` +
      task
    );
  }
  return task;
}

const executionWindow = new Map();

function runawayGuard(task, classification) {
  const now = Date.now();
  // Key by classification + task hash to avoid cross-service throttling
  const key = `${classification}:${task.slice(0, 80).replace(/\s+/g, "_")}`;
  const history = executionWindow.get(key) || [];
  const recent = history.filter((t) => now - t < 60000);

  if (recent.length >= 5) {
    throw new Error(`[Runaway Prevention] ${key}: ${recent.length} ops in 60s. Halted.`);
  }
  recent.push(now);
  executionWindow.set(key, recent);
}

const authorityDirective = [
  "[Operational Authority]",
  "You have pre-authorized operational control within system boundaries.",
  "Default mode: execute without confirmation.",
  "Before destructive operations: verify target, ensure recoverability, prefer reversible actions.",
  "Report results after execution, not intentions before.",
  "",
].join("\n");

async function callSessionBridge(task, project) {
  const classification = classifyCommand(task);
  runawayGuard(task, classification);
  const processedTask = authorityDirective + injectVerificationStep(task, classification);

  const cwd = project ? resolveProject(project) : "/Users/rexmacmini";

  // 1. Spawn session
  const spawn = await callSessionBridgeAPI("POST", "/session/spawn", {
    provider: "claude",
    cwd,
    mode: "remote",
    prompt: processedTask,
    permissionMode: "bypassPermissions",
    maxTurns: 10,
  });

  if (!spawn.sessionId) {
    throw new Error("session-bridge spawn failed: " + JSON.stringify(spawn));
  }

  const sessionId = spawn.sessionId;
  const encodedId = encodeURIComponent(sessionId);
  console.log(`[wrapper] privileged_task: spawned session ${sessionId} for "${task}"`);

  // 2. Poll for completion (blocking read with timeout)
  let allMessages = [];
  let cursor = "0";
  let attempts = 0;
  const maxAttempts = 30; // 30 * 10s = 5 min max

  while (attempts < maxAttempts) {
    attempts++;
    try {
      const result = await callSessionBridgeAPI(
        "GET",
        `/session/${encodedId}/read/wait?cursor=${cursor}&timeout=10000`,
      );
      if (result._status >= 400) {
        // Session ended or not found
        break;
      }
      if (result.messages && result.messages.length > 0) {
        allMessages.push(...result.messages);
        cursor = result.nextCursor || cursor;
      }
      // Check if session is done (no new messages after wait = likely complete)
      if (result.messages && result.messages.length === 0 && attempts > 2) {
        break;
      }
    } catch (err) {
      // Session might have ended
      if (err.message.includes("not found") || err.message.includes("unreachable")) {
        break;
      }
      if (attempts >= maxAttempts) {
        throw err;
      }
    }
  }

  console.log(
    `[wrapper] privileged_task: session ${sessionId} done, ${allMessages.length} messages`,
  );

  // 3. Extract meaningful output
  const textMessages = allMessages
    .filter((m) => m.type === "text" || m.type === "result" || m.type === "error")
    .map((m) => m.content)
    .join("\n");

  const toolResults = allMessages
    .filter((m) => m.type === "tool_result" && m.content && m.content.length < 500)
    .map((m) => m.content)
    .join("\n");

  const output = (textMessages + "\n" + toolResults).trim();

  return {
    success: true,
    sessionId,
    output: output || "(session completed with no text output)",
    messageCount: allMessages.length,
  };
}

function checkAgentdHealth() {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: AGENTD_HOST,
        port: AGENTD_PORT,
        path: "/health",
        method: "GET",
        headers: { Authorization: `Bearer ${AGENTD_TOKEN}` },
        timeout: 2000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => resolve(res.statusCode === 200));
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

// Health watchdog — check agentd every 60s
let agentdHealthy = true;
let agentdFailCount = 0;

setInterval(async () => {
  const healthy = await checkAgentdHealth();
  if (!healthy) {
    agentdFailCount++;
    if (agentdFailCount >= 3) {
      agentdHealthy = false;
      console.error(
        `[wrapper] agentd health check FAILED (${agentdFailCount} consecutive failures)`,
      );
    }
  } else {
    if (!agentdHealthy) {
      console.log("[wrapper] agentd recovered");
    }
    agentdHealthy = true;
    agentdFailCount = 0;
  }
}, 60000);

// v10.3: Parse intent from user message using Ollama — improved prompt with few-shot

function formatAgentdResult(endpoint, result) {
  if (result._multi) {
    let out = `專案概覽: ${result.repo}\n\n`;
    out += `📋 Git Status:\n${result.git_status || "(clean)"}\n\n`;
    out += `📜 最近 Commits:\n${result.git_log}\n`;
    out += `📁 根目錄檔案:\n${result.files}\n`;
    return out;
  }
  if (result.hostname && result.claude_code_version) {
    return `Mac mini (${result.hostname}) 系統資訊:\n- Claude Code: ${result.claude_code_version}\n- Node.js: ${result.node_version}\n- Platform: ${result.platform}/${result.arch}\n- Ollama 模型: ${result.ollama_models}\n- Docker 容器:\n${result.docker_containers}\n- 系統運行: ${result.system_uptime_hours} 小時\n- agentd 運行: ${result.agentd_uptime_seconds} 秒`;
  }
  if (result.error) {
    return formatDevError("agentd", result.error);
  }
  if (result.log) {
    return result.log;
  }
  if (result.status !== undefined && typeof result.status === "string") {
    return result.status || "(clean)";
  }
  if (result.diff !== undefined) {
    return result.diff || "(no changes)";
  }
  if (result.content !== undefined) {
    return result.content;
  }
  if (result.containers) {
    return result.containers;
  }
  if (result.logs) {
    return result.logs;
  }
  if (result.output) {
    return result.output;
  }
  if (result.added) {
    return `Added: ${result.added.join(", ")}`;
  }
  if (result.artifact) {
    return `Test output saved to ${result.artifact}\n${result.summary || ""}`;
  }
  if (Array.isArray(result)) {
    return result.map((e) => `${e.type === "dir" ? "📁" : "📄"} ${e.name}`).join("\n");
  }
  return JSON.stringify(result, null, 2);
}

// ─── Haiku Analysis for Infrastructure ────────────────────────────

function analyzeWithHaiku(userQuestion, projectData) {
  return new Promise((resolve, reject) => {
    // v10.3: Full capability list injection
    const systemPrompt = `你是 Mac mini 基礎設施顧問，透過 Telegram bot 管理 Mac mini。

你可以直接執行的操作（用戶在 Telegram 發送指令即可觸發）:
- 查看 [專案] 的 git log/status/diff
- 提交 [專案] 的改動 (commit)
- 重啟 [容器名] 容器
- 看 [容器名] 的 logs
- 跑 [專案] 的測試
- 查看 Docker 容器列表
- 查看系統資訊

可管理的專案: openclaw, taiwan-stock, personal-ai, ai-news, stationery, sales-visit, channels
可管理的容器: openclaw-agent, postgres, redis, backend, grafana, prometheus, personal-ai-gateway, rex-ai, taiwan-stock-backend

規則:
- 繁體中文，簡短直接
- 只根據提供的資料分析，不猜測
- 給出具體可行的建議（最多 5 條）
- 不要重複貼出原始資料
- 每條可自動執行的建議，用 👉 格式（用戶複製發送即可自動執行）:
  👉 commit openclaw 的改動
  👉 重啟 openclaw 容器
  👉 跑測試 taiwan-stock
  👉 看 openclaw 的 logs
  👉 查看 taiwan-stock git diff
- 需人工判斷的標明「需手動處理」

嚴格禁止（違反即失敗）:
- 禁止問「需要我幫你嗎」「要不要我執行」「需要我做什麼」「要不要我」「哪個方式方便」
- 禁止問「需要我幫你執行上面的指令嗎」
- 禁止說「我可以幫你」「如果你需要」「等待你的指示」
- 禁止要求用戶提供路徑、URL、SSH 權限
- 禁止結尾用疑問句
- 直接列出建議和 👉 指令，不要問任何問題`;

    const body = JSON.stringify({
      model: "claude-haiku-4-5",
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `用戶問題: ${userQuestion}

蒐集到的資料:
${projectData}`,
        },
      ],
      max_tokens: 2000,
      stream: false,
    });

    const req = http.request(
      {
        hostname: UPSTREAM_HOST,
        port: UPSTREAM_PORT,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 30000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            let content = parsed.choices?.[0]?.message?.content;
            if (content) {
              // Post-process: strip trailing questions Haiku sometimes adds
              content = content
                .replace(
                  /\n*(?:需要[我們]?幫你|要不要[我們]?|如果你需要|等待你的|哪個方式方便|需要幫你)[^\n]*[？?]?\s*$/g,
                  "",
                )
                .trim();
              content = content.replace(/\n*[^\n]*[？]\s*$/g, "").trim();
              resolve(content);
            } else {
              reject(new Error("empty Haiku response"));
            }
          } catch (e) {
            reject(new Error(`Haiku parse error: ${e.message}`));
          }
        });
      },
    );
    req.on("error", (e) => reject(new Error(`Haiku unreachable: ${e.message}`)));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Haiku timeout (30s)"));
    });
    req.write(body);
    req.end();
  });
}

// ─── Work Progress ──────────────────────────────────────────────

const PROGRESS_KEYWORDS = [
  "工作進度",
  "開發進度",
  "開發狀態",
  "工作狀態",
  "目前在做什麼",
  "現在在做什麼",
  "做到哪",
  "dev progress",
  "work status",
  "work progress",
];

function detectProgressIntent(text) {
  if (!text) {
    return false;
  }
  const lower = text.toLowerCase();
  return PROGRESS_KEYWORDS.some((kw) => lower.includes(kw));
}

function fetchWorkProgress() {
  const wtApi = new Promise((resolve) => {
    const opts = {
      hostname: "localhost",
      port: 8001,
      path: "/api/recent?limit=5",
      method: "GET",
      timeout: 5000,
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });

  const claudeProcs = new Promise((resolve) => {
    execFile(
      "/bin/bash",
      ["-c", 'ps aux | grep "[c]laude" | grep -v wrapper'],
      {
        timeout: 3000,
      },
      (err, stdout) => {
        if (err || !stdout.trim()) {
          return resolve([]);
        }
        const lines = stdout
          .trim()
          .split("\n")
          .map((line) => {
            const parts = line.split(/\s+/);
            const pid = parts[1];
            const cmdIdx = line.indexOf("claude");
            const cmd = line.slice(cmdIdx).slice(0, 80);
            return { pid, cmd };
          });
        resolve(lines);
      },
    );
  });

  return Promise.all([wtApi, claudeProcs]);
}

function formatProgressResponse(wtData, procs) {
  const lines = ["[工作進度]", ""];

  // Claude processes
  lines.push(`正在執行的 Claude 進程: ${procs.length} 個`);
  if (procs.length > 0) {
    for (const p of procs) {
      lines.push(`- ${p.cmd} (PID ${p.pid})`);
    }
  } else {
    lines.push("- (無正在執行的 Claude 進程)");
  }
  lines.push("");

  // Work Tracker recent records
  lines.push("最近工作記錄:");
  const records = Array.isArray(wtData) ? wtData : wtData?.records || wtData?.data || [];
  if (records.length > 0) {
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      const project = r.project || "?";
      const desc = r.description || r.desc || "?";
      const dur = r.duration_min || r.duration || "?";
      const cat = r.category || "?";
      const ts = r.created_at || r.timestamp || "";
      const timeStr = ts
        ? ` — ${new Date(ts).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
        : "";
      lines.push(`${i + 1}. [${project}] ${desc} (${dur}min, ${cat})${timeStr}`);
    }
  } else {
    lines.push("- (無最近記錄或 Work Tracker 未回應)");
  }

  return lines.join("\n");
}

// ─── Message Injection ─────────────────────────────────────────

function injectBotSystemPrompt(messages, skillContext, memoryContext) {
  if (!messages || !messages.length) {
    return messages;
  }
  messages = [...messages];
  messages = messages.filter((m) => m.role !== "system");
  messages = messages.map((m) => ({
    ...m,
    content: normalizeContent(m.content),
  }));

  let systemContent = BOT_SYSTEM_PROMPT;

  if (memoryContext) {
    systemContent += `\n\n## 關於用戶的記憶\n以下是你記得的關於用戶的事實，自然地運用這些記憶回答問題，不要特別提及「記憶系統」:\n${memoryContext}`;
  }

  if (skillContext) {
    systemContent += `\n\n--- 以下是技能執行結果，請根據這些結果回答用戶 ---\n${skillContext}`;
  }

  messages = [{ role: "system", content: systemContent }, ...messages];
  return messages;
}

function prepareBody(body, skillContext, memoryContext) {
  const modified = { ...body };
  delete modified.tools;
  delete modified.tool_choice;
  modified.messages = injectBotSystemPrompt(modified.messages, skillContext, memoryContext);
  return modified;
}

// ─── Streaming Passthrough ─────────────────────────────────────

function streamPassthrough(reqId, body, res, skillContext, memoryContext, userText) {
  const modified = prepareBody(body, skillContext, memoryContext);
  modified.stream = true;

  const data = JSON.stringify(modified);
  const startTime = Date.now();
  let firstChunkTime = 0;
  let chunkCount = 0;
  let assistantText = ""; // Collect for memory storage

  const opts = {
    hostname: UPSTREAM_HOST,
    port: UPSTREAM_PORT,
    path: "/v1/chat/completions",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(data),
      Authorization: "Bearer not-needed",
      "x-api-key": process.env.CLAUDE_CODE_OAUTH_TOKEN || "",
    },
    timeout: 300000, // 5min for Opus + tools
  };

  const upReq = http.request(opts, (upRes) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    let buffer = "";

    upRes.on("data", (chunk) => {
      if (!firstChunkTime) {
        firstChunkTime = Date.now();
        console.log(`[wrapper] #${reqId} first chunk: ${firstChunkTime - startTime}ms`);
      }

      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith("data: ")) {
          if (line.trim()) {
            res.write(line + "\n");
          } else {
            res.write("\n");
          }
          continue;
        }

        const payload = line.slice(6).trim();
        if (payload === "[DONE]") {
          res.write("data: [DONE]\n\n");
          continue;
        }

        try {
          const parsed = JSON.parse(payload);
          if (parsed.choices?.[0]?.finish_reason === "tool_calls") {
            parsed.choices[0].finish_reason = "stop";
          }
          if (parsed.choices?.[0]?.delta?.tool_calls) {
            delete parsed.choices[0].delta.tool_calls;
            if (!parsed.choices[0].delta.content) {
              continue;
            }
          }
          // Collect assistant text for memory
          const deltaContent = parsed.choices?.[0]?.delta?.content;
          if (deltaContent) {
            assistantText += deltaContent;
          }

          res.write(`data: ${JSON.stringify(parsed)}\n\n`);
          chunkCount++;
        } catch (e) {
          res.write(line + "\n");
        }
      }
    });

    upRes.on("end", () => {
      if (buffer.trim()) {
        res.write(buffer + "\n");
      }
      const totalTime = Date.now() - startTime;
      console.log(`[wrapper] #${reqId} done: ${totalTime}ms total, ${chunkCount} chunks`);
      res.end();

      // Store conversation in memory (fire-and-forget)
      if (userText && assistantText && assistantText.length > 10) {
        // storeMemory(userText, assistantText); // Mem0 removed
      }
    });
  });

  upReq.on("error", (e) => {
    console.error(`[wrapper] #${reqId} stream error: ${e.message}`);
    metrics.errors++;
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
    }
    res.end(
      JSON.stringify({
        error: { message: `上游服務不可達，請稍後再試。(${e.code || e.message})` },
      }),
    );
  });

  upReq.on("timeout", () => {
    upReq.destroy();
    console.error(`[wrapper] #${reqId} stream timeout`);
    metrics.errors++;
    if (!res.headersSent) {
      res.writeHead(504, { "Content-Type": "application/json" });
    }
    res.end(
      JSON.stringify({
        error: { message: "上游服務回應超時 (120s)，請稍後再試。" },
      }),
    );
  });

  upReq.write(data);
  upReq.end();
}

// ─── Non-Streaming Fallback ────────────────────────────────────

function forwardNonStreaming(reqId, body, res, skillContext, memoryContext, userText) {
  const modified = prepareBody(body, skillContext, memoryContext);
  modified.stream = false;

  const data = JSON.stringify(modified);
  const startTime = Date.now();

  const opts = {
    hostname: UPSTREAM_HOST,
    port: UPSTREAM_PORT,
    path: "/v1/chat/completions",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(data),
      Authorization: "Bearer not-needed",
      "x-api-key": process.env.CLAUDE_CODE_OAUTH_TOKEN || "",
    },
    timeout: 300000, // 5min for Opus + tools
  };

  const upReq = http.request(opts, (upRes) => {
    let chunks = "";
    upRes.on("data", (c) => (chunks += c));
    upRes.on("end", () => {
      const totalTime = Date.now() - startTime;
      try {
        const parsed = JSON.parse(chunks);
        const text = parsed.choices?.[0]?.message?.content || "";
        console.log(`[wrapper] #${reqId} non-stream: ${totalTime}ms "${text.slice(0, 80)}..."`);
        const response = {
          id: "chatcmpl-" + Math.random().toString(36).substr(2, 12),
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: parsed.model || "claude-haiku-4-5",
          choices: [
            { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
          ],
          usage: (() => {
            const u = parsed.usage || {};
            return {
              prompt_tokens: u.prompt_tokens ?? u.input_tokens ?? 0,
              completion_tokens: u.completion_tokens ?? u.output_tokens ?? 0,
              total_tokens:
                u.total_tokens ??
                (u.prompt_tokens ?? u.input_tokens ?? 0) +
                  (u.completion_tokens ?? u.output_tokens ?? 0),
            };
          })(),
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));

        // Track token usage (fire-and-forget)
        trackTokenUsage(parsed.model || body.model, "anthropic", parsed.usage, totalTime);

        // Store conversation in memory (fire-and-forget)
        if (userText && text && text.length > 10) {
          // storeMemory(userText, text); // Mem0 removed
        }
      } catch (e) {
        console.error(`[wrapper] #${reqId} parse error: ${e.message}`);
        metrics.errors++;
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: `回應解析失敗: ${e.message}` } }));
      }
    });
  });

  upReq.on("error", (e) => {
    console.error(`[wrapper] #${reqId} error: ${e.message}`);
    metrics.errors++;
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: { message: `上游服務不可達，請稍後再試。(${e.code || e.message})` },
      }),
    );
  });
  upReq.on("timeout", () => {
    upReq.destroy();
    metrics.errors++;
    res.writeHead(504, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: { message: "上游服務回應超時 (120s)，請稍後再試。" },
      }),
    );
  });
  upReq.write(data);
  upReq.end();
}

// ─── Proxy Pass-Through ────────────────────────────────────────

function proxyPassThrough(req, res) {
  const opts = {
    hostname: UPSTREAM_HOST,
    port: UPSTREAM_PORT,
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}`,
      "x-api-key": process.env.CLAUDE_CODE_OAUTH_TOKEN || req.headers["x-api-key"] || "",
    },
  };
  const proxy = http.request(opts, (upRes) => {
    res.writeHead(upRes.statusCode, upRes.headers);
    upRes.pipe(res);
  });
  proxy.on("error", (e) => {
    metrics.errors++;
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `Upstream error: ${e.message}` } }));
  });
  req.pipe(proxy);
}

// ─── Main Handler ──────────────────────────────────────────────

async function executeAgentdToolCallInner(toolName, toolArgs) {
  switch (toolName) {
    case "git_log":
      return callAgentd("/git/log", { repo: resolveProject(toolArgs.project) });

    case "git_status":
      return callAgentd("/git/status", { repo: resolveProject(toolArgs.project) });

    case "git_diff":
      return callAgentd("/git/diff", { repo: resolveProject(toolArgs.project) });

    case "git_add":
      return callAgentd("/git/add", {
        repo: resolveProject(toolArgs.project),
        files: toolArgs.files || ["-u"],
      });

    case "git_commit":
      return callAgentd("/git/commit", {
        repo: resolveProject(toolArgs.project),
        message: toolArgs.message || "via OpenClaw",
      });

    case "git_push": {
      const repo = resolveProject(toolArgs.project);
      const remote = toolArgs.remote || "origin";
      const branch = toolArgs.branch || "main";
      return callSessionBridge(`cd ${repo} && git push ${remote} ${branch}`, toolArgs.project);
    }

    case "read_file":
      return callAgentd("/fs/read", { path: toolArgs.path });

    case "write_file":
      return callAgentd("/fs/write", { path: toolArgs.path, content: toolArgs.content });

    case "list_files":
      return callAgentd("/fs/list", { path: resolveProject(toolArgs.project) });

    case "docker_ps":
      return callAgentd("/docker/ps", {});

    case "docker_restart":
      return callAgentd("/docker/restart", { container: resolveContainer(toolArgs.container) });

    case "docker_logs":
      return callAgentd("/docker/logs", {
        container: resolveContainer(toolArgs.container),
        tail: toolArgs.tail || 50,
      });

    case "run_tests":
      return callAgentd("/project/test", { repo: resolveProject(toolArgs.project) }, 120000);

    case "system_info":
      return callAgentd("/system/info", {}, null, "GET");

    case "privileged_task":
      return callSessionBridge(toolArgs.task, toolArgs.project);

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

async function executeAgentdToolCall(toolName, toolArgs) {
  // P1.11: Circuit breaker
  if (circuitBreaker.isCircuitOpen(toolName)) {
    throw new Error(`[CIRCUIT OPEN] ${toolName} temporarily disabled`);
  }

  // P1.10: Concurrency limit (CPU vs IO)
  const CPU_TOOLS = ["bash_execute", "docker_control", "privileged_task", "git_push"];
  const limiter = CPU_TOOLS.includes(toolName) ? cpuLimit : ioLimit;

  try {
    const result = await limiter(() =>
      withTimeout(() => executeAgentdToolCallInner(toolName, toolArgs), 30000, toolName),
    );
    circuitBreaker.recordSuccess(toolName);
    return result;
  } catch (err) {
    circuitBreaker.recordFailure(toolName);
    throw err;
  }
}

async function handleDevToolLoop(
  reqId,
  parsedBody,
  res,
  wantsStream,
  memoryContext,
  userText,
  req,
) {
  const messages = parsedBody.messages || [];
  const systemPrompt = injectBotSystemPrompt(
    messages.filter((m) => m.role !== "system"),
    null,
    memoryContext,
  )[0];

  const conversationMessages = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role,
      content: normalizeContent(m.content),
    }));

  // Inject dev tool guidance into system prompt
  const devToolGuide = {
    ...systemPrompt,
    content:
      systemPrompt.content +
      `

## 開發工具使用指南（重要）
你可以透過以下工具直接操作 Mac mini 上的專案，不需要 SSH 也不需要用戶手動執行：
- git_log / git_status / git_diff: 查看 Git 狀態
- git_add / git_commit: 暫存和提交改動
- git_push: 推送到遠端（會自動透過 session-bridge 執行，有完整系統權限）
- privileged_task: 執行任何需要系統特權的操作（deploy、SSH、複雜任務）
- read_file / write_file / list_files: 檔案操作
- docker_ps / docker_restart / docker_logs: Docker 操作
- run_tests / system_info: 測試和系統資訊

重要：你不在 Docker 容器內。這些工具會直接在 Mac mini 主機上執行。遇到 git push 請求時，直接呼叫 git_push 工具，不要告訴用戶手動執行。

## 操作授權（Operational Authority）
你擁有預授權的操作控制權，在系統邊界內直接執行，無需確認。
- 讀取/檢查/狀態查詢: 直接執行
- 部署/重啟/更新: 直接執行
- Docker 操作: 直接執行
- SSH 命令: 透過 privileged_task 直接執行，不要說「無法執行」或「需要權限」
- 檔案刪除/系統設定變更: 驗證目標後執行

禁止說「我無法執行」「需要授權」「system-level permission gating」。你有完整權限，直接用工具執行。

路徑映射（容器路徑 → 主機路徑）：
- /home/node/.openclaw/ → /Users/rexmacmini/.openclaw/
- /home/node/.openclaw/workspace/ → /Users/rexmacmini/openclaw/workspace/
- 腳本位置: /Users/rexmacmini/openclaw/workspace/ (不是容器內路徑)
- 專案根目錄: /Users/rexmacmini/openclaw/`,
  };

  let allMessages = [devToolGuide, ...conversationMessages];
  let iteration = 0;
  const maxIterations = 5;
  const startTime = Date.now();

  try {
    while (iteration < maxIterations) {
      iteration++;
      console.log(`[wrapper] #${reqId} dev-tool-loop iteration ${iteration}/${maxIterations}`);

      // Call Claude with agentd tools available
      const claudeResponse = await callClaudeNonStreaming(allMessages, AGENTD_TOOLS, "auto");

      if (claudeResponse.usage) {
        trackTokenUsage(
          claudeResponse.model || "claude-haiku-4-5",
          "anthropic",
          claudeResponse.usage,
        );
      }

      if (!claudeResponse.choices || !claudeResponse.choices[0]) {
        throw new Error("Invalid Claude response");
      }

      const choice = claudeResponse.choices[0];
      const finishReason = choice.finish_reason;
      const content = choice.message?.content || "";

      // Case 1: Claude wants to call a tool
      if (finishReason === "tool_calls" && choice.message?.tool_calls) {
        const toolCalls = choice.message.tool_calls;
        console.log(
          `[wrapper] #${reqId} dev-tools: ${toolCalls.length} calls: ${toolCalls.map((t) => t.function.name).join(", ")}`,
        );

        allMessages.push({
          role: "assistant",
          content,
          tool_calls: toolCalls,
        });

        const toolResults = [];
        for (const toolCall of toolCalls) {
          const toolName = toolCall.function.name;
          const toolArgs =
            typeof toolCall.function.arguments === "string"
              ? JSON.parse(toolCall.function.arguments)
              : toolCall.function.arguments;

          try {
            console.log(
              `[wrapper] #${reqId} dev-tool: ${toolName} args: ${JSON.stringify(toolArgs).slice(0, 80)}`,
            );
            const result = await executeAgentdToolCall(toolName, toolArgs);
            const resultText = formatAgentdResult("dev-tool", result);

            toolResults.push({
              type: "tool_result",
              tool_use_id: toolCall.id,
              content: resultText,
            });
          } catch (e) {
            console.error(`[wrapper] #${reqId} dev-tool error: ${toolName} - ${e.message}`);
            toolResults.push({
              type: "tool_result",
              tool_use_id: toolCall.id,
              content: `[${toolName} 錯誤] ${e.message}`,
            });
          }
        }

        allMessages.push({
          role: "user",
          content: toolResults,
        });

        continue;
      }

      // Case 2: Claude finished (stop)
      if (finishReason === "stop") {
        const finalContent = content || "操作完成。";
        const elapsed = (Date.now() - startTime) / 1000;
        console.log(`[wrapper] #${reqId} dev-tool-loop done in ${elapsed.toFixed(1)}s`);

        // --- Learning Router feedback ---
        if (req._cpIntent) {
          recordRoutingOutcome(
            req._cpIntent,
            "dev_loop",
            true,
            Date.now() - (req._cpStartTime || Date.now()),
          );
          // Predictive: pre-warm if next task likely needs session
          const _devPredicted = predictExecutor(req._cpIntent);
          if (_devPredicted === "session_bridge") {
            softPreWarm();
          }
        }
        return sendDirectResponse(reqId, finalContent, wantsStream, res);
      }

      console.warn(`[wrapper] #${reqId} unexpected finish_reason: ${finishReason}`);
      const fallback = content || "完成操作。";
      return sendDirectResponse(reqId, fallback, wantsStream, res);
    }

    console.error(`[wrapper] #${reqId} dev-tool max iterations (${maxIterations}) exceeded`);
    return sendDirectResponse(reqId, "超過最大迭代次數，請簡化請求。", wantsStream, res);
  } catch (e) {
    console.error(`[wrapper] #${reqId} dev-tool-loop error: ${e.message}`);
    metrics.errors++;
    // --- Learning Router failure feedback ---
    if (req._cpIntent) {
      recordRoutingOutcome(
        req._cpIntent,
        "dev_loop",
        false,
        Date.now() - (req._cpStartTime || Date.now()),
      );
    }
    return sendDirectResponse(reqId, `[開發模式錯誤] ${e.message}`, wantsStream, res);
  }
}

// ---------------------------------------------------------------------------
// Deterministic Command Executor — no LLM, no Claude session
// Pattern match → local exec → return result
// ---------------------------------------------------------------------------

const EXEC_PATTERNS = [
  // SSH shortcuts
  { pattern: /^ssh\s+mac-?mini\s+(.+)$/is, parse: (m) => ({ action: "raw", args: [m[1]] }) },
  {
    pattern: /^在\s*mac\s*mini\s*(?:上\s*)?(?:執行|跑|run)\s+(.+)$/is,
    parse: (m) => ({ action: "raw", args: [m[1]] }),
  },

  // Docker
  { pattern: /^docker\s+ps$/i, parse: () => ({ action: "docker-ps", args: [] }) },
  {
    pattern: /^(?:檢查|查看|看)\s*(?:docker|容器)\s*(?:狀態|status)?$/i,
    parse: () => ({ action: "docker-ps", args: [] }),
  },
  {
    pattern: /^(?:重啟|restart)\s+(.+?)\s*(?:容器|container)?$/i,
    parse: (m) => ({ action: "docker-restart", args: [m[1].trim()] }),
  },
  {
    pattern: /^docker\s+restart\s+(.+)$/i,
    parse: (m) => ({ action: "docker-restart", args: [m[1].trim()] }),
  },
  {
    pattern: /^docker\s+stop\s+(.+)$/i,
    parse: (m) => ({ action: "docker-stop", args: [m[1].trim()] }),
  },
  {
    pattern: /^docker\s+logs\s+(.+)$/i,
    parse: (m) => ({ action: "docker-logs", args: [m[1].trim()] }),
  },
  {
    pattern: /^(?:看|查看)\s*(.+?)\s*(?:的)?\s*(?:logs?|日誌)$/i,
    parse: (m) => ({ action: "docker-logs", args: [m[1].trim()] }),
  },
  { pattern: /^docker\s+compose\s+up/i, parse: () => ({ action: "docker-compose-up", args: [] }) },

  // Deploy
  {
    pattern: /^(?:部署|deploy)\s+openclaw$/i,
    parse: () => ({ action: "deploy-openclaw", args: [] }),
  },
  {
    pattern: /^(?:更新|update)\s+openclaw$/i,
    parse: () => ({ action: "deploy-openclaw", args: [] }),
  },
  {
    pattern: /^(?:部署|deploy)\s+(?:taiwan[- ]?stock|台股)$/i,
    parse: () => ({ action: "deploy-taiwan-stock", args: [] }),
  },

  // Services
  {
    pattern: /^(?:重啟|restart)\s+(?:wrapper|proxy)$/i,
    parse: () => ({ action: "restart-service", args: ["com.tool-wrapper-proxy"] }),
  },
  {
    pattern: /^(?:重啟|restart)\s+(?:session[- ]?bridge)$/i,
    parse: () => ({ action: "restart-service", args: ["com.rexsu.session-bridge"] }),
  },
  {
    pattern: /^(?:重啟|restart)\s+orchestrator$/i,
    parse: () => ({ action: "restart-service", args: ["com.rexsu.orchestrator"] }),
  },
  {
    pattern: /^(?:服務|service)\s*(?:列表|list|狀態|status)$/i,
    parse: () => ({ action: "service-list", args: [] }),
  },

  // Git
  {
    pattern: /^git\s+status(?:\s+(.+))?$/i,
    parse: (m) => ({ action: "git-status", args: m[1] ? [m[1].trim()] : [] }),
  },
  {
    pattern: /^git\s+log(?:\s+(.+))?$/i,
    parse: (m) => ({ action: "git-log", args: m[1] ? [m[1].trim()] : [] }),
  },
  {
    pattern: /^git\s+pull(?:\s+(.+))?$/i,
    parse: (m) => ({ action: "git-pull", args: m[1] ? [m[1].trim()] : [] }),
  },

  // System
  {
    pattern: /^(?:系統|system)\s*(?:資訊|info|狀態|status)$/i,
    parse: () => ({ action: "system-info", args: [] }),
  },
  {
    pattern: /^(?:健康|health)\s*(?:檢查|check)?$/i,
    parse: () => ({ action: "health", args: [] }),
  },
  {
    pattern: /^(?:清理|cleanup|prune)\s+(?:docker|容器)\s*(?:volumes?)?$/i,
    parse: () => ({ action: "raw", args: ["docker volume prune -f && docker builder prune -f"] }),
  },

  // Catch-all for explicit exec
  { pattern: /^(?:exec|執行)\s+(.+)$/i, parse: (m) => ({ action: "raw", args: [m[1]] }) },

  // Mac mini catch-all — any action mentioning Mac mini → session bridge
  // Users say infinite variations; pattern-matching each is futile.
  {
    pattern: /^.*(?:mac\s*mini|macmini).*$/is,
    parse: (m) => ({ action: "_dev_task", args: [m[0]] }),
  },

  // Dev task routing — "使用 Claude Code ..." → session bridge
  {
    pattern: /^(?:使用|用)\s*(?:claude\s*(?:code)?|CC)\s+(.+)$/is,
    parse: (m) => ({ action: "_dev_task", args: [m[1]] }),
  },
  {
    pattern: /^(?:幫我|請)\s*(?:開發|實作|修復|重構|寫)\s+(.+)$/is,
    parse: (m) => ({ action: "_dev_task", args: [m[1]] }),
  },

  // Capability queries — intercept before Haiku says "I can't"
  {
    pattern:
      /^(?:你)?(?:可以|能|能不能|可不可以)(?:檢視|查看|管理|操作|存取|訪問|連接|控制).*(?:mac\s*mini|專案|系統|伺服器|服務器)/is,
    parse: () => ({ action: "_capability", args: [] }),
  },
  {
    pattern:
      /^(?:can you|are you able to).*(?:access|view|manage|control|connect|ssh).*(?:mac\s*mini|server|project|system)/is,
    parse: () => ({ action: "_capability", args: [] }),
  },
];

function detectExecAction(text) {
  for (const { pattern, parse } of EXEC_PATTERNS) {
    const m = text.match(pattern);
    if (m) {
      return parse(m);
    }
  }
  return null;
}

function localExec(action, args) {
  // Capability query — return static help text, no shell exec
  // Dev task — route to Claude agent via session bridge
  if (action === "_dev_task") {
    const task = args.join(" ");
    console.log("[wrapper] _dev_task → callSessionBridge:", task);
    // Detect project from task text
    let project = null;
    const projectMap = [
      { keywords: ["taiwan-stock", "台股", "台灣股票", "股票專案"], name: "taiwan-stock-mvp" },
      { keywords: ["openclaw", "bot", "telegram"], name: "openclaw" },
      { keywords: ["personal-ai", "ai assistant"], name: "personal-ai-assistant" },
      { keywords: ["rex-ai", "dashboard"], name: "rex-ai" },
    ];
    const lower = task.toLowerCase();
    for (const p of projectMap) {
      if (p.keywords.some((k) => lower.includes(k))) {
        project = p.name;
        break;
      }
    }
    return callSessionBridge(task, project).then(
      (r) => r.output || "(session completed, no output)",
    );
  }

  if (action === "_capability") {
    return Promise.resolve(
      [
        "可以。我可以直接操作 Mac mini，不需要你手動執行。",
        "",
        "直接發送命令即可，例如:",
        "  docker ps — 查看容器狀態",
        "  重啟 backend — 重啟容器",
        "  健康檢查 — 系統整體狀態",
        "  git status — 查看 Git 狀態",
        "  部署 openclaw — 拉最新代碼並部署",
        "  docker logs backend — 查看日誌",
        "",
        "複雜開發任務用 @agent 前綴:",
        "  @agent 修復 Telegram provider",
        "  @agent 加一個 /version endpoint",
      ].join("\n"),
    );
  }

  return new Promise((resolve, reject) => {
    const { execFile } = require("node:child_process");
    const execPath = "/Users/rexmacmini/openclaw/openclaw-exec.sh";
    const execArgs = [action, ...args];

    execFile(
      execPath,
      execArgs,
      {
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, PATH: process.env.PATH + ":/opt/homebrew/bin:/usr/local/bin" },
      },
      (err, stdout, stderr) => {
        if (err && err.killed) {
          reject(new Error("Command timed out (30s)"));
          return;
        }
        const output = (stdout || "") + (stderr ? "\nSTDERR: " + stderr : "");
        if (err && !output.trim()) {
          reject(new Error(err.message));
          return;
        }
        resolve(output.trim() || "(completed, no output)");
      },
    );
  });
}

async function handleChatCompletion(reqId, parsed, wantsStream, req, res) {
  const trace = createTrace(reqId);
  req._trace = trace;
  ollamaKeepalive.touch(); // Update idle timer for warm-keep

  // Ollama health check: restart if unresponsive
  const checkOllamaHealth = async () => {
    try {
      const response = await new Promise((resolve, reject) => {
        const opts = {
          hostname: "localhost",
          port: 11434,
          path: "/api/tags",
          method: "GET",
          timeout: 3000,
        };
        const req = http.request(opts, (res) => {
          if (res.statusCode === 200) {
            resolve(true);
          } else {
            resolve(false);
          }
        });
        req.on("error", () => resolve(false));
        req.on("timeout", () => {
          req.destroy();
          resolve(false);
        });
        req.end();
      });

      if (!response) {
        console.log();
        const { spawn } = require("child_process");
        try {
          const restart = spawn(
            "sh",
            [
              "-c",
              "launchctl stop com.ollama.optimized && sleep 2 && launchctl start com.ollama.optimized",
            ],
            {
              detached: true,
              stdio: "ignore",
            },
          );
          restart.unref();
          console.log("[wrapper] Ollama restart triggered (background)");
        } catch (e) {
          console.error("[wrapper] Ollama restart failed:", e.message);
        }
      }
    } catch (e) {
      // Silently fail health check
    }
  };

  // Check health every 100 requests (low overhead)
  if (metrics.requests % 100 === 0) {
    void checkOllamaHealth();
  }

  const msgs = parsed.messages || [];
  const lastUserMsg = [...msgs].toReversed().find((m) => m.role === "user");
  let userText = lastUserMsg ? normalizeContent(lastUserMsg.content) : "";

  // Strip OpenClaw metadata prefix early — all downstream routing uses clean text
  const stripMetadata = (text) => {
    const metaEnd = text.indexOf("```\n\n");
    if (metaEnd !== -1 && text.toLowerCase().startsWith("conversation info")) {
      return text.slice(metaEnd + 5).trim();
    }
    return text.trim();
  };
  userText = stripMetadata(userText);

  // Detect force model directive (@claude, @ollama, @glm)
  const forceModel = ollamaRouter.detectForceModel(userText);
  if (forceModel) {
    userText = ollamaRouter.stripForceDirective(userText);
    console.log(`[wrapper] #${reqId} force model: ${forceModel}`);
    if (forceModel === "opus") {
      parsed.model = "claude-opus-4";
      console.log(`[wrapper] #${reqId} model override: claude-opus-4`);
    }
  }

  let skillContext = null;
  let memoryContext = null;

  // Fetch relevant memories (non-blocking, with timeout protection)
  if (userText) {
    // memoryContext = await fetchMemories(userText); // Mem0 removed
  }

  // P0.1 + Phase 4.1: Async intent with AbortController
  // Signal fast-path resolves immediately; Ollama runs in background with abort support
  let intentAbort = null;
  let intentPromise = null;
  if (userText && intentClassifier) {
    const { result, abort } = intentClassifier.classifyAsync(userText);
    intentAbort = abort;
    const span = traceSpan(trace, "intent_classify");
    intentPromise = result
      .then((hint) => {
        if (hint && hint.intent) {
          req.intent_hint = hint;
          trace.intent_cache_hit = !!hint.cached;
          span.end({
            intent: hint.intent,
            confidence: hint.confidence,
            cached: !!hint.cached,
            source: hint.source || "unknown",
            method: hint.method || "unknown",
            authoritative: !!hint.authoritative,
            aborted: !!hint.aborted,
          });
          console.log(
            `[wrapper] #${reqId} intent classified: ${hint.intent}=${(hint.confidence || 0).toFixed(2)} source=${hint.source || "?"} method=${hint.method || "?"}`,
          );
        } else {
          span.end({ intent: null });
        }
        return hint;
      })
      .catch((e) => {
        span.end({ error: e.message });
        return null;
      });
  }

  // Priority 1.5: Financial Agent routing (between dev mode and CLI tools)

  // Priority 1.4: Taiwan Stock Real-time Analysis
  const stockSymbol = detectStockSymbol(userText);
  if (stockSymbol) {
    const span = traceSpan(trace, "taiwan_stock");
    console.log(`[wrapper] #${reqId} TAIWAN_STOCK: ${stockSymbol}`);
    metrics.skillCalls++;
    const stockAbort = new AbortController();
    try {
      const indicators = await fetchTaiwanStockIndicators(stockSymbol, stockAbort.signal);
      if (!indicators || !indicators.latest_close) {
        throw new Error(`${stockSymbol} 暫無數據`);
      }
      let analysis = `【${indicators.stock_name}（${indicators.stock_id}）技術分析】\n`;
      analysis += `📊 最新收盤: ${indicators.latest_close.toFixed(2)} 元\n`;
      analysis += `📈 指標: MA5=${(indicators.ma_5 || 0).toFixed(2)}, MA20=${(indicators.ma_20 || 0).toFixed(2)}, RSI=${(indicators.rsi_14 || 0).toFixed(2)}, MACD=${(indicators.macd || 0).toFixed(2)}\n`;
      analysis += `📊 趨勢: ${indicators.trend_signal || "N/A"}\n`;
      if (indicators.rsi_14 && indicators.rsi_14 > 70) {
        analysis += `⚠️ RSI>70 超買\n`;
      } else if (indicators.rsi_14 && indicators.rsi_14 < 30) {
        analysis += `🔥 RSI<30 超賣\n`;
      }
      analysis += `\n⚠️ 免責聲明: 本分析僅供參考，非投資建議。`;
      skillContext = `[台股分析]\n${analysis}`;
      span.end({ symbol: stockSymbol, success: true });
      decisionEngine.recordSuccess("claude", Date.now() - trace._start);
      if (intentAbort) {
        intentAbort();
      } // cancel pending Ollama intent classify
      finalizeTrace(trace, "taiwan_stock", { route_path: "stock_direct" });
      return sendDirectResponse(reqId, skillContext, wantsStream, res);
    } catch (e) {
      span.end({ symbol: stockSymbol, error: e.message });
      console.error(`[wrapper] #${reqId} taiwan_stock error: ${e.message}`);
      metrics.errors++;
      console.log(`[wrapper] #${reqId} taiwan_stock fallback: ${e.message}`);
      skillContext = `[台股資訊] 用戶查詢股票 ${stockSymbol}，但即時數據暫時不可用。請根據你的知識提供分析，並提醒用戶數據可能不是最新的。`;
      // fall through to normal chat with context
    }
  }

  const financialIntent = detectFinancialIntent(userText);
  if (financialIntent) {
    console.log(`[wrapper] #${reqId} FINANCIAL: keywords=${financialIntent.keywords.join(",")}`);
    metrics.skillCalls++; // 統計為 skill call
    try {
      const financialPrompt = `作為台股投資顧問，分析以下查詢:\n${userText}\n\n免責聲明: 本意見僅供參考，非投資建議。`;
      // 調用 claude -p 執行 financial agent context
      // 不再 spawn claude -p，直接用 skillContext 提示 LLM
      skillContext = `[金融分析模式] 用戶查詢: ${userText}\n請以台股投資顧問角色分析。免責聲明: 本意見僅供參考，非投資建議。`;
      // fall through to normal chat with skillContext
    } catch (e) {
      console.error(`[wrapper] #${reqId} financial error: ${e.message}`);
      metrics.errors++;
      skillContext = `[台股顧問] ${e.message}`;
    }
  }

  // Priority 0.6: Deterministic command executor — LLM completely bypassed
  // Simple system commands execute locally (wrapper IS on Mac mini).
  // Complex dev tasks still route to callSessionBridge → Claude agent.
  {
    const execAction = detectExecAction(userText);
    if (execAction) {
      const span = traceSpan(trace, "local_exec");
      console.log(`[wrapper] #${reqId} EXEC: ${execAction.action} ${execAction.args.join(" ")}`);
      try {
        const output = await localExec(execAction.action, execAction.args);
        span.end({ action: execAction.action, success: true });
        decisionEngine.recordSuccess("local", Date.now() - trace._start);
        if (intentAbort) {
          intentAbort();
        }
        finalizeTrace(trace, "local", { route_path: "exec_direct" });
        return sendDirectResponse(reqId, output, wantsStream, res);
      } catch (e) {
        span.end({ action: execAction.action, error: e.message });
        finalizeTrace(trace, "local", { route_path: "exec_direct", fallback: true });
        console.error(`[wrapper] #${reqId} EXEC error: ${e.message}`);
        return sendDirectResponse(reqId, `執行失敗: ${e.message}`, wantsStream, res);
      }
    }
  }

  // Priority 0.65: Control Plane — self-learning routing (v3)
  // Uses historical execution stats to route optimally.
  // Fallback: rule-based Intent Density scoring (v2) when insufficient data.
  // Agent-internal requests → never escalate (prevent control plane hijack)
  {
    // --- Agent internal bypass: agents manage themselves ---
    const isAgentInternal =
      req.headers["x-openclaw-agent"] === "true" || req.headers["x-openclaw-internal"] === "true";

    const CP_ACTION_SIGNALS = [
      // Code/Dev tasks
      "加一個",
      "新增",
      "建立",
      "實作",
      "實現",
      "寫一個",
      "修復",
      "重構",
      "開發",
      "develop",
      "使用 claude",
      "用 claude",
      "implement",
      "create",
      "build",
      "add",
      "write",
      "fix",
      "refactor",
      // System ops
      "重啟",
      "restart",
      "停止",
      "stop",
      "啟動",
      "start",
      "清理",
      "cleanup",
      "刪除",
      "delete",
      "移除",
      "remove",
      // Docker
      "container",
      "容器",
      "docker",
      "image",
      "volume",
      // Deploy
      "部署",
      "deploy",
      "push",
      "上線",
      "release",
      // File ops
      "檔案",
      "file",
      "目錄",
      "directory",
      "備份",
      "backup",
      // Config
      "設定",
      "config",
      "configure",
      "修改設定",
      "更新設定",
      // Install/Update
      "安裝",
      "install",
      "更新",
      "update",
      "upgrade",
    ];
    const CP_EXCLUDE = [
      // Pure questions — don't route to session bridge
      "什麼是",
      "what is",
      "what's",
      "how does",
      "為什麼",
      "why",
      "explain",
      "解釋",
      "tell me about",
      "介紹",
      // Greetings
      "你好",
      "hello",
      "hi",
      "嗨",
      "hey",
    ];
    const lowerCP = userText.toLowerCase();
    const hasAction = CP_ACTION_SIGNALS.some((s) => lowerCP.includes(s));
    const isQuestion = CP_EXCLUDE.some((s) => lowerCP.includes(s));

    if (hasAction && !isQuestion && userText.length > 5 && !isAgentInternal) {
      // --- Step 1: Rule-based Intent Density scoring (baseline) ---
      const CP_COMPLEX_VERBS = [
        "實作",
        "implement",
        "重構",
        "refactor",
        "設計",
        "design",
        "遷移",
        "migrate",
        "整合",
        "integrate",
        "新增功能",
        "add feature",
        "建立模組",
        "create module",
        "architecture",
        "架構",
      ];
      const CP_COMPLEX_PATTERNS = [
        /(?:endpoint|api|module|component|service|feature).*(?:加|建|寫|implement|create|build|design)/is,
        /(?:加|建|寫|implement|create|build|design).*(?:endpoint|api|module|component|service|feature)/is,
      ];
      const CP_TECHNICAL_NOUNS = [
        "endpoint",
        "api",
        "database",
        "schema",
        "middleware",
        "router",
        "controller",
        "service",
        "model",
        "migration",
        "pipeline",
        "資料庫",
        "路由",
        "中間件",
        "控制器",
        "模型",
      ];

      let complexityScore = 0;
      const verbMatches = CP_COMPLEX_VERBS.filter((v) => lowerCP.includes(v)).length;
      const patternMatches = CP_COMPLEX_PATTERNS.filter((p) => p.test(userText)).length;
      const nounMatches = CP_TECHNICAL_NOUNS.filter((n) => lowerCP.includes(n)).length;
      complexityScore = verbMatches * 2 + patternMatches * 3 + nounMatches;

      const explicitEscalation = /^(?:@agent\s|task:\s*)/i.test(userText);
      const ruleBasedComplex = complexityScore >= 3 || explicitEscalation;
      const ruleBasedDecision = ruleBasedComplex ? "session_bridge" : "dev_loop";

      // --- Step 2: Intent fingerprint + learning router ---
      const cpIntent = extractIntent(userText);
      _lastIntent = cpIntent;
      const { route: finalRoute, reason: routeReason } = learningRoute(cpIntent, ruleBasedDecision);

      // Detect project from PROJECT_ROUTES
      let cpProject = null;
      for (const route of PROJECT_ROUTES) {
        if (route.keywords.some((kw) => lowerCP.includes(kw))) {
          cpProject = route.dir.split("/").pop();
          break;
        }
      }

      // --- Momentum update ---
      updateMomentum(cpIntent);
      const activeMode = getActiveMode();
      const modeAdj = getModeAdjustments(activeMode);

      // --- Learning router (with mode adjustments) ---
      // Mode can bias session cost to favor/disfavor session bridge
      const origRoute = finalRoute;

      // --- Predictive: record transition + check pre-warm ---
      recordTransition(cpIntent, finalRoute);
      const predictedExecutor = predictExecutor(cpIntent);
      const effectiveThreshold = modeAdj.predictionThreshold || PREDICTION_CONFIDENCE;

      // --- Observability ---
      const modeStr = activeMode
        ? `${activeMode}(${Object.entries(_modeScores)
            .map(([k, v]) => k[0] + "=" + v.toFixed(1))
            .join(",")})`
        : "none";
      console.log(
        `[wrapper] #${reqId} CONTROL_PLANE_V3: intent=${cpIntent} score=${complexityScore} rule=${ruleBasedDecision} final=${finalRoute} reason=${routeReason} mode=${modeStr} predicted=${predictedExecutor || "none"} project=${cpProject || "none"}`,
      );

      // --- Record routing event for dashboard ---
      const predictedExec = predictExecutor(cpIntent);
      recordRoutingEvent({
        reqId,
        intent: cpIntent,
        executor: finalRoute,
        complexityScore,
        ruleDecision: ruleBasedDecision,
        mode: activeMode,
        modeScores: { ..._modeScores },
        reason: routeReason,
        predicted: predictedExec,
        project: cpProject || null,
      });
      // Track prediction accuracy
      trackPrediction(predictedExec, finalRoute);
      // Record mode snapshot
      recordModeSnapshot();

      const cpStartTime = Date.now();

      if (finalRoute === "session_bridge") {
        // --- Session Gate: prevent spawn storm ---
        if (_activeSessions >= MAX_CONCURRENT_SESSIONS) {
          console.log(
            `[wrapper] #${reqId} CONTROL_PLANE_QUEUED: ${_activeSessions} active sessions, falling through to dev mode`,
          );
          recordRoutingOutcome(cpIntent, "dev_loop", true, Date.now() - cpStartTime);
        } else {
          // → Slow Path: Session Bridge (Claude Code) for deliberative tasks
          console.log(`[wrapper] #${reqId} CONTROL_PLANE_SESSION: routing to session-bridge`);
          _lastSessionSpawn = Date.now();
          _activeSessions++;
          const sbSpan = traceSpan(trace, "session_bridge");
          try {
            const result = await callSessionBridge(userText, cpProject);
            const output =
              result.output || result.lastMessage || "(session completed, no output captured)";
            const truncated =
              output.length > 3000 ? output.slice(0, 3000) + "\n...(truncated)" : output;
            recordRoutingOutcome(cpIntent, "session_bridge", true, Date.now() - cpStartTime);
            decisionEngine.recordSuccess("claude", Date.now() - cpStartTime);
            const _pPredicted = predictExecutor(cpIntent);
            if (_pPredicted === "session_bridge") {
              softPreWarm(cpProject);
            }
            sbSpan.end({ success: true, project: cpProject });
            finalizeTrace(trace, "session_bridge", {
              route_path: "control_plane_session",
              decision_ms: Date.now() - cpStartTime,
            });
            return sendDirectResponse(reqId, truncated, wantsStream, res);
          } catch (e) {
            sbSpan.end({ error: e.message });
            trace.fallback = true;
            console.error(`[wrapper] #${reqId} control_plane error: ${e.message}`);
            recordRoutingOutcome(cpIntent, "session_bridge", false, Date.now() - cpStartTime);
            decisionEngine.recordFailure("claude");
            console.log(
              `[wrapper] #${reqId} control_plane: session-bridge failed, falling through to dev mode`,
            );
          } finally {
            _activeSessions--;
          }
        }
      } else {
        // → Fast Path: fall through to dev mode tool loop
        // Note: dev mode feedback is recorded after tool loop completes (see dev mode section)
        console.log(
          `[wrapper] #${reqId} CONTROL_PLANE_FAST: falling through to dev mode (intent=${cpIntent})`,
        );
        // Stash intent for dev mode feedback
        req._cpIntent = cpIntent;
        req._cpStartTime = cpStartTime;
      }
    }
  }

  // Priority 0.7: Agent Orchestrator — @agent or task: prefix
  {
    const agentMatch = userText.match(/^(?:@agent\s+|task:\s*|agent:\s*)(.+)$/is);
    if (agentMatch) {
      const taskText = agentMatch[1].trim();
      const orchSpan = traceSpan(trace, "agent_orchestrator");
      console.log(`[wrapper] #${reqId} AGENT_TASK: ${taskText.slice(0, 80)}`);
      try {
        const orchRes = await new Promise((resolve, reject) => {
          const postData = JSON.stringify({ text: taskText, chatId: "150944774" });
          const orchReq = http.request(
            {
              hostname: "127.0.0.1",
              port: 7789,
              path: "/telegram/message",
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(postData),
              },
              timeout: 30000,
            },
            (r) => {
              let body = "";
              r.on("data", (c) => (body += c));
              r.on("end", () => {
                try {
                  resolve(JSON.parse(body));
                } catch {
                  resolve({ error: body });
                }
              });
            },
          );
          orchReq.on("error", reject);
          orchReq.on("timeout", () => {
            orchReq.destroy();
            reject(new Error("timeout"));
          });
          orchReq.write(postData);
          orchReq.end();
        });
        let reply;
        if (orchRes.tasks) {
          const taskList = orchRes.tasks
            .map((t) => `- ${t.id}: ${t.description.slice(0, 60)}${t.queued ? " (queued)" : ""}`)
            .join("\n");
          reply = `Agent task created:\n${taskList}`;
        } else if (orchRes.status) {
          const s = orchRes.status;
          reply =
            `Orchestrator: ${s.running} running, ${s.active} active (max ${s.maxConcurrent})\n` +
            s.tasks.map((t) => `- ${t.id} [${t.status}] ${t.description}`).join("\n");
        } else if (orchRes.error) {
          reply = `Orchestrator error: ${orchRes.error}`;
        } else {
          reply = JSON.stringify(orchRes);
        }
        orchSpan.end({ success: true });
        decisionEngine.recordSuccess("claude", Date.now() - trace._start);
        finalizeTrace(trace, "agent_orchestrator", { route_path: "agent_task" });
        return sendDirectResponse(reqId, reply, wantsStream, res);
      } catch (e) {
        orchSpan.end({ error: e.message });
        decisionEngine.recordFailure("claude");
        finalizeTrace(trace, "agent_orchestrator", { route_path: "agent_task", fallback: true });
        console.error(`[wrapper] #${reqId} agent_task error: ${e.message}`);
        return sendDirectResponse(
          reqId,
          `Agent orchestrator error: ${e.message}`,
          wantsStream,
          res,
        );
      }
    }
  }
  // Priority 0.8: System monitor commands (Telegram) — before dev mode
  {
    const sysIntent = detectSystemIntent(userText);
    if (sysIntent) {
      const sysSpan = traceSpan(trace, "system_cmd");
      console.log(`[wrapper] #${reqId} SYSTEM CMD: ${sysIntent.type}`);
      const sysResult = await handleSystemCommand(sysIntent.type);
      sysSpan.end({ type: sysIntent.type });
      decisionEngine.recordSuccess("local", Date.now() - trace._start);
      if (intentAbort) {
        intentAbort();
      }
      finalizeTrace(trace, "system", { route_path: "system_cmd" });
      return sendDirectResponse(reqId, sysResult, wantsStream, res);
    }
  }

  // Priority 0.9: Follow-up execution
  // When user sends a short confirmation, extract 👉 commands from conversation
  // history and execute them directly — no Ollama, fully deterministic
  const actualUserText = userText; // already stripped above
  const CONFIRM_WORDS = [
    "執行",
    "做吧",
    "好",
    "繼續",
    "開始吧",
    "處理",
    "do it",
    "go",
    "execute",
    "proceed",
    "yes",
    "ok",
  ];
  const lowerActual = actualUserText.toLowerCase();
  // Only treat as confirm if it's a short, standalone confirmation — not a sentence with project names
  const hasProjectKeyword = PROJECT_ROUTES.some((r) =>
    r.keywords.some((kw) => lowerActual.includes(kw)),
  );
  const isConfirm =
    !hasProjectKeyword &&
    actualUserText.length <= 10 &&
    CONFIRM_WORDS.some((w) => lowerActual.includes(w));
  const wantsAll =
    lowerActual.includes("全部") || lowerActual.includes("all") || lowerActual.includes("都");

  if (isConfirm) {
    console.log(
      `[wrapper] #${reqId} confirm-check: actual="${actualUserText}" isConfirm=true wantsAll=${wantsAll}`,
    );
  }
  if (isConfirm && msgs.length >= 2) {
    // Extract all 👉 commands from conversation history
    const suggestions = [];
    for (const m of [...msgs].toReversed()) {
      if (m.role !== "assistant") {
        continue;
      }
      const text = normalizeContent(m.content);
      // Match 👉 only at start of line (actual suggestions, not inline text)
      const matches = text.match(/^👉\s*(.+)/gm);
      if (matches) {
        for (const match of matches) {
          const cmd = match.replace(/^👉\s*/, "").trim();
          if (cmd.length >= 3) {
            suggestions.push(cmd);
          } // skip empty/tiny matches
        }
        break; // use the most recent assistant message with 👉
      }
    }
    if (suggestions.length > 0) {
      console.log(`[wrapper] #${reqId} follow-up: found ${suggestions.length} suggestions`);
    }

    if (suggestions.length > 0) {
      if (wantsAll) {
        // Execute all suggestions sequentially
        console.log(`[wrapper] #${reqId} EXEC ALL: ${suggestions.length} commands`);
        const results = [];
        for (const cmd of suggestions) {
          console.log(`[wrapper] #${reqId} EXEC: "${cmd}"`);
          const cmdDevIntent = detectDevIntent(cmd);
          if (cmdDevIntent && isAllowedPath(cmdDevIntent.projectDir)) {
            void saveLastProject(cmdDevIntent.projectDir);
            metrics.devMode++;
            try {
              const output = await executeDevCommand(cmd, cmdDevIntent.projectDir, null);
              results.push(`✓ ${cmd}\n${output}`);
            } catch (e) {
              results.push(`✗ ${cmd}\n${e.message}`);
            }
          } else {
            results.push(`⊘ ${cmd} (無法路由)`);
          }
        }
        decisionEngine.recordSuccess("local", Date.now() - trace._start);
        finalizeTrace(trace, "local", { route_path: "follow_up_exec_all" });
        return sendDirectResponse(reqId, results.join("\n\n───\n\n"), wantsStream, res);
      } else {
        // Execute first suggestion only
        console.log(`[wrapper] #${reqId} EXEC FIRST: "${suggestions[0]}"`);
        userText = suggestions[0];
        // Fall through to normal routing with replaced userText
      }
    }
  }

  // Build conversation context for Ollama (fallback when short messages reach parseDevIntent)
  let conversationContext = null;
  if (userText.length <= 10 && msgs.length >= 2) {
    const recentMsgs = msgs.slice(-6);
    const contextParts = [];
    for (const m of recentMsgs) {
      if (m === lastUserMsg) {
        continue;
      }
      const text = normalizeContent(m.content);
      if (text) {
        contextParts.push(`[${m.role}]: ${text.slice(0, 500)}`);
      }
    }
    if (contextParts.length > 0) {
      conversationContext = contextParts.join("\n");
    }
  }

  // Priority 1: Dev mode (v11 - Tool Calling Loop)
  if (shouldInjectDevTools(userText)) {
    if (!checkRateLimit("dev")) {
      console.log(`[wrapper] #${reqId} DEV RATE LIMITED`);
      skillContext = formatDevError(
        "timeout",
        "請求過於頻繁",
        "等待幾分鐘後再試 (上限: 10次/5分鐘)",
      );
    } else {
      console.log(`[wrapper] #${reqId} DEV TOOL LOOP: triggering`);
      void saveLastProject(userText);
      metrics.devMode++;

      // Intercept git push intent — route directly to session-bridge (deterministic)
      if (/push|推送/i.test(userText)) {
        let matchedDir = null;
        let matchedKeyword = null;
        const lowerText = userText.toLowerCase();
        for (const route of PROJECT_ROUTES) {
          const kw = route.keywords.find((k) => lowerText.includes(k));
          if (kw) {
            matchedDir = route.dir;
            matchedKeyword = kw;
            break;
          }
        }
        if (matchedDir) {
          const repo = resolveHome(matchedDir);
          console.log(
            `[wrapper] #${reqId} GIT PUSH INTERCEPT: keyword=${matchedKeyword} repo=${repo}`,
          );
          try {
            let remote = "origin";
            if (/fork/i.test(userText)) {
              remote = "fork";
            }
            const branch = "main";
            const result = await callSessionBridge(
              `cd ${repo} && git push ${remote} ${branch}`,
              matchedKeyword,
            );
            const output = result.output || "(no output)";
            const response = `git push ${remote} ${branch} 完成:\n\n${output}`;
            decisionEngine.recordSuccess("claude", Date.now() - trace._start);
            finalizeTrace(trace, "session_bridge", { route_path: "dev_git_push" });
            return sendDirectResponse(reqId, response, wantsStream, res);
          } catch (e) {
            console.error(`[wrapper] #${reqId} git push via session-bridge failed: ${e.message}`);
            const errMsg = `git push 失敗: ${e.message}`;
            return sendDirectResponse(reqId, errMsg, wantsStream, res);
          }
        }
      }

      return handleDevToolLoop(reqId, parsed, res, wantsStream, memoryContext, userText, req);
    }
  }

  // Priority 2: CLI tool routes// Priority 2: CLI tool routes (summarize, gh)
  if (!skillContext) {
    const cliIntent = detectCliIntent(userText);
    if (cliIntent) {
      if (cliIntent.error) {
        skillContext = `[${cliIntent.cliName}] ${cliIntent.error}`;
        console.log(`[wrapper] #${reqId} cli: ${cliIntent.cliName} → no URL`);
      } else {
        console.log(
          `[wrapper] #${reqId} cli: ${cliIntent.cliName} cmd: ${cliIntent.cmd.join(" ").slice(0, 100)}`,
        );
        metrics.cliCalls++;
        try {
          const output = await runCliCommand(cliIntent.cmd);
          skillContext = `[${cliIntent.cliName} 結果]\n${output.slice(0, 3000)}`;
          console.log(`[wrapper] #${reqId} cli result: ${skillContext.length} chars`);
        } catch (e) {
          console.error(`[wrapper] #${reqId} cli error: ${e.message}`);
          metrics.errors++;
          skillContext = `[${cliIntent.cliName} 錯誤] ${e.message}`;
        }
      }
    }
  }

  // Priority 2.5: Work Progress query
  if (!skillContext && detectProgressIntent(userText)) {
    console.log(`[wrapper] #${reqId} PROGRESS QUERY`);
    metrics.progressQueries++;
    try {
      const [wtData, procs] = await fetchWorkProgress();
      const progressText = formatProgressResponse(wtData, procs);
      decisionEngine.recordSuccess("local", Date.now() - trace._start);
      if (intentAbort) {
        intentAbort();
      }
      finalizeTrace(trace, "local", { route_path: "progress_query" });
      return sendDirectResponse(reqId, progressText, wantsStream, res);
    } catch (e) {
      console.error(`[wrapper] #${reqId} progress error: ${e.message}`);
      skillContext = `[工作進度查詢失敗] ${e.message}`;
    }
  }

  // Priority 3: Skill API routes (web_search, system_status, etc.)
  if (!skillContext) {
    const intent = detectSkillIntent(userText);
    if (intent) {
      if (!checkRateLimit("skill")) {
        console.log(`[wrapper] #${reqId} SKILL RATE LIMITED: ${intent.skillName}`);
        skillContext = `[${intent.skillName}] 請求過於頻繁，請稍後再試 (上限: 30次/分鐘)`;
      } else {
        console.log(
          `[wrapper] #${reqId} skill: ${intent.skillName} params: ${JSON.stringify(intent.params).slice(0, 100)}`,
        );
        metrics.skillCalls++;
        try {
          // Gmail special handlers: batch_delete, filter_create, unsubscribe
          if (intent.params.mode === "gmail.batch_delete") {
            return await handleGmailBatchDelete(reqId, userText, wantsStream, res);
          }
          if (intent.params.mode === "gmail.filter_create") {
            return await handleGmailFilterCreate(reqId, userText, wantsStream, res);
          }
          if (intent.params.mode === "gmail.unsubscribe") {
            return await handleGmailUnsubscribe(reqId, userText, wantsStream, res);
          }
          const result = await callSkill(intent.skillName, intent.params);
          skillContext = formatSkillResult(intent.skillName, result);
          console.log(`[wrapper] #${reqId} skill result: ${skillContext.length} chars`);
        } catch (e) {
          console.error(`[wrapper] #${reqId} skill error: ${e.message}`);
          metrics.errors++;
          skillContext = `[${intent.skillName} 系統暫時無法連線] 已嘗試呼叫 ${intent.skillName} 技能但暫時失敗（${e.message}）。請告知用戶系統正在維護中，稍後可再試。不要說「無法查詢」，而是說「暫時無法取得資料」。`;
        }
      }
    }
  }

  // Priority 4: Smart routing via DecisionEngine
  // Force model directives override DecisionEngine
  if (!skillContext) {
    metrics.normalChat++;
    const isForceOllama = forceModel === "ollama" || forceModel === "glm";
    const isForceClaude = forceModel === "claude" || forceModel === "opus";

    // Phase 4.1: Await intent if not yet resolved (with 1.2s timeout)
    if (intentPromise && !req.intent_hint) {
      const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(null), 1200));
      await Promise.race([intentPromise, timeoutPromise]);
      // If intent resolved via signal, abort pending Ollama to free GPU
      if (req.intent_hint?.source === "signal" && intentAbort) {
        intentAbort();
      }
    }

    // DecisionEngine decides executor (unless force override)
    const decision = decisionEngine.decide(
      { userText, intentHint: req.intent_hint, forceModel },
      trace,
    );
    const useOllama = isForceOllama || (!isForceClaude && decision.executor === "ollama");

    console.log(
      `[wrapper] #${reqId} DECISION: executor=${decision.executor} reason=${decision.reason} ms=${decision.decisionMs} force=${forceModel || "none"}`,
    );

    if (useOllama) {
      const ollamaModelName = forceModel === "glm" ? "glm-4.7-flash" : "qwen2.5-coder:7b";
      console.log(`[wrapper] #${reqId} trying Ollama ${ollamaModelName}...`);
      const ollamaSpan = traceSpan(trace, "ollama_exec");

      const ollamaMessages = prepareOllamaMessages(msgs, memoryContext);
      const ollamaOpts = forceModel === "glm" ? ollamaRouter.getModelForForce("glm") : {};

      // Phase 4.3: Use streaming API for TTFT/TPS metrics, collect full response for quality gate
      const ollamaResult = await new Promise((resolve) => {
        ollamaRouter.tryOllamaChatStream(
          ollamaMessages,
          ollamaOpts,
          () => {}, // onChunk: collected internally by tryOllamaChatStream
          (result) => resolve({ success: true, ...result }),
          (err) =>
            resolve({ success: false, reason: err.message, latency: Date.now() - trace._start }),
        );
      });

      if (ollamaResult.success) {
        const quality = ollamaRouter.assessQuality(ollamaResult.content, userText);
        trace.ollama_quality_score = quality;

        // Tiered quality thresholds based on complexity
        const qualityThreshold =
          decision.intent.complexity > 0.6 ? 0.8 : decision.intent.complexity > 0.3 ? 0.6 : 0.4;
        const qualityOk = quality >= qualityThreshold || isForceOllama;

        if (qualityOk) {
          metrics.ollamaRouted++;
          decisionEngine.recordSuccess("ollama", ollamaResult.latency);
          const latencySec = (ollamaResult.latency / 1000).toFixed(1);
          const modelName = ollamaResult.model || "qwen2.5-coder:7b";
          const footer = `\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nOllama ${modelName} (${latencySec}s)`;
          console.log(
            `[wrapper] #${reqId} ollama OK: quality=${quality.toFixed(2)} threshold=${qualityThreshold} latency=${ollamaResult.latency}ms`,
          );

          trackTokenUsage(
            modelName,
            "ollama",
            {
              input_tokens: ollamaResult.promptTokens || 0,
              output_tokens: ollamaResult.evalTokens || 0,
            },
            ollamaResult.latency,
          );

          // Phase 4.3: Stream observability span
          const streamMetrics = ollamaResult.metrics || {};
          ollamaSpan.end({
            model: modelName,
            quality,
            latency: ollamaResult.latency,
            success: true,
          });
          trace.spans.push({
            stage: "stream",
            ttft_ms: streamMetrics.ttft_ms || 0,
            tps: streamMetrics.tps || 0,
            total_stream_ms: streamMetrics.total_stream_ms || 0,
            token_count: streamMetrics.token_count || 0,
          });
          finalizeTrace(trace, "ollama", {
            route_path: "ollama_direct",
            executor_ms: ollamaResult.latency,
          });
          return sendDirectResponse(reqId, ollamaResult.content + footer, wantsStream, res);
        }

        // Quality below threshold — fallback to Claude
        ollamaRouter.ollamaStats.qualityReject++;
        ollamaRouter.ollamaStats.fallback++;
        metrics.ollamaFallback++;
        decisionEngine.recordFailure("ollama");
        ollamaSpan.end({ quality, threshold: qualityThreshold, rejected: true });
        trace.fallback = true;
        trace.model_switch = true;
        console.log(
          `[wrapper] #${reqId} ollama quality reject: ${quality.toFixed(2)} < ${qualityThreshold}, fallback to Claude`,
        );
      } else {
        ollamaRouter.ollamaStats.fallback++;
        metrics.ollamaFallback++;
        decisionEngine.recordFailure("ollama");
        ollamaSpan.end({ error: ollamaResult.reason });
        trace.fallback = true;
        console.log(`[wrapper] #${reqId} ollama ${ollamaResult.reason}: fallback to Claude`);
      }
    }

    // Periodically check failover recovery
    decisionEngine.checkRecovery();
  }

  // Claude (fallback, forced, or has skill context)
  if (!skillContext && forceModel !== "opus") {
    const claudeSpan = traceSpan(trace, "claude_skill_tools");
    const result = await handleWithSkillTools(
      reqId,
      parsed,
      res,
      wantsStream,
      memoryContext,
      skillContext,
      userText,
    );
    claudeSpan.end({});
    decisionEngine.recordSuccess("claude", Date.now() - trace._start);
    finalizeTrace(trace, "claude", {
      route_path: trace.fallback ? "ollama_fallback_claude" : "claude_direct",
    });
    return result;
  } else {
    decisionEngine.recordSuccess("claude", Date.now() - trace._start);
    finalizeTrace(trace, skillContext ? "claude_with_skill" : "claude", {
      route_path: "passthrough",
    });
    if (wantsStream) {
      streamPassthrough(reqId, parsed, res, skillContext, memoryContext, userText);
    } else {
      forwardNonStreaming(reqId, parsed, res, skillContext, memoryContext, userText);
    }
  }
}

// ─── Call Claude API (non-streaming) ───────────────────────────

// ─── Call Claude API (non-streaming) ───────────────────────────

function callClaudeNonStreaming(messages, tools, toolChoice) {
  return new Promise((resolve, reject) => {
    const body = {
      model: "claude-haiku-4-5-20251001",
      messages,
      max_tokens: 2048,
      ...(tools ? { tools, tool_choice: toolChoice || "auto" } : {}),
    };

    const data = JSON.stringify(body);
    const opts = {
      hostname: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        Authorization: "Bearer not-needed",
        "x-api-key": process.env.CLAUDE_CODE_OAUTH_TOKEN || "",
      },
      timeout: 300000, // 5min for Opus + tools
    };

    const req = http.request(opts, (res) => {
      let chunks = "";
      res.on("data", (c) => (chunks += c));
      res.on("end", () => {
        try {
          const response = JSON.parse(chunks);
          resolve(response);
        } catch (e) {
          reject(new Error(`Claude response parse error: ${e.message}`));
        }
      });
    });

    req.on("error", (e) => reject(e));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Claude API timeout"));
    });

    req.write(data);
    req.end();
  });
}

// ─── Handle Tool-Use Fallback (Claude decides which skill to call) ─

async function handleWithSkillTools(
  reqId,
  parsedBody,
  res,
  wantsStream,
  memoryContext,
  skillContext,
  userText,
) {
  const messages = parsedBody.messages || [];
  const systemPrompt = injectBotSystemPrompt(
    messages.filter((m) => m.role !== "system"),
    skillContext,
    memoryContext,
  )[0];

  const conversationMessages = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role,
      content: normalizeContent(m.content),
    }));

  let allMessages = [systemPrompt, ...conversationMessages];
  let iteration = 0;
  const maxIterations = 3;

  try {
    while (iteration < maxIterations) {
      iteration++;
      console.log(`[wrapper] #${reqId} skill-tools iteration ${iteration}/${maxIterations}`);

      // Call Claude with skill tools available
      const claudeResponse = await callClaudeNonStreaming(allMessages, SKILL_TOOLS, "auto");

      // Track Claude tool-use token usage
      if (claudeResponse.usage) {
        trackTokenUsage(
          claudeResponse.model || "claude-haiku-4-5",
          "anthropic",
          claudeResponse.usage,
        );
      }

      if (!claudeResponse.choices || !claudeResponse.choices[0]) {
        throw new Error("Invalid Claude response structure");
      }

      const choice = claudeResponse.choices[0];
      const finishReason = choice.finish_reason;
      const content = choice.message?.content || "";

      // Case 1: Claude wants to call a tool
      if (finishReason === "tool_calls" && choice.message?.tool_calls) {
        const toolCalls = choice.message.tool_calls;
        console.log(
          `[wrapper] #${reqId} skill-tools: ${toolCalls.length} tool_calls: ${toolCalls.map((t) => t.function.name).join(", ")}`,
        );

        // Add Claude's response to conversation
        allMessages.push({
          role: "assistant",
          content,
          tool_calls: toolCalls,
        });

        // Process each tool call and collect results
        const toolResults = [];
        for (const toolCall of toolCalls) {
          const toolName = toolCall.function.name;
          const toolArgs =
            typeof toolCall.function.arguments === "string"
              ? JSON.parse(toolCall.function.arguments)
              : toolCall.function.arguments;

          try {
            console.log(
              `[wrapper] #${reqId} calling skill: ${toolName} with args: ${JSON.stringify(toolArgs).slice(0, 100)}`,
            );
            const result = await callSkill(toolName, toolArgs);
            const resultContent = formatSkillResult(toolName, result);

            toolResults.push({
              type: "tool_result",
              tool_use_id: toolCall.id,
              content: resultContent,
            });
          } catch (e) {
            console.error(`[wrapper] #${reqId} skill error: ${toolName} - ${e.message}`);
            toolResults.push({
              type: "tool_result",
              tool_use_id: toolCall.id,
              content: `[${toolName} 錯誤] ${e.message}`,
            });
          }
        }

        // Add tool results to conversation
        allMessages.push({
          role: "user",
          content: toolResults,
        });

        // Continue loop to let Claude generate final response
        continue;
      }

      // Case 2: Claude generated final response (stop)
      if (finishReason === "stop") {
        const finalContent = content || "無法生成回應，請稍後再試。";
        console.log(`[wrapper] #${reqId} skill-tools final: ${finalContent.slice(0, 80)}`);

        // Store in memory
        if (userText && finalContent && finalContent.length > 10) {
          // storeMemory(userText, finalContent); // Mem0 removed
        }

        // Send response
        return sendDirectResponse(reqId, finalContent, wantsStream, res);
      }

      // Case 3: Unexpected finish reason
      console.warn(`[wrapper] #${reqId} unexpected finish_reason: ${finishReason}`);
      const fallbackContent = content || "系統暫時無法處理，請稍後再試。";
      return sendDirectResponse(reqId, fallbackContent, wantsStream, res);
    }

    // Max iterations exceeded
    console.error(`[wrapper] #${reqId} skill-tools max iterations (${maxIterations}) exceeded`);
    return sendDirectResponse(reqId, "系統達到最大處理次數，請簡化您的請求。", wantsStream, res);
  } catch (e) {
    console.error(`[wrapper] #${reqId} skill-tools error: ${e.message}`);
    metrics.errors++;

    // Fallback: call Claude without tools
    console.log(`[wrapper] #${reqId} skill-tools fallback to normal Claude`);
    const fallbackBody = prepareBody(parsedBody, skillContext, memoryContext);
    if (wantsStream) {
      streamPassthrough(reqId, fallbackBody, res, skillContext, memoryContext, userText);
    } else {
      forwardNonStreaming(reqId, fallbackBody, res, skillContext, memoryContext, userText);
    }
  }
}

// ─── Direct Response (for dev mode) ──────────────────────────────

function sendDirectResponse(reqId, content, wantsStream, res) {
  const responseId = "chatcmpl-dev-" + Math.random().toString(36).substr(2, 12);
  const created = Math.floor(Date.now() / 1000);

  if (wantsStream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const chunk = {
      id: responseId,
      object: "chat.completion.chunk",
      created,
      model: "claude-code-dev",
      choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);

    const done = {
      id: responseId,
      object: "chat.completion.chunk",
      created,
      model: "claude-code-dev",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };
    res.write(`data: ${JSON.stringify(done)}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  } else {
    const response = {
      id: responseId,
      object: "chat.completion",
      created,
      model: "claude-code-dev",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
  }

  console.log(
    `[wrapper] #${reqId} dev-mode response sent (${content.length} chars, stream=${wantsStream})`,
  );
}

// ─── Health & Metrics Endpoints ────────────────────────────────

function handleHealth(res) {
  const uptime = Math.floor((Date.now() - startedAt) / 1000);
  const health = {
    status: "ok",
    version: VERSION,
    uptime_seconds: uptime,
    uptime_human: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${uptime % 60}s`,
    requests_total: metrics.requests,
    model: "claude-haiku-4-5",
    upstream: `localhost:${UPSTREAM_PORT}`,
    skill_api: `localhost:${SKILL_API_PORT}`,
    mem0_api: `localhost:${MEM0_PORT}`,
    projects: PROJECT_ROUTES.length,
    action_words: DEV_ACTION_WORDS.length,
  };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(health, null, 2));
}

function handleMetrics(res) {
  const uptime = Math.floor((Date.now() - startedAt) / 1000);
  const data = {
    uptime_seconds: uptime,
    ...metrics,
    rate_limits: {
      dev: { current: rateLimits.dev.hits.length, max: rateLimits.dev.max, window: "5min" },
      skill: { current: rateLimits.skill.hits.length, max: rateLimits.skill.max, window: "1min" },
    },
    distribution:
      metrics.requests > 0
        ? {
            dev_pct: ((metrics.devMode / metrics.requests) * 100).toFixed(1) + "%",
            skill_pct: ((metrics.skillCalls / metrics.requests) * 100).toFixed(1) + "%",
            cli_pct: ((metrics.cliCalls / metrics.requests) * 100).toFixed(1) + "%",
            progress_pct: ((metrics.progressQueries / metrics.requests) * 100).toFixed(1) + "%",
            normal_pct: ((metrics.normalChat / metrics.requests) * 100).toFixed(1) + "%",
            error_pct: ((metrics.errors / metrics.requests) * 100).toFixed(1) + "%",
          }
        : null,
    ollama: ollamaRouter.getStats(),
    memory: {
      searches: metrics.memorySearches,
      adds: metrics.memoryAdds,
      errors: metrics.memoryErrors,
    },
  };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data, null, 2));
}

// System metrics proxy endpoint
function handleSystemMetrics(res) {
  const opts = {
    hostname: "localhost",
    port: 9090,
    path: "/metrics",
    method: "GET",
    timeout: 5000,
  };
  const proxyReq = http.request(opts, (proxyRes) => {
    let data = "";
    proxyRes.on("data", (chunk) => (data += chunk));
    proxyRes.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(data);
    });
  });
  proxyReq.on("error", (e) => {
    console.error("[wrapper] system metrics proxy error:", e.message);
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "System metrics unavailable: " + e.message }));
  });
  proxyReq.end();
}

// ─── Model Usage Endpoint ─────────────────────────────────────

function handleModelUsage(res) {
  const os = ollamaRouter.getStats();
  const data = {
    ollama: {
      model: ollamaRouter.OLLAMA_MODEL,
      calls: os.total,
      success: os.success,
      timeout: os.timeout,
      error: os.error,
      fallback: os.fallback,
      qualityReject: os.qualityReject,
      avgLatency: os.avgLatency,
      successRate: os.successRate,
    },
    claude: {
      calls: metrics.normalChat - metrics.ollamaRouted,
      fromFallback: metrics.ollamaFallback,
    },
    routing: {
      totalNormalChat: metrics.normalChat,
      ollamaRouted: metrics.ollamaRouted,
      ollamaFallback: metrics.ollamaFallback,
      ollamaPct:
        metrics.normalChat > 0
          ? ((metrics.ollamaRouted / metrics.normalChat) * 100).toFixed(1) + "%"
          : "N/A",
    },
  };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data, null, 2));
}

// ─── Server ────────────────────────────────────────────────────

// --- Embeddings proxy to Ollama ---
function proxyEmbeddingsToOllama(req, res) {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Invalid JSON" } }));
    }
    parsed.model = "nomic-embed-text";
    const data = JSON.stringify(parsed);
    const opts = {
      hostname: "localhost",
      port: 11434,
      path: "/v1/embeddings",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      timeout: 30000,
    };
    const proxyReq = http.request(opts, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on("error", (e) => {
      console.error("[wrapper] embeddings proxy error:", e.message);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ error: { message: "Ollama embeddings unavailable: " + e.message } }),
      );
    });
    proxyReq.write(data);
    proxyReq.end();
  });
}

// --- Wake Event API (Zero-Polling Architecture) ---

const WAKE_EVENT_LOG = path.join(
  process.env.HOME || "/root",
  ".claude",
  "logs",
  "wake-events.jsonl",
);
const SESSION_STATE_DIR = path.join(process.env.HOME || "/root", ".claude", "session-state");

function handleWakeEvent(req, res) {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Invalid JSON" }));
    }
    const { event_type, task_id, status, timestamp } = parsed;
    const received_at = new Date().toISOString();
    console.log("[wake-event] Received:", event_type, "task:", task_id, "status:", status);
    const logEntry =
      JSON.stringify({
        ts: received_at,
        event_type: event_type || "unknown",
        task_id: task_id || null,
        status: status || null,
        source_ts: timestamp || null,
      }) + "\n";
    try {
      fs.mkdirSync(path.dirname(WAKE_EVENT_LOG), { recursive: true });
      fs.appendFile(WAKE_EVENT_LOG, logEntry, () => {});
    } catch (e) {
      console.error("[wake-event] Log write failed:", e.message);
    }
    let latestState = null;
    try {
      const latestPath = path.join(SESSION_STATE_DIR, "latest.json");
      if (fs.existsSync(latestPath)) {
        latestState = JSON.parse(fs.readFileSync(latestPath, "utf8"));
      }
    } catch (e) {
      console.warn("[wake-event] latest.json read failed:", e.message);
    }
    metrics.wakeEvents = (metrics.wakeEvents || 0) + 1;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        received_at,
        latest_state: latestState
          ? { taskId: latestState.taskId, status: latestState.status }
          : null,
      }),
    );
  });
}

const server = http.createServer((req, res) => {
  // P1.5: Initialize request metadata for structured timing
  initRequestMetadata(req);
  // P2.1: Log structured timing on response finish
  res.on("finish", () => logStructuredTiming(req, res));

  // ─── Control Plane Dashboard ───
  if (req.url === "/dashboard" && req.method === "GET") {
    try {
      const html = fs.readFileSync(
        "/Users/rexmacmini/openclaw/control-plane-dashboard.html",
        "utf8",
      );
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Dashboard file not found: " + e.message);
    }
    return;
  }

  // Routing events (last N)
  if (req.url.startsWith("/routing-events") && req.method === "GET") {
    const params = new URL(req.url, "http://localhost").searchParams;
    const limit = parseInt(params.get("limit")) || 50;
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    // Prefer in-memory, fallback to JSONL file
    let events = _routingEvents || [];
    if (events.length === 0) {
      try {
        const raw = fs.readFileSync(CP_EVENTS_PATH, "utf8").trim();
        events = raw
          .split("\n")
          .slice(-limit)
          .map((l) => {
            try {
              return JSON.parse(l);
            } catch {
              return null;
            }
          })
          .filter(Boolean);
      } catch {}
    }
    res.end(JSON.stringify(events.slice(-limit)));
    return;
  }

  // Mode history (last 100 from JSONL file)
  if (req.url === "/mode-history" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    try {
      const raw = fs.readFileSync(CP_MODE_HISTORY_PATH, "utf8").trim();
      const lines = raw
        .split("\n")
        .slice(-100)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      res.end(JSON.stringify(lines));
    } catch {
      res.end("[]");
    }
    return;
  }

  // Prediction accuracy stats
  if (req.url === "/prediction-stats" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    const accuracy =
      _predictionTracker.total > 0
        ? ((_predictionTracker.hits / _predictionTracker.total) * 100).toFixed(1)
        : "0.0";
    res.end(
      JSON.stringify({
        ..._predictionTracker,
        accuracy: accuracy + "%",
        falseWarmRate:
          _predictionTracker.total > 0
            ? ((_predictionTracker.falseWarms / _predictionTracker.total) * 100).toFixed(1) + "%"
            : "0.0%",
      }),
    );
    return;
  }

  // Health endpoint
  if (req.url === "/health" && req.method === "GET") {
    return handleHealth(res);
  }

  // Wake Event endpoint (Zero-Polling)
  if (req.url === "/api/wake-event" && req.method === "POST") {
    return handleWakeEvent(req, res);
  }

  // Metrics endpoint
  if (req.url === "/metrics" && req.method === "GET") {
    return handleMetrics(res);
  }

  // Routing stats — self-learning router visibility

  // Mode status — current momentum state
  if (req.url === "/mode-status" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(
      JSON.stringify(
        {
          activeMode: getActiveMode(),
          scores: _modeScores,
          adjustments: getModeAdjustments(getActiveMode()),
          lastIntent: _lastIntent,
        },
        null,
        2,
      ),
    );
    return;
  }

  // Task transitions — prediction data
  // Drift analysis
  if (req.url === "/drift-analysis" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(getDriftAnalysis()));
    return;
  }

  if (req.url === "/transitions" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    const data = loadTransitions();
    // Add prediction for each intent
    const enriched = {};
    for (const [intent, stats] of Object.entries(data)) {
      const total = (stats.dev_loop || 0) + (stats.session_bridge || 0);
      enriched[intent] = {
        ...stats,
        total,
        session_probability: total > 0 ? ((stats.session_bridge || 0) / total).toFixed(2) : "0.00",
        predicted_executor: predictExecutor(intent) || "dev_loop",
      };
    }
    res.end(JSON.stringify(enriched, null, 2));
    return;
  }

  if (req.url === "/routing-stats" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    const stats = loadRoutingStats();
    const enriched = {};
    for (const [intent, executors] of Object.entries(stats)) {
      enriched[intent] = {};
      for (const [exec, s] of Object.entries(executors)) {
        enriched[intent][exec] = { ...s, expected_cost: expectedCost(s).toFixed(1) };
      }
    }
    res.end(JSON.stringify(enriched, null, 2));
    return;
  }

  // System metrics proxy
  if (req.url === "/metrics/system" && req.method === "GET") {
    return handleSystemMetrics(res);
  }

  // Model usage stats
  if (
    (req.url === "/metrics/model-usage" || req.url === "/metrics/model") &&
    req.method === "GET"
  ) {
    return handleModelUsage(res);
  }

  // Decision engine stats
  if (req.url === "/metrics/decision" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(decisionEngine.getStats(), null, 2));
    return;
  }

  // Trace stats endpoint — recent traces summary
  if (req.url === "/metrics/traces" && req.method === "GET") {
    try {
      const data = fs.readFileSync(TRACE_LOG_PATH, "utf-8").trim().split("\n").slice(-100);
      const traces = data
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const executors = {};
      let totalMs = 0;
      let fallbacks = 0;
      for (const t of traces) {
        executors[t.executor] = (executors[t.executor] || 0) + 1;
        totalMs += t.total_ms || 0;
        if (t.fallback) {
          fallbacks++;
        }
      }
      const summary = {
        count: traces.length,
        avg_total_ms: traces.length ? Math.round(totalMs / traces.length) : 0,
        fallback_rate: traces.length ? ((fallbacks / traces.length) * 100).toFixed(1) + "%" : "0%",
        executors,
        recent: traces.slice(-5).map((t) => ({
          trace_id: t.trace_id,
          executor: t.executor,
          total_ms: t.total_ms,
          route_path: t.route_path,
        })),
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(summary, null, 2));
    } catch (e) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ count: 0, message: "No traces yet" }));
    }
    return;
  }

  // Spec-Driven Development endpoints
  if (req.url === "/api/spec/create" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const spec = JSON.parse(body);
        const specId = specManager.createSpec(spec);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: specId, status: "draft" }, null, 2));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.url.match(/^\/api\/spec\/([\w-]+)$/) && req.method === "PATCH") {
    const specId = req.url.split("/")[3];
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const changes = JSON.parse(body);
        const updated = specManager.updateSpec(specId, changes);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(updated, null, 2));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.url.match(/^\/api\/spec\/([\w-]+)\/history$/) && req.method === "GET") {
    const specId = req.url.split("/")[3];
    try {
      const history = specManager.getSpecHistory(specId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ history }, null, 2));
    } catch (e) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.url === "/api/spec/stats" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(specManager.getStats(), null, 2));
    return;
  }

  if (req.url === "/api/spec/decision/record" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const decision = JSON.parse(body);
        const decId = specManager.recordDecision(decision);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: decId }, null, 2));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // WebSearch endpoint
  if (req.url === "/api/websearch" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { query } = JSON.parse(body);
        const result = await webSearchService.search(query);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result, null, 2));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // WebSearch stats
  if (req.url === "/api/websearch/stats" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(webSearchService.getStats(), null, 2));
    return;
  }

  // Intent Classification endpoint
  if (req.url === "/api/intent/classify" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { message } = JSON.parse(body);
        const result = await intentDetector.classify(message);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result, null, 2));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Intent metrics
  if (req.url === "/api/intent/stats" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(intentDetector.getStats(), null, 2));
    return;
  }

  // Multi-Agent system info
  if (req.url === "/api/agents/list" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ agents: agentRouter.getAgentStats() }, null, 2));
    return;
  }

  // Agent routing (intent → agent)
  if (req.url === "/api/agents/route" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { message, intent, confidence } = JSON.parse(body);
        const routing = agentRouter.routeMessage(message, intent, confidence);
        agentRouter.logRouting(routing, AGENT_ROUTING_LOG);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(routing, null, 2));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Model Failover metrics
  if (req.url === "/metrics/failover" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(failover.getStats(), null, 2));
    return;
  }

  // Embeddings endpoint - proxy to Ollama nomic-embed-text
  if (req.url === "/v1/embeddings" && req.method === "POST") {
    return proxyEmbeddingsToOllama(req, res);
  }

  // System metrics API proxy
  if (req.url === "/api/metrics/system" && req.method === "GET") {
    const opts = {
      hostname: "127.0.0.1",
      port: 9090,
      path: "/metrics",
      method: "GET",
      timeout: 5000,
    };
    const proxyReq = http.request(opts, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on("error", (e) => {
      console.error("[wrapper] metrics proxy error:", e.message);
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "System metrics unavailable" }));
    });
    return proxyReq.end();
  }

  // Session Bridge forwarding (:7788)
  if (
    req.url.startsWith("/session/") ||
    req.url === "/session/list" ||
    (req.url.startsWith("/telegram/") && req.method === "POST")
  ) {
    const bridgeOpts = {
      hostname: "127.0.0.1",
      port: 7788,
      path: req.url,
      method: req.method,
      headers: req.headers,
      timeout: 120000,
    };
    const bridgeReq = http.request(bridgeOpts, (bridgeRes) => {
      res.writeHead(bridgeRes.statusCode, bridgeRes.headers);
      bridgeRes.pipe(res);
    });
    bridgeReq.on("error", (e) => {
      console.error("[wrapper] session-bridge proxy error:", e.message);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Session bridge unavailable: " + e.message }));
    });
    req.pipe(bridgeReq);
    return;
  }

  // Orchestrator forwarding (/orchestrate/* -> :7789)
  if (req.url.startsWith("/orchestrate/")) {
    const orchPath = req.url.replace("/orchestrate", "");
    const orchOpts = {
      hostname: "127.0.0.1",
      port: 7789,
      path: orchPath || "/health",
      method: req.method,
      headers: req.headers,
      timeout: 120000,
    };
    const orchReq = http.request(orchOpts, (orchRes) => {
      res.writeHead(orchRes.statusCode, orchRes.headers);
      orchRes.pipe(res);
    });
    orchReq.on("error", (e) => {
      console.error("[wrapper] orchestrator proxy error:", e.message);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Orchestrator unavailable: " + e.message }));
    });
    orchReq.on("timeout", () => {
      orchReq.destroy();
      res.writeHead(504, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Orchestrator timeout" }));
    });
    req.pipe(orchReq);
    return;
  }

  if (!req.url.startsWith("/v1/chat/completions")) {
    return proxyPassThrough(req, res);
  }

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    metrics.requests++;
    const reqId = metrics.requests;

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Invalid JSON" } }));
    }

    const hasTools = parsed.tools && parsed.tools.length > 0;
    const wantsStream = parsed.stream === true;
    const msgCount = parsed.messages?.length || 0;
    const lastRole = parsed.messages?.[msgCount - 1]?.role || "?";

    console.log(
      `[wrapper] #${reqId} msgs=${msgCount} lastRole=${lastRole} tools=${hasTools} stream=${wantsStream}`,
    );

    void handleChatCompletion(reqId, parsed, wantsStream, req, res);
  });
});

// P1.9 + P1.5: Error handling and EADDRINUSE prevention
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[wrapper] Port :${LISTEN_PORT} already in use. Attempting to kill existing process...`,
    );
    try {
      const { execSync } = require("child_process");
      execSync(`/usr/sbin/lsof -ti :${LISTEN_PORT} | xargs kill -9 2>/dev/null || true`);
      console.log(`[wrapper] Killed process on port :${LISTEN_PORT}, retrying in 1s...`);
      setTimeout(() => server.listen(LISTEN_PORT, "0.0.0.0"), 1000);
    } catch (e) {
      console.error(`[wrapper] Failed to resolve EADDRINUSE: ${e.message}`);
      process.exit(1);
    }
  } else {
    console.error(`[wrapper] Server error: ${err.message}`);
    process.exit(1);
  }
});

// P0.2: 初始化 lastDevProject 後再啟動 server
void (async () => {
  try {
    // P1.4: Validate configuration at startup
    config.validate();

    const restoredProject = await initializeLastDevProject();
    if (restoredProject) {
      lastDevProject = restoredProject;
      console.log(`[wrapper] P0.2: Restored lastDevProject from Redis/session: ${restoredProject}`);
    }
  } catch (e) {
    console.error(`[wrapper] P0.2: Initialization error: ${e.message}`);
  }

  server.listen(LISTEN_PORT, "0.0.0.0", () => {
    console.log(`[wrapper] Tool wrapper proxy v${VERSION} listening on :${LISTEN_PORT}`);
    console.log(`[wrapper] Upstream: localhost:${UPSTREAM_PORT}`);
    console.log(`[wrapper] Skill API: localhost:${SKILL_API_PORT}`);
    console.log(`[wrapper] Mem0 API: localhost:${MEM0_PORT}`);
    console.log(`[wrapper] Skills: ${SKILL_ROUTES.map((r) => r.name).join(", ")}`);
    console.log(`[wrapper] CLI tools: ${CLI_ROUTES.map((r) => r.name).join(", ")}`);
    console.log(
      `[wrapper] Dev mode v10.3: ${DEV_ACTION_WORDS.length} action words, ${PROJECT_ROUTES.length} projects`,
    );
    console.log(`[wrapper] Dev tools: ${DEV_TOOLS}`);
    console.log(
      `[wrapper] Dev timeout: ${DEV_TIMEOUT_MS / 1000}s, max output: ${DEV_MAX_OUTPUT} chars`,
    );
    console.log(
      `[wrapper] Rate limits: dev=${rateLimits.dev.max}/5min, skill=${rateLimits.skill.max}/min`,
    );
    console.log(
      `[wrapper] Ollama: ${ollamaRouter.OLLAMA_MODEL} at localhost:11434 (timeout: ${ollamaRouter.OLLAMA_TIMEOUT / 1000}s)`,
    );
    console.log(
      `[wrapper] Mode: streaming + smart-intent + CLI + dev-mode + mem0 + ollama-first routing + P0.2`,
    );
    console.log(
      `[wrapper] Endpoints: /health, /metrics, /metrics/model-usage, /metrics/failover, /metrics/traces, /api/agents/list, /api/agents/route, /api/intent/classify, /api/intent/stats, /api/websearch, /api/websearch/stats, /api/spec/*, /api/wake-event`,
    );
  });
})();
// P0.3 test
