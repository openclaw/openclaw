/**
 * task_router.ts — 三層級聯路由器（⑫）
 *
 * L1（10ms）：關鍵字正規表示式 → 直接命中
 * L2（100ms）：語義向量搜尋（TF-IDF / Ollama / Xenova）
 * L3（1s）   ：本地 Ollama LLM fallback 分類（若前兩層未命中）
 *
 * 所有層都是同步優先（L1 純同步），L2/L3 是 async fallback。
 */

import type { TaskPackage, TaskRoute, RiskClass } from "./task_schema.js";

// ── 風險分類 ────────────────────────────────────────────────────────────────

const APPROVAL_REQUIRED_RISKS: ReadonlySet<RiskClass> = new Set([
  "external_write",
  "trading_payment",
  "credential",
]);

export function classifyRisk(task: string): RiskClass {
  const lower = task.toLowerCase();
  if (/credential|secret|password|api.?key|token/i.test(lower)) {
    return "credential";
  }
  if (/trade|payment|buy|sell|order|交易|付款/i.test(lower)) {
    return "trading_payment";
  }
  if (/http|curl|fetch|webhook|email|send|push|外發/i.test(lower)) {
    return "external_write";
  }
  if (/write|save|delete|rm|modify|edit|寫入|刪除|修改/i.test(lower)) {
    return "local_write";
  }
  return "read_only";
}

export function isApprovalRequired(risk: RiskClass): boolean {
  return APPROVAL_REQUIRED_RISKS.has(risk);
}

// ── L1：關鍵字路由（同步，10ms）────────────────────────────────────────────

/**
 * 路由規則表：每條規則含 pattern + route + 優先級（越高越先匹配）
 * 未命中回傳 null，交由 L2 處理。
 */
const L1_RULES: Array<{ pattern: RegExp; route: TaskRoute; priority: number }> = [
  // 高危風險（最高優先）
  { pattern: /credential|secret|password|api.?key/i, route: "manual_approval", priority: 100 },
  { pattern: /trade|payment|交易|付款/i, route: "manual_approval", priority: 100 },
  { pattern: /外發|push.*webhook|send.*email/i, route: "manual_approval", priority: 100 },

  // 大型 repo 操作 → Claude Code CLI
  { pattern: /大型\s*repo|scan\s+all|全倉庫|全文搜尋/i, route: "claude_code_cli", priority: 80 },
  { pattern: /架構|architecture|system design/i, route: "claude_code_cli", priority: 70 },
  { pattern: /review|code review|審查/i, route: "claude_code_cli", priority: 70 },

  // 程式碼生成 / 技術實作 → Codex CLI
  { pattern: /程式碼|寫.*function|implement|generate.*code/i, route: "codex_cli", priority: 60 },
  { pattern: /test|測試|unit test|e2e/i, route: "codex_cli", priority: 60 },
  { pattern: /重構|refactor|optimize.*code/i, route: "codex_cli", priority: 60 },

  // 輕量分類 / 摘要 → 本地模型（省費）
  { pattern: /分類|classify|categorize/i, route: "local_model", priority: 40 },
  { pattern: /摘要|summarize|summary/i, route: "local_model", priority: 40 },
  { pattern: /翻譯|translate|translation/i, route: "local_model", priority: 40 },
];

/** L1 路由（同步）— 回傳命中的 route 或 null */
export function routeL1(task: string): TaskRoute | null {
  const matched = L1_RULES.filter((r) => r.pattern.test(task)).sort(
    (a, b) => b.priority - a.priority,
  )[0];
  return matched?.route ?? null;
}

// ── L2：語義向量路由（async，100ms）──────────────────────────────────────────

/**
 * 語義標籤庫：每個路由的代表性描述，供向量相似度比對。
 */
