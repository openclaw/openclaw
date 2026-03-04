# Phase C/D 规划 — 开源对齐分析 + 实施方案

## 一、核心诊断：当前开发方向 vs 开源战略

### 开源战略要求什么？

从 5 份开源计划文档提炼的**引爆公式**：

```
三级火箭战略：
  Rocket 1: Financial MCP Server → 开发者社区引爆
  Rocket 2: Agent Parliament + GEP 进化 → 技术社区引爆
  Rocket 3: Crisis Mode + Digital Twin → 大众市场引爆

"安装到 Wow" 梯度：
  Level 0 (30s): npm install → AI 打招呼，有金融人格
  Level 1 (1min): 问 "BTC 多少钱" → 实时价格 + 涨跌 + 情绪
  Level 2 (3min): 连交易所 → "我的持仓" → 跨所聚合
  Level 3 (5min): "帮我买 0.01 BTC" → Testnet 成交
  Level 4: 通知触发
  Level 5: 每日早报
```

### 我们实际在建什么？

Phase A/B/B+ 建了 **10,729 行内部交易基础设施**：

```
✅ 已建 (后台引擎):                    ❌ 未建 (前门体验):
━━━━━━━━━━━━━━━━━━                    ━━━━━━━━━━━━━━━━━━
Dashboard 4-Tab HTML                   MCP Server 暴露 → 0 行
PaperScheduler 自动 tick               npx openfinclaw → 不存在
BacktestEngine walk-forward            README GIF/Demo → 没有
L3 审批门控 + Telegram                 零配置体验 → 需要 API Key
DailyBriefScheduler                    "30 秒 Wow" → 做不到
Setting CRUD + Risk Config             策略市场 FinClawHub → 未开始
154 个测试                             一镜到底 Demo 视频 → 无法录制
```

### 诊断结论

**我们在从"内部向外"建设，而开源引爆需要"外部向内"。**

类比：我们在装修厨房和仓库（dashboard, paper trading, strategy engine），但大门还没开（MCP, 零配置体验, README）。内部基础设施质量很高（154 测试全绿），但对外部世界**完全不可见**。

---

## 二、什么适合开源/宣传？什么不适合？

### ✅ 适合开源宣传的（高传播价值）

| 模块                               | 为什么适合               | 传播叙事                   |
| ---------------------------------- | ------------------------ | -------------------------- |
| **16 个 AI Tools as MCP**          | 每个 AI 都能用的金融能力 | "任何 AI 加上金融大脑"     |
| **DataHub 172 端点**               | 免费 Bloomberg 数据层    | "$0 Bloomberg Terminal"    |
| **10 个策略模板**                  | 开箱即用的量化策略       | "开源对冲基金入门包"       |
| **BacktestEngine**                 | 策略验证, 可独立使用     | "5 分钟回测你的策略想法"   |
| **PaperTrading**                   | 零风险练习               | "AI 帮你模拟交易"          |
| **风控三层 (auto/confirm/reject)** | 安全第一的 AI 交易       | "不会乱花你钱的 AI"        |
| **Telegram 通知 + 审批**           | 移动端触达               | "AI 管家凌晨叫你起床"      |
| **DailyBrief**                     | 每日自动简报             | "每天早上 AI 给你金融早报" |

### ❌ 不适合开源宣传的（低传播价值 / 内部工具）

| 模块                       | 为什么不适合             | 处理方式               |
| -------------------------- | ------------------------ | ---------------------- |
| **Dashboard HTML (4 Tab)** | 管理界面，不是"Wow 时刻" | 保留但不做宣传重点     |
| **Setting CRUD**           | 水管工程，用户不关心     | 保留，文档简要提及     |
| **routes-\*.ts 路由层**    | 内部 API，非用户面       | 保留，API 文档自动生成 |
| **exchange-health-store**  | 运维监控，非用户面       | 保留                   |
| **Fund Manager**           | 太 niche，首次用户不需要 | 迁入但不做宣传         |
| **Zod schemas 验证层**     | 内部质量保障             | 保留                   |

### ⚠️ 需要重新包装的

| 模块             | 当前形态                   | 开源宣传形态                                                   |
| ---------------- | -------------------------- | -------------------------------------------------------------- |
| AI Tools (16 个) | OpenClaw 插件内部注册      | → **独立 MCP Server**，任何 AI 可用                            |
| DataHub 集成     | findoo-datahub-plugin 内部 | → **零配置数据源**，不需 API Key 即可查行情                    |
| 策略模板 (10 个) | JS 对象定义                | → **npm 可安装的 Skill 包**                                    |
| 回测引擎         | 内部 API                   | → **CLI 命令** `openfinclaw backtest --strategy sma-crossover` |

---

## 三、调整后的 Phase C/D 方案

### 原计划的问题

原 Phase C/D：

- C: 基金迁移 (fund-manager → findoo-trader-plugin)
- D: 删除旧 5 个 fin-\* 扩展 + 清理引用

**问题**: 这两件事都是**内部整理**，完成后对外部世界**零影响**。不会让项目更接近开源引爆。

### 调整建议：Phase C/D 拆分为 C-internal + C-external

