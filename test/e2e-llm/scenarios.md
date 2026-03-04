# LLM-Driven E2E Test Scenarios

Mock server: `http://localhost:18900`

> 每个场景独立执行，执行前先调用 `POST /api/test/reset` 重置状态。

---

## Scenario 1: 首次访问 Overview

1. 打开 `http://localhost:18900/dashboard/overview`
2. 获取页面快照（browser_snapshot），检查：
   - 页面标题或 heading 包含 "Overview" 或 "Financial"
   - 能看到 equity/资产总值信息（$125,430）
   - 能看到持仓列表（BTC/USDT, ETH/USDT）
   - 能看到策略数量信息
   - 能看到风控状态指示
3. 截图留证（browser_screenshot）

**通过标准**: 页面完整渲染，核心数据可见。

---

## Scenario 2: 四页导航链

1. 依次访问以下 4 个页面，每个页面取快照验证：
   - `/dashboard/overview` → 检查有 equity/positions 数据
   - `/dashboard/trading-desk` → 检查有交易相关内容
   - `/dashboard/strategy-arena` → 检查有 pipeline/策略数据
   - `/dashboard/strategy-lab` → 检查有策略列表和资金分配
2. 每页截图留证

**通过标准**: 4 页全部正常渲染，无空白页面。

---

## Scenario 3: Legacy 路径重定向

1. 依次访问以下旧路径，验证 302 重定向到正确的新页面：
   - `/dashboard/finance` → 应重定向到 `/dashboard/overview`
   - `/dashboard/trading` → 应重定向到 `/dashboard/trading-desk`
   - `/dashboard/command-center` → 应重定向到 `/dashboard/trading-desk`
   - `/dashboard/mission-control` → 应重定向到 `/dashboard/overview`
   - `/dashboard/evolution` → 应重定向到 `/dashboard/strategy-arena`
   - `/dashboard/fund` → 应重定向到 `/dashboard/strategy-lab`
   - `/dashboard/strategy` → 应重定向到 `/dashboard/strategy-arena`
   - `/dashboard/arena` → 应重定向到 `/dashboard/strategy-arena`
2. 对每个旧路径：浏览器打开后检查最终 URL 是否为预期的新路径

**通过标准**: 全部 8 个旧路径正确重定向。

---

## Scenario 4: 下单 — 自动执行（小额）

1. 用 Bash 发送 POST 请求下小额订单：
   ```
   curl -X POST http://localhost:18900/api/v1/finance/orders \
     -H 'Content-Type: application/json' \
     -d '{"symbol":"BTC/USDT","side":"buy","quantity":0.001,"currentPrice":65000}'
   ```
2. 验证响应：HTTP 201, status="filled"
3. 打开 `/dashboard/overview`，获取快照
4. 检查事件列表中出现 "trade_executed" 类型的事件

**通过标准**: 201 响应 + 事件列表出现已完成交易事件。

---

## Scenario 5: 下单 — 需确认（中额）

1. 用 Bash 发送 POST 请求下中额订单（$200，超过 $100 自动阈值）：
   ```
   curl -X POST http://localhost:18900/api/v1/finance/orders \
     -H 'Content-Type: application/json' \
     -d '{"symbol":"ETH/USDT","side":"buy","quantity":0.1,"currentPrice":2000}'
   ```
2. 验证响应：HTTP 202, status="pending_approval"
3. 打开 `/dashboard/overview`，获取快照
4. 检查事件列表中出现 "pending" 状态的事件

**通过标准**: 202 响应 + pending 事件可见。

---

## Scenario 6: 审批流程 — 批准

1. 先创建一个 pending 订单（同 Scenario 5）
2. 用 Bash 发送审批请求：
   ```
   curl -X POST http://localhost:18900/api/v1/finance/events/approve \
     -H 'Content-Type: application/json' \
     -d '{"id":"evt-1","action":"approve"}'
   ```
