# 5 Gap 补齐 — 全生命周期测试报告

**日期:** 2026-03-05
**分支:** `feat/dashboard-agent-era-v2`
**Gateway:** `pnpm gateway:dev` (port 19001)
**Bot:** `@openfinclaw_bot`

---

## 1. 设计目标 (Plan)

来自 `peaceful-jingling-penguin.md` 的 5 Gap 补齐方案：

| Gap       | 目标                                                                        | 预估 LOC |
| --------- | --------------------------------------------------------------------------- | -------- |
| **Gap 1** | HEARTBEAT.md 模板加载 — 将 `HEARTBEAT-FINANCIAL.md` 检查清单注入 LLM 提示词 | ~50      |
| **Gap 2** | Heartbeat 完成确认 — 追踪 AgentWakeBridge 发出的唤醒事件是否已被处理        | ~100     |
| **Gap 3** | L3 Risk Circuit Breaker — L3 实盘策略累计亏损超阈值时自动熔断               | ~150     |
| **Gap 4** | Regime Detection Wiring — PaperScheduler 使用真实 regime 替代硬编码         | ~20      |
| **Gap 5** | L3 Live Reconciler — 对比 L3 Live 仓位 vs Paper 影子仓位，检测偏离          | ~200     |

**总计:** ~520 LOC 生产代码 + ~300 LOC 测试

---

## 2. 实际变更

### 新建文件 (生产代码)

| 文件                                   | Gap   | LOC  | 用途                                         |
| -------------------------------------- | ----- | ---- | -------------------------------------------- |
| `src/execution/live-health-monitor.ts` | Gap 3 | ~120 | L3 实盘累计亏损检测 + circuit breaker        |
| `src/execution/live-reconciler.ts`     | Gap 5 | ~170 | L3 Live vs Paper 仓位偏离检测                |
| `src/core/telegram-polling.ts`         | infra | ~134 | Telegram callback_query polling + 409 安全网 |

### 修改文件 (生产代码)

| 文件                            | Gap       | 变更                                                                                    |
| ------------------------------- | --------- | --------------------------------------------------------------------------------------- |
| `src/core/prompt-context.ts`    | Gap 1     | +`heartbeatChecklist` 字段 → 注入 Financial Heartbeat Checklist                         |
| `src/core/agent-wake-bridge.ts` | Gap 2     | +`pendingWakes` Map + `reconcilePending()` + `getPending()`                             |
| `src/core/lifecycle-engine.ts`  | Gap 2,3,5 | +liveHealthMonitor.check() + liveReconciler.reconcile() + wakeBridge.reconcilePending() |
| `src/paper/paper-scheduler.ts`  | Gap 4     | +`regimeDetectorResolver` → 真实 regime 替代硬编码 "sideways"                           |
| `index.ts`                      | All       | 实例化 LiveHealthMonitor, LiveReconciler; heartbeat 模板加载; regime wiring             |
| `src/core/route-handlers.ts`    | —         | Flow dashboard JSON API 端点                                                            |
| `src/core/routes-ai-chat.ts`    | —         | AI Chat 路由增强                                                                        |
| `src/core/routes-setting.ts`    | —         | Setting 配置路由增强                                                                    |
| `src/fund/routes-packs.ts`      | —         | Fund pack 路由                                                                          |
| `dashboard/*.html/css`          | —         | Dashboard UI 增强 (overview, strategy, flow, setting, trader)                           |
| `test/e2e/fullchain/harness.ts` | —         | 测试 harness 增加 LiveHealthMonitor, LiveReconciler, wakeBridge                         |

**总变更:** 19 files changed, 756 insertions(+), 36 deletions(-)

### 新建文件 (测试)

| 文件                                                    | Gap       | Tests | 类型              |
| ------------------------------------------------------- | --------- | ----- | ----------------- |
| `test/unit/heartbeat-checklist.test.ts`                 | Gap 1     | 4     | L1 unit           |
| `test/unit/wake-confirmation.test.ts`                   | Gap 2     | 4     | L1 unit           |
| `test/unit/live-health-monitor.test.ts`                 | Gap 3     | 4     | L1 unit           |
| `test/unit/regime-wiring.test.ts`                       | Gap 4     | 3     | L1 unit           |
| `test/unit/live-reconciler.test.ts`                     | Gap 5     | 6     | L1 unit           |
| `test/unit/dedup-filter.test.ts`                        | ideation  | 7     | L1 unit           |
| `test/unit/ideation-engine.test.ts`                     | ideation  | 6     | L1 unit           |
| `test/unit/ideation-integration.test.ts`                | ideation  | 3     | L1 unit           |
| `test/unit/ideation-scheduler.test.ts`                  | ideation  | 7     | L1 unit           |
| `test/unit/market-scanner.test.ts`                      | ideation  | 6     | L1 unit           |
| `test/e2e/fullchain/scenario-5gap-integration.test.ts`  | All 5     | 9     | L2/L3 integration |
| `test/e2e/fullchain/scenario-ideation.test.ts`          | ideation  | 4     | L2/L3 integration |
| `test/e2e/fullchain/scenario-lifecycle-journey.test.ts` | lifecycle | 15    | L2/L3 integration |
| `findoo-backtest-plugin/src/config.test.ts`             | backtest  | 12    | L1 unit           |

