# findoo-trader-plugin Test Plan

> Last updated: 2026-03-11
> Scope: `extensions/findoo-trader-plugin/` — 8 subsystems, 8 services, 23 AI tools, 38+ HTTP routes, 4 SSE streams, 8 skills

---

## 1. Test Pyramid & Layers

| Layer                 | Target                                        | Tooling                           | Pass Criteria                              |
| --------------------- | --------------------------------------------- | --------------------------------- | ------------------------------------------ |
| **L1 Unit**           | Pure functions, class methods, state machines | Vitest + vi.fn()                  | 100% branch coverage on core logic         |
| **L2 Integration**    | Module-to-module data flow (no mocks)         | Vitest + real SQLite (`:memory:`) | All inter-module contracts verified        |
| **L3 Gateway E2E**    | HTTP routes + SSE + service lifecycle         | `pnpm gateway:dev` + supertest    | All 38 routes return correct status/schema |
| **L4 Full-chain LLM** | LLM -> tool_use -> execution -> verification  | API key + tool_use logs           | 23 tools callable, results match spec      |
| **L5 Playwright E2E** | Browser -> Dashboard -> real-time updates     | Playwright + browser snapshot     | 5 pages load < 3s, SSE data arrives        |

---

## 2. View A: OpenClaw Expert (Platform Integration)

### 2.1 Service Registration & Discovery

| #   | Test                                                      | Module                   | Layer |
| --- | --------------------------------------------------------- | ------------------------ | ----- |
| A01 | 8 services register in `runtime.services` map             | config.ts (plugin entry) | L2    |
| A02 | Service IDs match convention `fin-*`                      | config.ts                | L1    |
| A03 | Services survive gateway restart (re-register)            | plugin lifecycle         | L3    |
| A04 | Cross-plugin resolution: datahub -> trader service lookup | runtime.services         | L2    |
| A05 | Service unregister on plugin disable                      | plugin lifecycle         | L3    |

### 2.2 Tool Schema Compliance (23 tools)

| #   | Test                                                           | Tool Group              | Layer |
| --- | -------------------------------------------------------------- | ----------------------- | ----- |
| A10 | 5 trading tools: schema = `type: "object"`, no `anyOf`/`oneOf` | execution/trading-tools | L1    |
| A11 | 6 paper tools: required params present, types match            | paper/tools             | L1    |
| A12 | 5 strategy tools: enum params use `stringEnum`                 | strategy/tools          | L1    |
| A13 | 7 fund tools: no raw `format` property in schema               | fund/tools              | L1    |
| A14 | All 23 tools have description < 1024 chars                     | all tools               | L1    |
| A15 | Tool names follow `fin_*` convention                           | all tools               | L1    |

### 2.3 HTTP Route Coverage (38+ routes)

| #   | Test                                                         | Route Group            | Layer |
| --- | ------------------------------------------------------------ | ---------------------- | ----- |
| A20 | Core routes: `/api/v1/finance/*` (overview, setting, alerts) | core/route-handlers    | L3    |
| A21 | Strategy routes: CRUD + backtest trigger                     | core/routes-strategies | L3    |
| A22 | Paper routes: account CRUD, order submit, snapshot           | paper/                 | L3    |
| A23 | Fund routes: allocation, leaderboard, packs                  | fund/routes            | L3    |
| A24 | AI chat route: `/api/v1/finance/ai/chat`                     | core/routes-ai-chat    | L3    |
| A25 | Setting routes: exchange CRUD, risk config, agent config     | core/routes-setting    | L3    |
| A26 | All routes return `Content-Type: application/json`           | all                    | L3    |
| A27 | Unknown routes return 404 (not 500)                          | error handling         | L3    |

### 2.4 SSE Stream Stability (4 streams)

