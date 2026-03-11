# findoo-datahub-plugin 测试计划

> 统一金融数据源插件 — free mode (CCXT/CoinGecko/DefiLlama/Yahoo) + full mode (172 DataHub 端点)

## 测试矩阵总览

| 层次                  | 用例数 | 依赖                            | 运行方式                  |
| --------------------- | ------ | ------------------------------- | ------------------------- |
| **L1 单元测试**       | ~55    | vi.fn() mock, 无外部依赖        | `pnpm test`               |
| **L2 集成测试**       | ~20    | 真实模块组合, SQLite 临时数据库 | `pnpm test`               |
| **L3 Gateway E2E**    | ~12    | gateway 实例 + 插件加载         | `pnpm gateway:dev` + 日志 |
| **L4 全链路 LLM**     | ~10    | LLM + DataHub API key           | `CLAWDBOT_LIVE_TEST=1`    |
| **L5 Playwright E2E** | ~8     | 浏览器 + gateway + LLM          | Playwright + 截图         |

---

## 视角一: OpenClaw 专家 — 插件 SDK 合约

### L1: 插件注册合约

| #   | 用例                                                | 验证点                                                        |
| --- | --------------------------------------------------- | ------------------------------------------------------------- |
| 1   | registerAllTools 注册 12 个工具                     | api.registerTool 被调用 12 次，name 唯一                      |
| 2   | 每个工具 name 符合 `fin_*` 命名规范                 | 无冲突、无 typo                                               |
| 3   | 工具 parameters 符合 TypeBox Object schema          | 顶层 type=object，无 anyOf/oneOf                              |
| 4   | execute 函数签名: (toolCallId, params) → content[]  | 返回 { content: [{ type: "text", text }] }                    |
| 5   | skill pack eligibility: 34 个 skill 绑定正确工具名  | names[] 匹配已注册工具                                        |
| 6   | config schema: resolveConfig 正确读取环境变量优先级 | DATAHUB_API_KEY > OPENFINCLAW_DATAHUB_PASSWORD > pluginConfig |
| 7   | config 默认值: timeout=30000, url=内置地址          | 无 API key 时仍可构造                                         |

### L2: 插件生命周期

| #   | 用例                                        | 验证点                                           |
| --- | ------------------------------------------- | ------------------------------------------------ |
| 1   | 插件 init → register services → tools ready | fin-data-provider + fin-regime-detector 服务注册 |
| 2   | 无 API key 时降级为 free mode               | CryptoAdapter 可用, DataHubClient=null           |
| 3   | 有 API key 时 full mode                     | DataHubClient 构造, 12 个工具全部注册            |
| 4   | 插件卸载时 cache.close() 被调用             | SQLite 连接释放                                  |

### L3: Gateway 加载

| #   | 用例                          | 验证点                                  |
| --- | ----------------------------- | --------------------------------------- |
| 1   | gateway 启动加载 datahub 插件 | 日志包含 "findoo-datahub-plugin loaded" |
| 2   | 工具出现在 /api/tools 列表    | 12 个 fin\_\* 工具可查询                |
| 3   | HTTP 路由注册 (如有)          | /api/v1/datahub/\* 可达                 |

---

## 视角二: 金融专家 — 数据精度与完整性

### L1: 数据核心模块