3. 验证响应：HTTP 200, status="approved"
4. 获取事件列表，验证：
   - 原始事件状态变为 "approved"
   - 新增一条 "trade_executed" 事件

**通过标准**: 审批成功 + 执行事件链完整。

---

## Scenario 7: 审批流程 — 拒绝

1. 先创建一个 pending 订单（同 Scenario 5）
2. 用 Bash 发送拒绝请求：
   ```
   curl -X POST http://localhost:18900/api/v1/finance/events/approve \
     -H 'Content-Type: application/json' \
     -d '{"id":"evt-1","action":"reject","reason":"Too risky"}'
   ```
3. 验证响应：HTTP 200, status="rejected"
4. 获取事件列表，验证原始事件状态为 "rejected"

**通过标准**: 拒绝成功 + 状态正确。

---

## Scenario 8: 紧急止损

1. 用 Bash 触发紧急止损：
   ```
   curl -X POST http://localhost:18900/api/v1/finance/emergency-stop
   ```
2. 验证响应：tradingDisabled=true
3. 尝试再次下单：
   ```
   curl -X POST http://localhost:18900/api/v1/finance/orders \
     -H 'Content-Type: application/json' \
     -d '{"symbol":"BTC/USDT","side":"buy","quantity":0.001,"currentPrice":65000}'
   ```
4. 验证后续订单被拒绝：HTTP 403
5. 打开 `/dashboard/overview`，检查页面是否反映交易已禁用

**通过标准**: 止损生效 + 后续交易拒绝 + 页面状态更新。

---

## Scenario 9: 风控三级评估

1. 测试 auto 级别（$50）：

   ```
   curl -X POST http://localhost:18900/api/v1/finance/risk/evaluate \
     -H 'Content-Type: application/json' \
     -d '{"symbol":"BTC/USDT","estimatedValueUsd":50}'
   ```

   → 期望 tier="auto"

2. 测试 confirm 级别（$300）：

   ```
   curl -X POST http://localhost:18900/api/v1/finance/risk/evaluate \
     -H 'Content-Type: application/json' \
     -d '{"symbol":"BTC/USDT","estimatedValueUsd":300}'
   ```

   → 期望 tier="confirm"

3. 测试 reject 级别（$600）：
   ```
   curl -X POST http://localhost:18900/api/v1/finance/risk/evaluate \
     -H 'Content-Type: application/json' \
     -d '{"symbol":"BTC/USDT","estimatedValueUsd":600}'
   ```
   → 期望 tier="reject"

**通过标准**: 三档风控阈值正确分流。

---

## Scenario 10: 策略 Pipeline 分布

1. 打开 `/dashboard/strategy-arena`
2. 获取快照，检查：
   - 能看到 L0/L1/L2/L3 各级策略数量
   - Pipeline 分布：L0=1, L1=1, L2=1, L3=1
   - 能看到 promotion gates（晋级条件）
3. 截图留证

**通过标准**: 策略 pipeline 数据正确渲染。

---

## Scenario 11: SSE 实时推送

1. 打开 `/dashboard/overview`（页面中内嵌了 SSE 连接）
2. 用 Bash 下一个小额订单触发事件
3. 等待 2 秒后重新获取页面快照
4. 检查新事件是否出现在页面中

**通过标准**: 实时推送的事件在页面可见。

---

## Scenario 12: 数据完整性验证

1. 用 Bash 获取 overview 原始数据：
   ```
   curl http://localhost:18900/api/v1/finance/config
   ```
2. 验证关键字段非空且合理：
   - exchanges 数组不为空
   - trading config 包含 maxAutoTradeUsd, confirmThresholdUsd
3. 用 Bash 获取交易所健康状态：
   ```
   curl http://localhost:18900/api/v1/finance/exchange-health
   ```
4. 验证 exchanges 数组有连接的交易所
5. 打开 `/dashboard/overview`，验证 pageData 中：
   - totalEquity > 0
   - positions 数组非空
   - strategies 数组非空

**通过标准**: 所有 API 数据字段完整且合理。