---

## 3. 测试结果 (L1 → L5)

### L1 — 单元测试 (Mock 依赖)

```
14 test files, 90 tests — ALL PASSED

  heartbeat-checklist.test.ts         4 tests   2ms
  wake-confirmation.test.ts           4 tests   6ms
  regime-wiring.test.ts               3 tests   4ms
  live-health-monitor.test.ts         4 tests  27ms
  live-reconciler.test.ts             6 tests  34ms
  dedup-filter.test.ts                7 tests   3ms
  ideation-engine.test.ts             6 tests   5ms
  ideation-integration.test.ts        3 tests  16ms
  ideation-scheduler.test.ts          7 tests   5ms
  market-scanner.test.ts              6 tests  12ms
  scenario-5gap-integration.test.ts   9 tests  47ms
  scenario-ideation.test.ts           4 tests  38ms
  scenario-lifecycle-journey.test.ts 15 tests  15165ms
  config.test.ts (backtest)          12 tests   4ms
```

### L2/L3 — 集成测试 (真实 SQLite + HTTP Server)

| 测试文件                             | Tests | 状态 | 覆盖的 Gap                              |
| ------------------------------------ | ----- | ---- | --------------------------------------- |
| `scenario-5gap-integration.test.ts`  | 9     | PASS | Gap 1-5 全覆盖                          |
| `scenario-lifecycle-journey.test.ts` | 15    | PASS | Flow dashboard + lifecycle + cold start |
| `scenario-ideation.test.ts`          | 4     | PASS | Ideation engine pipeline                |

**细节 (5 Gap Integration):**

- Gap 1: buildFinancialContext + heartbeatChecklist 注入验证
- Gap 2: wake → reconcilePending cycle 1 (keep) → cycle 2 (resolve)
- Gap 2: LifecycleEngine.runCycle() 自动调用 reconcilePending
- Gap 3: LiveHealthMonitor 无 L3 → healthy; mock 20% 亏损 → circuitBroken
- Gap 4: PaperScheduler + regimeDetectorResolver → "bull" 传递到 onBar
- Gap 5: LiveReconciler 无 L3 → empty; mock drift 50% → critical + consecutive tracking
- Cross-Gap: LifecycleEngine full cycle → promotion + wake + reconcile flow

### L4 — Gateway E2E (真实 Gateway 进程)

| 验证项                | 路径/方式                               | 状态                            |
| --------------------- | --------------------------------------- | ------------------------------- |
| Dashboard Overview    | `/dashboard/overview`                   | 200 OK, text/html               |
| Dashboard Strategy    | `/dashboard/strategy`                   | 200 OK, text/html               |
| Dashboard Trader      | `/dashboard/trader`                     | 200 OK, text/html               |
| Dashboard Flow        | `/dashboard/flow`                       | 200 OK, text/html               |
| Dashboard Setting     | `/dashboard/setting`                    | 200 OK, text/html               |
| JSON: Config          | `/api/v1/finance/config`                | 200 OK                          |
| JSON: Trading         | `/api/v1/finance/trading`               | 200 OK                          |
| JSON: Strategies      | `/api/v1/finance/strategies`            | 200 OK                          |
| JSON: Flow            | `/api/v1/finance/dashboard/flow`        | 200 OK                          |
| JSON: Daily Brief     | `/api/v1/finance/daily-brief`           | 200 OK                          |
| JSON: Exchange Health | `/api/v1/finance/exchange-health`       | 200 OK                          |
| SSE: Activity         | `/api/v1/finance/agent-activity/stream` | SSE data (24 entries)           |
| SSE: Strategy         | `/api/v1/finance/strategy/stream`       | SSE data                        |
| SSE: Trading          | `/api/v1/finance/trading/stream`        | SSE data                        |
| SSE: Events           | `/api/v1/finance/events/stream`         | SSE data                        |
| Telegram              | `@openfinclaw_bot` sendMessage          | OK (message_id=7)               |
| Telegram Polling      | Grammy bot.start()                      | "Bot started successfully"      |
| Heartbeat             | interval=300s, model=kimi-k2.5          | started                         |
| Health Monitor        | interval=300s, grace=60s                | started                         |
| fin\_\* Skills        | 6+ tools registered                     | fin_setting, fin_strategy, etc. |
| Flow API Data         | 5 strategies, engine running            | verified                        |
| Activity Stream       | categories: heartbeat, wake             | verified                        |