| #   | 模块           | 用例                                               | 验证点                                               |
| --- | -------------- | -------------------------------------------------- | ---------------------------------------------------- |
| 1   | DataHubClient  | URL 构造: 8 个 category 路径正确                   | equity → /api/v1/equity/_, crypto → /api/v1/crypto/_ |
| 2   | DataHubClient  | Auth header: Basic base64 编码                     | btoa("admin:password")                               |
| 3   | DataHubClient  | HTTP 204 返回空数组                                | 非交易时段空响应                                     |
| 4   | DataHubClient  | HTTP 4xx/5xx 抛 Error 含状态码                     | 错误消息含 status + body 截断                        |
| 5   | DataHubClient  | 非 JSON 响应抛明确错误                             | "returned non-JSON"                                  |
| 6   | DataHubClient  | payload.detail 字段透传错误                        | 上游 API 错误消息                                    |
| 7   | DataHubClient  | getOHLCV: symbol 自动路由 provider                 | .SH/.SZ/.HK → tushare, 其他 → massive                |
| 8   | DataHubClient  | normalizeOHLCV: date/trade_date/timestamp 三种格式 | 统一为 Unix ms                                       |
| 9   | DataHubClient  | normalizeOHLCV: limit 截取最新 N 条                | slice(-limit)                                        |
| 10  | DataHubClient  | getTicker: crypto 走 crypto/price/historical       | 取最后一条 close                                     |
| 11  | DataHubClient  | getTicker: equity 无数据时抛错                     | "No ticker data for XXX"                             |
| 12  | DataHubClient  | 超时: AbortSignal.timeout(ms)                      | fetch 超时中断                                       |
| 13  | OHLCVCache     | upsert + query round trip                          | OHLCV 6 字段完整                                     |
| 14  | OHLCVCache     | INSERT OR REPLACE 幂等                             | 同 PK 覆盖旧值                                       |
| 15  | OHLCVCache     | getRange 空表返回 null                             | 无数据时 earliest/latest = null                      |
| 16  | OHLCVCache     | since/until 过滤                                   | 时间窗口查询                                         |
| 17  | OHLCVCache     | 不同 symbol/market/timeframe 隔离                  | 复合主键                                             |
| 18  | OHLCVCache     | close() 幂等                                       | 多次调用不报错                                       |
| 19  | RegimeDetector | < 200 bars → sideways                              | 数据不足降级                                         |
| 20  | RegimeDetector | bull: SMA50 > SMA200 且 close > SMA50              | 300 bars 上升趋势                                    |
| 21  | RegimeDetector | bear: SMA50 < SMA200 且 close < SMA50              | 300 bars 下降趋势                                    |
| 22  | RegimeDetector | crisis: drawdown > 30%                             | 从峰值回撤超 30%                                     |
| 23  | RegimeDetector | volatile: ATR% > 4%                                | 高波动率                                             |
| 24  | RegimeDetector | sideways: 无明确方向                               | 平稳横盘                                             |

### L2: 数据流闭环

| #   | 用例                                                    | 验证点                        |
| --- | ------------------------------------------------------- | ----------------------------- |
| 1   | DataHub → Cache → Query 一致性                          | 写入后查询数据匹配            |
| 2   | Cache 增量更新: 已有数据 + 新数据合并                   | getRange.latest 更新          |
| 3   | UnifiedProvider 路由: 有 key → DataHub, 无 key → 适配器 | 降级链正确                    |
| 4   | CryptoAdapter + Cache: CCXT 数据缓存后可离线查询        | 断网后读缓存                  |
| 5   | YahooAdapter: chart → OHLCV 归一化                      | date → timestamp, null 行过滤 |
| 6   | 多市场并发查询不冲突                                    | 不同 symbol 缓存隔离          |

### L4: 真实数据验证

| #   | 用例                        | 验证点                   |
| --- | --------------------------- | ------------------------ |
| 1   | A 股 OHLCV (600519.SH 茅台) | close > 100, volume > 0  |
| 2   | 港股历史 (00700.HK 腾讯)    | 日期连续、无空洞         |
| 3   | US 股票 (AAPL) + 降级处理   | yfinance 限流时优雅降级  |
| 4   | Crypto CoinGecko top coins  | 返回 BTC/ETH 等主流币    |
| 5   | 宏观数据 CPI/GDP/Shibor     | 数值范围合理 (CPI < 20%) |
| 6   | 体制检测: 茅台 300 天日线   | 返回有效 regime 类型     |

---

## 视角三: 产品专家 — 用户体验

### L1: 用户可见行为