const L2_ROUTE_DESCRIPTIONS: Record<TaskRoute, string> = {
  manual_approval: "high risk dangerous credential secret payment external API trade",
  claude_code_cli: "large repository architecture review design pattern analysis codebase",
  codex_cli: "write code implement function generate unit test refactor debug fix",
  local_model: "classify summarize categorize translate short text lightweight",
  api: "backend service API endpoint cloud infrastructure deployment",
  desktop_done: "already completed done by desktop",
};

/** L2 語義路由（async）— 用 TF-IDF/Ollama 向量搜尋 */
export async function routeL2(task: string): Promise<TaskRoute | null> {
  try {
    // 動態 import embedding 模組（避免啟動時強制載入）
    const { getEmbedder } = await import(
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore — 路徑解析在 worktree 環境下正確
      "../../extensions/evolution-learning/src/embedding.js"
    );
    const corpus = Object.values(L2_ROUTE_DESCRIPTIONS);
    const routes = Object.keys(L2_ROUTE_DESCRIPTIONS) as TaskRoute[];

    const embedder = await getEmbedder({}, corpus);
    const queryVec = await embedder.embed(task);
    const candidateVecs = await Promise.all(corpus.map((d) => embedder.embed(d)));

    const topMatches = embedder.topK(queryVec, candidateVecs, 1);
    if (topMatches.length === 0 || topMatches[0]![1] < 0.3) return null;

    return routes[topMatches[0]![0]] ?? null;
  } catch {
    return null;
  }
}

// ── L3：LLM fallback 路由（async，1s）────────────────────────────────────────

const L3_PROMPT = (task: string) =>
  `
你是任務路由分類器。根據以下任務描述，選出最適合的執行路由（只回傳一個詞）：

路由選項：
- manual_approval：高風險（含 credential/payment/外部推送）
- claude_code_cli：大型 repo 分析、架構設計、Code Review
- codex_cli：程式碼生成、單元測試、重構
- local_model：輕量分類、摘要、翻譯
- api：後端服務、API、雲端部署

任務：${task}

只輸出路由名稱（不含空格或標點），例如：codex_cli`.trim();

/** L3 Ollama LLM fallback 路由 */
export async function routeL3(task: string): Promise<TaskRoute> {
  const ollamaUrl = process.env.OLLAMA_URL ?? "http://localhost:11434";
  const model = process.env.OLLAMA_ROUTE_MODEL ?? "llama3.2";

  try {
    const res = await fetch(`${ollamaUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: L3_PROMPT(task), stream: false }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`Ollama L3 HTTP ${res.status}`);
    const json = (await res.json()) as { response?: string };
    const answer = (json.response ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z_]/g, "");

    const valid: TaskRoute[] = [
      "manual_approval",
      "claude_code_cli",
      "codex_cli",
      "local_model",
      "api",
    ];
    if (valid.includes(answer as TaskRoute)) return answer as TaskRoute;
  } catch {
    // Ollama 不可用，靜默 fallback
  }

  return "claude_code_cli"; // 最終 fallback
}

// ── 主要導出：routeTask（三層瀑布）──────────────────────────────────────────

export async function routeTask(pkg: TaskPackage): Promise<TaskRoute> {
  // 風險守衛（最高優先）
  if (isApprovalRequired(pkg.riskClass)) {
    return "manual_approval";
  }

  // L1：10ms 關鍵字
  const l1 = routeL1(pkg.task);
  if (l1 && l1 !== "manual_approval") return l1;
  if (l1 === "manual_approval") return "manual_approval";

  // L2：100ms 語義向量
  const l2 = await routeL2(pkg.task);
  if (l2) return l2;

  // L3：1s LLM fallback
  return routeL3(pkg.task);
}

/** 同步版本（僅 L1，供不支援 async 的呼叫者使用）*/
export function routeTaskSync(pkg: TaskPackage): TaskRoute {
  if (isApprovalRequired(pkg.riskClass)) return "manual_approval";
  return routeL1(pkg.task) ?? "claude_code_cli";
}
