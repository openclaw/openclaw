# Phase E: 能力缺口补充计划

> **背景**: Phase C/D 完成后，findoo-trader-plugin 完全覆盖了 5 个核心扩展（fin-core, fin-trading, fin-paper-trading, fin-strategy-engine, fin-fund-manager），242 测试全绿。但 6 个辅助扩展的 23 个 AI tools + 8 services + 3 hooks 随旧目录删除而丢失。

---

## 一、能力缺口总览

| 优先级 | 扩展                | 缺失 AI Tools | 缺失 Services               | 影响                                                 |
| ------ | ------------------- | ------------- | --------------------------- | ---------------------------------------------------- |
| **P0** | fin-monitoring      | 4             | 2 (alert-engine, scheduler) | dashboard alert routes 空转，data-gathering 6 处引用 |
| **P0** | fin-portfolio       | 5             | 0                           | 用户无法通过 AI 查看跨交易所持仓/余额                |
| **P1** | fin-market-data     | 4             | 0                           | 部分被 datahub 替代，缺 orderbook + overview         |
| **P2** | fin-strategy-memory | 4             | 3 + 3 hooks                 | 交易记忆/学习系统，含 before_prompt_build            |
| **P3** | fin-info-feed       | 3             | 1                           | 新闻/KOL 信息流                                      |
| **P3** | fin-expert-sdk      | 3             | 0                           | 外部专家 API 桥接（stub 为主）                       |

---

## 二、P0 详细分析

### P0-1: fin-monitoring → 告警系统

**问题**: findoo-trader-plugin 的 `routes-alerts.ts` 有 3 个 HTTP 端点 + `data-gathering.ts` 有 3 处调用 `runtime.services.get("fin-alert-engine")`，但 AlertEngine 实体已不存在。

**缺失工具**:

- `fin_set_alert` — 创建价格/P&L/技术指标告警
- `fin_list_alerts` — 列出所有告警（支持过滤）
- `fin_remove_alert` — 移除告警
- `fin_monitor_run_checks` — 手动触发告警检查

**缺失 Services**:

- `fin-alert-engine` — 告警规则存储 + 触发判断
- `fin-monitoring-scheduler` — 后台定时轮询（默认 5min interval）

**方案**: 在 `findoo-trader-plugin/src/monitoring/` 下新建模块

- `alert-engine.ts` — AlertEngine class（SQLite 存储告警规则）
- `monitoring-scheduler.ts` — setInterval 定时检查
- `tools.ts` — 4 个 AI tools
- 在 index.ts 中注册 `fin-alert-engine` + `fin-monitoring-scheduler` services
- 预计 ~400 LOC + ~200 LOC tests

**依赖**: ExchangeRegistry（获取价格）、DataProvider（技术指标）

### P0-2: fin-portfolio → 跨交易所组合视图

**问题**: 用户无法通过 AI 工具查询"我的总资产是多少"、"所有交易所的持仓"等。

**缺失工具**:

- `fin_portfolio_view` — 跨交易所余额聚合 + 总资产
- `fin_portfolio_history` — 组合历史价值快照
- `fin_exchange_balance` — 单交易所余额详情
- `fin_positions` — 跨交易所实时持仓
- `fin_order_history` — 历史订单查询

**方案**: 在 `findoo-trader-plugin/src/portfolio/` 下新建模块

- `portfolio-aggregator.ts` — 跨交易所数据聚合
- `portfolio-store.ts` — 历史快照 SQLite 存储
- `tools.ts` — 5 个 AI tools
- 预计 ~350 LOC + ~150 LOC tests

**依赖**: ExchangeRegistry + LiveExecutor（已存在）

**注意**: `gatherLiveTradingData()` 已实现余额/持仓聚合逻辑，portfolio tools 可复用。

---

## 三、P1 详细分析

### P1-1: fin-market-data → 市场数据查询