| #   | 用例                                  | 验证点                                |
| --- | ------------------------------------- | ------------------------------------- |
| 1   | tool-helpers/json(): 输出格式化 JSON  | indent=2, content[0].type="text"      |
| 2   | buildParams: 过滤 null/空/routing key | endpoint/indicator 不进入查询参数     |
| 3   | 错误响应包含可理解的消息              | 非技术用户可读                        |
| 4   | 无 API key 时错误提示引导设置         | "Set DATAHUB_API_KEY for full access" |
| 5   | unsupported market 错误明确           | 告知支持的市场列表                    |

### L2: 降级策略

| #   | 用例                                    | 验证点                       |
| --- | --------------------------------------- | ---------------------------- |
| 1   | free mode: crypto 可用, equity 需 yahoo | getSupportedMarkets 反映实际 |
| 2   | free mode: commodity 不可用             | 抛错含引导信息               |
| 3   | DataHub 超时后返回缓存数据              | 有缓存时不报错               |
| 4   | Yahoo 适配器不可用时清晰报错            | "install yahoo-finance2"     |

### L3: 端到端体验

| #   | 用例                              | 验证点                                  |
| --- | --------------------------------- | --------------------------------------- |
| 1   | LLM 通过 fin_stock 查询茅台基本面 | 返回包含 revenue/profit                 |
| 2   | LLM 通过 fin_crypto 查询 BTC 价格 | 返回 last > 0                           |
| 3   | LLM 通过 fin_data_regime 分析市场 | 返回 bull/bear/sideways/volatile/crisis |
| 4   | LLM 自动选择正确工具              | 不使用 fin_query 当专用工具可用         |

### L5: 浏览器全场景

| #   | 用例                                   | 验证点                        |
| --- | -------------------------------------- | ----------------------------- |
| 1   | 用户输入 "查一下茅台最新价格"          | 工具调用 → 结果展示           |
| 2   | 用户输入 "分析 BTC 市场体制"           | regime 结果渲染               |
| 3   | 用户输入 "查看沪深 300 成分股"         | 列表展示                      |
| 4   | 首次用户无 API key                     | 提示设置 + free mode 可用功能 |
| 5   | 网络错误/超时                          | 错误提示友好, 不白屏          |
| 6   | 大数据量返回 (market_snapshots 12000+) | 页面不卡死                    |
| 7   | 连续多次查询                           | 缓存命中, 响应更快            |
| 8   | 移动端布局                             | 表格/数据可滚动               |

---

## 测试文件结构

```
tests/findoo-datahub-plugin/
  TEST-PLAN.md                              ← 本文件
  l1-unit/
    datahub-client.test.ts                  ← HTTP mock, 路径构造, 错误处理
    ohlcv-cache.test.ts                     ← SQLite 缓存逻辑
    regime-detector.test.ts                 ← 5 种体制分类 + 边界
    tool-helpers.test.ts                    ← buildParams, json, registerCategoryTool
    adapters.test.ts                        ← crypto/yahoo 适配器, 降级链
  l2-integration/
    (规划中)
  l3-gateway/
    (规划中)
  l4-llm/
    (规划中)
  l5-e2e/
    (规划中)
```

## 运行命令

```bash
# L1 单元测试 (无外部依赖)
pnpm test tests/findoo-datahub-plugin/l1-unit/

# 全部 L1
pnpm test tests/findoo-datahub-plugin/

# 带覆盖率
pnpm test:coverage -- --include 'extensions/findoo-datahub-plugin/src/**'
```

## 覆盖率目标

| 模块                | 行覆盖率 | 分支覆盖率 |
| ------------------- | -------- | ---------- |
| datahub-client.ts   | >= 85%   | >= 80%     |
| ohlcv-cache.ts      | >= 90%   | >= 85%     |
| regime-detector.ts  | >= 95%   | >= 90%     |
| tool-helpers.ts     | >= 90%   | >= 85%     |
| adapters/\*         | >= 80%   | >= 75%     |
| unified-provider.ts | >= 85%   | >= 80%     |