```
Phase C-internal (内部收尾, ~2d):
  C-i1: fund-manager 核心代码迁入 findoo-trader-plugin/src/fund/
  C-i2: 旧 fin-* 扩展标记废弃 (不删除，加 DEPRECATED)
  C-i3: 引用清理 + 测试验证

Phase C-external (对外可见, ~5d):
  C-e1: 暴露 16 个 AI Tools 为独立 MCP Server
  C-e2: 零配置体验 — datahub 默认可用, 无需 API Key 查行情
  C-e3: CLI 快速入口 — openfinclaw market btc / openfinclaw backtest sma-crossover
  C-e4: README 重写 — GIF + 一条命令 + 5 秒决策

Phase D (清理 + 准备发射, ~3d):
  D-1: 删除废弃扩展
  D-2: 文档: 快速开始/MCP 接入/策略开发
  D-3: 录制 "60 秒不剪辑 Demo"
  D-4: PR + 代码审查
```

---

## 四、C-internal 详细任务

### C-i1: fund-manager 迁入 (~1d)

从 `extensions/fin-fund-manager/src/` 迁入 `extensions/findoo-trader-plugin/src/fund/`:

```
fund-manager.ts              → src/fund/fund-manager.ts (266 LOC)
capital-allocator.ts         → src/fund/capital-allocator.ts (157 LOC)
correlation-monitor.ts       → src/fund/correlation-monitor.ts (82 LOC)
fund-risk-manager.ts         → src/fund/fund-risk-manager.ts (91 LOC)
leaderboard.ts               → src/fund/leaderboard.ts (107 LOC)
promotion-pipeline.ts        → src/fund/promotion-pipeline.ts (296 LOC)
capital-flow-store.ts        → src/fund/capital-flow-store.ts (78 LOC)
performance-snapshot-store.ts → src/fund/performance-snapshot-store.ts (100 LOC)
types.ts                     → src/fund/types.ts (145 LOC)
formatters.ts                → src/fund/formatters.ts (200 LOC)
```

- 总计 ~1,427 LOC，调整 import 路径
- 在 index.ts 注册 fund 相关服务 + AI tools
- 新增 10+ 测试

### C-i2: 旧扩展标记废弃 (~0.5d)

在 5 个旧扩展的 README 和 package.json 中添加 deprecated 标记：

- fin-core, fin-trading, fin-paper-trading, fin-strategy-engine, fin-fund-manager

### C-i3: 引用清理 + 验证 (~0.5d)

- 搜索所有旧引用
- 更新指向 findoo-trader-plugin
- 确认 154+ 测试全绿

---

## 五、C-external 详细任务

### C-e1: MCP Server 暴露 (~2d)

将 16 个 AI Tools 暴露为标准 MCP Server：

零配置层 (无需 API Key):
fin_get_price — 实时价格
fin_market_overview — 市场概况
fin_screener_scan — 股票筛选
fin_news_feed — 新闻流

配置后可用层 (需交易所 API Key):
fin_portfolio_view — 持仓聚合
fin_place_order — 下单
fin_paper_trade — 模拟交易
fin_backtest_run — 回测

### C-e2: 零配置体验 (~1d)

DataHub 已运行 (43.134.61.136:8088)，让它成为默认数据源：

- 启动时自动注册 findoo-datahub-plugin
- 无需配置即可查询行情
- 在 SOUL-FINANCIAL.md 中引导 Agent 使用零配置工具

### C-e3: CLI 快速入口 (~1d)

```
openfinclaw market btc          # 实时 BTC 价格
openfinclaw market overview     # 大盘概况
openfinclaw analyze AAPL        # 股票分析
openfinclaw backtest sma-crossover --symbol BTC/USDT --period 1y
```

### C-e4: README 重写 (~1d)

GIF + 一条命令 + Level 0-5 体验表 + MCP 配置

---

## 六、Phase D (清理 + 发射准备)

### D-1: 删除废弃扩展 (~0.5d)

### D-2: 文档 (~1d) — 快速开始/MCP 接入/策略开发

### D-3: Demo 录制 (~0.5d) — 60 秒不剪辑

### D-4: PR + Review (~1d)

---

## 七、时间线

```
Day 1-2:  C-internal (fund 迁入 + 废弃标记 + 引用清理)
Day 3-4:  C-e1 (MCP Server 暴露)
Day 5:    C-e2 + C-e3 (零配置 + CLI)
Day 6:    C-e4 (README)
Day 7-8:  D-1~D-3 (清理 + 文档 + Demo)
Day 9:    D-4 (PR + Review)
```

---

## 八、验收标准

### C-internal 验收

- [ ] fund-manager 10 个文件迁入 findoo-trader-plugin/src/fund/
- [ ] 旧 5 个 fin-\* 扩展标记 DEPRECATED
- [ ] 所有测试 154+ 全绿
- [ ] fund 相关新增 10+ 测试

### C-external 验收

- [ ] `openfinclaw mcp` 启动 MCP Server，Claude Desktop 可连接
- [ ] 零配置查询: 无 API Key 可查 BTC 价格
- [ ] CLI: `openfinclaw market btc` 返回实时数据
- [ ] README 有 GIF + 30 秒快速开始

### D 验收

- [ ] 旧扩展已删除
- [ ] 快速开始文档可用
- [ ] Demo 视频可播放
- [ ] PR 创建并审查通过