| #   | Test                                                          | Stream       | Layer |
| --- | ------------------------------------------------------------- | ------------ | ----- |
| A30 | Events SSE: delivers trade_executed, alert_triggered          | sse-handlers | L3    |
| A31 | Paper SSE: equity snapshots push on trade fill                | sse-handlers | L3    |
| A32 | Activity SSE: lifecycle promotions appear in feed             | sse-handlers | L3    |
| A33 | SSE reconnect: client receives missed events after disconnect | sse-handlers | L5    |
| A34 | SSE heartbeat keepalive (`:ping` every 30s)                   | sse-handlers | L3    |

### 2.5 Hook Integration

| #   | Test                                                             | Hook             | Layer |
| --- | ---------------------------------------------------------------- | ---------------- | ----- |
| A40 | Risk gate hook: blocks order when paused                         | risk-controller  | L2    |
| A41 | Prompt context hook: injects portfolio summary into agent prompt | prompt-context   | L2    |
| A42 | Heartbeat hook: lifecycle engine runs on heartbeat interval      | lifecycle-engine | L2    |

---

## 3. View B: Financial Expert (Domain Correctness)

### 3.1 Risk Controller

| #   | Test                                                  | Scenario                            | Layer |
| --- | ----------------------------------------------------- | ----------------------------------- | ----- |
| B01 | Daily loss limit triggers trading halt                | `dailyLossUsd >= maxDailyLossUsd`   | L1    |
| B02 | Loss counter resets at midnight UTC                   | date boundary crossing              | L1    |
| B03 | Leverage rejection: `order.leverage > maxLeverage`    | leverage limit                      | L1    |
| B04 | Position size % check (via estimatedValueUsd)         | portfolio %                         | L1    |
| B05 | Emergency stop pauses all trading                     | `pause()` -> all evaluations reject | L1    |
| B06 | Resume restores normal evaluation                     | `resume()` after pause              | L1    |
| B07 | Pair allowlist: only listed symbols pass              | allowedPairs filter                 | L1    |
| B08 | Pair blocklist: blocked symbols always reject         | blockedPairs filter                 | L1    |
| B09 | Tiered evaluation: auto < confirm < reject thresholds | 3-tier logic                        | L1    |
| B10 | Config disabled: all trades rejected                  | `enabled=false`                     | L1    |

### 3.2 Paper Engine (Simulation Fidelity)

| #   | Test                                                        | Scenario             | Layer |
| --- | ----------------------------------------------------------- | -------------------- | ----- |
| B20 | Slippage model: market orders incur configurable slippage   | fill-simulation      | L1    |
| B21 | Commission calculation: taker vs maker fee rates            | fill-simulation      | L1    |
| B22 | A-share rules: 10% daily limit, T+1 settlement              | market-rules         | L1    |
| B23 | HK-share rules: minimum tick size (0.01 HKD)                | market-rules         | L1    |
| B24 | US equities: round lot (100 shares), no short-sell uptick   | market-rules         | L1    |
| B25 | Crypto: 24/7 trading, fractional qty, no T+N                | market-rules         | L1    |
| B26 | Equity curve: PnL sums to equity delta over N bars          | paper-account        | L2    |
| B27 | Decay detector: flags strategies with rolling Sharpe < 0.5  | decay-detector       | L1    |
| B28 | Paper health monitor: circuit breaker on portfolio drawdown | paper-health-monitor | L2    |

### 3.3 Strategy Engine

| #   | Test                                                          | Scenario               | Layer |
| --- | ------------------------------------------------------------- | ---------------------- | ----- |
| B30 | 10 built-in templates load without error                      | strategy-templates     | L1    |
| B31 | Backtest engine: Sharpe/Sortino/MaxDD computation correctness | strategy/stats         | L1    |
| B32 | Walk-forward validation: in-sample/out-of-sample split        | fitness                | L2    |
| B33 | No look-ahead bias: signals use only past data                | strategy execution     | L2    |
| B34 | Strategy codegen: AI-generated strategy compiles and runs     | strategy-codegen       | L4    |
| B35 | Remote backtest bridge: request/response serialization        | remote-backtest-bridge | L2    |
| B36 | Indicator library: SMA/EMA/RSI/MACD match reference values    | indicator-lib          | L1    |