### L5 — Playwright Browser E2E

| 页面     | 截图文件                | 关键验证点                                                                                                                                |
| -------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Overview | `l5-overview-final.png` | 3-column 布局, Equity Curve, Strategy Pipeline L0-L3, Risk NORMAL, Trading Enabled, 5 strategies, SSE 3 connections                       |
| Flow     | `l5-flow-final.png`     | L0 Incubate (0) → L1 Backtest (5) → L2 Paper (0) → L3 Live (0), 5 策略卡片 + Sharpe/DD, Agent Activity 24 entries, Engine Running         |
| Strategy | `l5-strategy-final.png` | Strategy Summary, Pipeline 可视化, Raceboard 表格 (14 columns), 5 策略 with Return/Sharpe/MaxDD, Filter by Market/Status, Evolution Stats |
| Setting  | `l5-setting-final.png`  | 7 配置面板 (Exchanges/Risk/Agent/Gates/Notifications/Plugins/Advanced), Binance testnet, Risk presets, Promotion gate thresholds L0→L3    |
| Trader   | (HTTP 200 verified)     | —                                                                                                                                         |

---

## 4. 未测试 / 待改进

### 尚未完成的测试

| 项目                          | 层级 | 原因                                                                     | 优先级 |
| ----------------------------- | ---- | ------------------------------------------------------------------------ | ------ |
| **LLM tool_use 全链路**       | L4   | Heartbeat 每 5min 触发，需等待完整 cycle 并验证 LLM 调用了 fin\_\* tools | P1     |
| **Telegram callback_query**   | L4   | 需要用户在 Telegram 点击 inline button 触发审批流程                      | P2     |
| **L3 Live 真实执行**          | L4   | 无 L3 策略，无法验证 circuit breaker / reconciler 在真实环境的效果       | P2     |
| **Regime Detection 真实数据** | L4   | datahub RegimeDetector 需要真实 OHLCV 数据 → PaperScheduler              | P3     |
| **Dashboard 交互操作**        | L5   | Place Order / Set Alert / Create Strategy 等交互按钮未测试点击流程       | P2     |
| **SSE 实时更新**              | L5   | 浏览器中 SSE 连接建立后的数据推送没有验证 DOM 实时更新                   | P3     |
| **多浏览器/移动端**           | L5   | 只测试了 Chrome desktop viewport                                         | P4     |

### 已知问题

| 问题                       | 状态    | 说明                                                                      |
| -------------------------- | ------- | ------------------------------------------------------------------------- |
| Telegram 409 Conflict      | FIXED   | 添加 `unhandledRejection` 安全网，不再导致进程崩溃                        |
| `/dashboard/fund` 重复注册 | WARNING | gateway 日志 `http route already registered: /dashboard/fund`，不影响功能 |
| Dev/Prod config 不同步     | FIXED   | `~/.openclaw-dev/openclaw.json` 已与 prod 同步                            |

---

## 5. 验收矩阵

| 层级   | 名称           | 测试数    | 状态    | 备注                                                        |
| ------ | -------------- | --------- | ------- | ----------------------------------------------------------- |
| **L1** | 合约测试       | 90        | PASS    | Mock 依赖, vi.fn(), 边界条件                                |
| **L2** | 集成测试       | 28        | PASS    | 真实 SQLite, 真实 HTTP server, 模块间数据流                 |
| **L3** | Gateway E2E    | 22 checks | PASS    | 真实 gateway 进程, 端点 + SSE + Telegram                    |
| **L4** | 全链路 LLM     | partial   | PARTIAL | Heartbeat started, skills registered; 未等到完整 LLM cycle  |
| **L5** | Playwright E2E | 5 pages   | PASS    | 4 pages 截图 + accessibility snapshot, 1 page HTTP verified |

**总计: 90 tests passed, 22 L4 checks passed, 5 L5 pages verified**