**现状**: findoo-datahub-plugin 提供 `fin-data-provider` service（`getOHLCV()`, `getTicker()`, `getSupportedMarkets()`），覆盖了大部分需求。

**真正缺失的**:

- `fin_orderbook` — 盘口深度数据（datahub 不提供）
- `fin_market_overview` — 交易所级 top movers/volume leaders

**已被替代的**:

- `fin_market_price` → datahub `getTicker()` 覆盖
- `fin_ticker_info` → datahub `getTicker()` 覆盖

**方案**: 只补 2 个工具到 `src/execution/trading-tools.ts`

- `fin_orderbook` — 通过 ExchangeRegistry 直接获取 CCXT orderbook
- `fin_market_overview` — 通过 ExchangeRegistry 获取 top tickers
- 预计 ~100 LOC

---

## 四、P2-P3 (暂缓)

### P2: fin-strategy-memory — 交易记忆系统

**能力**: 交易日志、error book（错误模式库）、success book（成功模式库）
**3 hooks**: `before_prompt_build`（注入金融上下文）、`after_tool_call`（自动记录）、`before_tool_call`（约束检查）

**暂缓原因**: 功能完整但与核心交易流程正交。在 MVP 阶段用户可通过 DailyBrief 获得交易回顾。可在后续 Phase 作为"AI 学习"特性开发。

### P3: fin-info-feed — 新闻/KOL 信息流

**暂缓原因**: Grok API 集成需要独立 API Key，不属于零配置体验。且信息流功能与交易引擎无依赖关系。

### P3: fin-expert-sdk — 外部专家 API

**暂缓原因**: 主要是 stub 实现，外部 Expert API 尚未稳定。

---

## 五、实施排期

```
Phase E-1 (P0, 紧急):
  E-1a: monitoring 模块 — AlertEngine + scheduler + 4 AI tools    (~1d)
  E-1b: portfolio 模块 — aggregator + store + 5 AI tools           (~1d)
  E-1c: 测试验证 — ~40 新测试 → 总计 ~282                          (~0.5d)

Phase E-2 (P1, 推荐):
  E-2a: 补充 fin_orderbook + fin_market_overview 到 trading-tools  (~0.5d)

Phase E-3 (P2-P3, 暂缓):
  E-3a: strategy-memory 交易记忆系统                                (未排期)
  E-3b: info-feed 新闻/KOL 信息流                                  (未排期)
  E-3c: expert-sdk 外部专家 API                                    (未排期)
```

---

## 六、预期成果

| 指标      | Phase C/D 后 | Phase E-1 后   | Phase E-2 后 |
| --------- | ------------ | -------------- | ------------ |
| AI Tools  | 23           | **32** (+9)    | **34** (+2)  |
| Services  | 9            | **11** (+2)    | 11           |
| Tests     | 242          | **~282** (+40) | **~290**     |
| 告警系统  | 空转         | **可用**       | 可用         |
| 组合视图  | 无           | **可用**       | 可用         |
| Orderbook | 无           | 无             | **可用**     |

---

## 七、P0 是否需要提前执行？

### 判断标准

1. **fin-monitoring (告警)**: **需要提前**
   - dashboard 的 alert CRUD routes 已上线但后端空转
   - data-gathering.ts 中 6 处 `fin-alert-engine` 引用返回 undefined → 功能降级但不崩溃
   - 如果用户尝试设置告警 → 静默失败，体验差

2. **fin-portfolio (组合视图)**: **建议提前**
   - 这是用户最常用的 AI 交互（"我的持仓是什么"、"我有多少钱"）
   - `gatherLiveTradingData()` 已有聚合逻辑，可直接复用
   - 没有这些工具，AI 无法回答最基本的组合问题

### 结论

**P0-1 (monitoring) 和 P0-2 (portfolio) 建议在 Phase E-1 中立即执行**，与 Phase C-external/MCP 暴露并行。