### 3.4 Fund Management

| #   | Test                                                           | Scenario            | Layer |
| --- | -------------------------------------------------------------- | ------------------- | ----- |
| B40 | Half-Kelly allocation: no strategy exceeds half-Kelly weight   | capital-allocator   | L1    |
| B41 | Correlation monitor: flags correlated strategy pairs (r > 0.7) | correlation-monitor | L2    |
| B42 | L0->L3 promotion pipeline: gate thresholds enforced            | promotion-pipeline  | L1    |
| B43 | Demotion triggers: consecutive loss days, Sharpe decay         | fund-manager        | L1    |
| B44 | Cold-start seeder: generates L0 candidates from market scan    | cold-start-seeder   | L2    |
| B45 | Leaderboard ranking: fitness score sorted descending           | leaderboard         | L1    |
| B46 | Capital flow store: tracks allocation changes with timestamps  | capital-flow-store  | L1    |
| B47 | Fund risk manager: max drawdown triggers rebalance             | fund-risk-manager   | L2    |

### 3.5 Alpha Factory

| #   | Test                                                            | Scenario              | Layer |
| --- | --------------------------------------------------------------- | --------------------- | ----- |
| B50 | Alpha decay estimator: detects decaying alpha signal            | alpha-decay-estimator | L1    |
| B51 | Alpha independence: rejects duplicate/correlated strategies     | alpha-independence    | L1    |
| B52 | Capacity estimator: market impact model                         | capacity-estimator    | L1    |
| B53 | Monte Carlo test: 95% confidence band computation               | monte-carlo-test      | L1    |
| B54 | Garbage collector: kills strategies meeting multi-rule criteria | garbage-collector     | L1    |
| B55 | Screening pipeline: filters candidates by min fitness           | screening-pipeline    | L1    |

---

## 4. View C: Product Expert (User Experience)

### 4.1 Dashboard Performance

| #   | Test                                            | Page              | Layer |
| --- | ----------------------------------------------- | ----------------- | ----- |
| C01 | Overview page loads in < 3s (cold start)        | skill: overview   | L5    |
| C02 | Trader page loads in < 3s, K-line renders       | skill: trader     | L5    |
| C03 | Strategy page loads in < 3s, table populated    | skill: strategy   | L5    |
| C04 | Setting page loads in < 3s, forms pre-filled    | skill: setting    | L5    |
| C05 | Quant Fund page loads in < 3s, pipeline visible | skill: quant-fund | L5    |

### 4.2 Real-time Updates

| #   | Test                                         | Scenario            | Layer |
| --- | -------------------------------------------- | ------------------- | ----- |
| C10 | Trade execution appears in feed within 2s    | SSE -> DOM          | L5    |
| C11 | Paper equity updates live during simulation  | SSE -> chart        | L5    |
| C12 | Alert trigger shows notification toast       | SSE -> toast        | L5    |
| C13 | Promotion event updates strategy level badge | SSE -> badge        | L5    |
| C14 | No duplicate events on page refresh          | SSE reconnect dedup | L5    |

### 4.3 Mobile Responsiveness

| #   | Test                                           | Viewport      | Layer |
| --- | ---------------------------------------------- | ------------- | ----- |
| C20 | Trader page at 380px: no horizontal scroll     | mobile narrow | L5    |
| C21 | Trader page at 640px: cards stack vertically   | mobile wide   | L5    |
| C22 | Overview page at 380px: summary cards readable | mobile narrow | L5    |
| C23 | Strategy table scrolls horizontally at 380px   | mobile narrow | L5    |

### 4.4 Empty States & Error Handling

| #   | Test                                                  | Scenario       | Layer |
| --- | ----------------------------------------------------- | -------------- | ----- |
| C30 | No exchanges configured: shows onboarding prompt      | empty state    | L5    |
| C31 | No strategies: shows "Create your first strategy" CTA | empty state    | L5    |
| C32 | Exchange disconnect: shows reconnect banner           | error recovery | L3    |
| C33 | API timeout: shows retry button, no crash             | error recovery | L5    |
| C34 | Invalid API key: clear error message, no stack trace  | validation     | L3    |

### 4.5 Error Recovery

| #   | Test                                                | Scenario         | Layer |
| --- | --------------------------------------------------- | ---------------- | ----- |
| C40 | Exchange reconnect after network drop (30s timeout) | ccxt-bridge      | L3    |
| C41 | SSE auto-reconnect after server restart             | sse-handlers     | L5    |
| C42 | Paper engine recovers state from SQLite after crash | paper-store      | L2    |
| C43 | Lifecycle engine resumes cycle after error          | lifecycle-engine | L1    |

---

## 5. Test File Inventory

### L1 Unit Tests (this sprint)

| File                                | Module                 | Cases |
| ----------------------------------- | ---------------------- | ----- |
| `l1-unit/exchange-registry.test.ts` | core/exchange-registry | 12    |
| `l1-unit/risk-controller.test.ts`   | core/risk-controller   | 15    |
| `l1-unit/alert-engine.test.ts`      | core/alert-engine      | 12    |
| `l1-unit/lifecycle-engine.test.ts`  | core/lifecycle-engine  | 15    |

### L1 Unit Tests (backlog — alpha-factory already has colocated tests)

| File                                  | Module                  | Status   |
| ------------------------------------- | ----------------------- | -------- |
| `alpha-factory/*.test.ts` (colocated) | alpha-factory           | Existing |
| `l1-unit/paper-account.test.ts`       | paper/paper-account     | Planned  |
| `l1-unit/fill-simulation.test.ts`     | paper/fill-simulation   | Planned  |
| `l1-unit/capital-allocator.test.ts`   | fund/capital-allocator  | Planned  |
| `l1-unit/promotion-pipeline.test.ts`  | fund/promotion-pipeline | Planned  |
| `l1-unit/indicator-lib.test.ts`       | strategy/indicator-lib  | Planned  |
| `l1-unit/stats.test.ts`               | strategy/stats          | Planned  |

### L2-L5 (planned, not in this sprint)

| Layer | File Pattern               | Est. Count |
| ----- | -------------------------- | ---------- |
| L2    | `l2-integration/*.test.ts` | 8-12       |
| L3    | `l3-gateway/*.test.ts`     | 6-8        |
| L4    | `l4-llm/*.test.ts`         | 3-5        |
| L5    | `l5-e2e/*.test.ts`         | 5-8        |

---

## 6. Coverage Targets

| Metric     | L1 Target    | Overall Target |
| ---------- | ------------ | -------------- |
| Lines      | >= 80% core/ | >= 70% total   |
| Branches   | >= 85% core/ | >= 70% total   |
| Functions  | >= 90% core/ | >= 70% total   |
| Statements | >= 80% core/ | >= 70% total   |

---

## 7. Risk Matrix

| Risk                          | Impact                                      | Mitigation                                  |
| ----------------------------- | ------------------------------------------- | ------------------------------------------- |
| CCXT mock fidelity            | L1 tests may pass but real exchange differs | L3 tests with testnet APIs                  |
| SQLite `:memory:` vs file WAL | Concurrency bugs hidden                     | L2 tests use temp file DBs                  |
| LLM non-determinism           | L4 tests flaky                              | Assert on tool_use presence, not exact text |
| SSE timing                    | L5 tests race conditions                    | Use `waitForSelector` + retry assertions    |
| Market rules drift            | A-share/HK rules change                     | External data source for limits             |
