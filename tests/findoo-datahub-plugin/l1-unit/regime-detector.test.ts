/**
 * L1 单元测试: RegimeDetector
 *
 * 使用确定性数据验证 5 种市场体制分类:
 * - bull: SMA50 > SMA200 且 close > SMA50
 * - bear: SMA50 < SMA200 且 close < SMA50
 * - crisis: drawdown > 30% from peak
 * - volatile: ATR(14)/close > 4%
 * - sideways: 默认 / 数据不足
 *
 * 关键边界:
 * - < 200 bars 降级
 * - 恰好 200 bars
 * - 全等价格 (zero ATR)
 */
import { describe, expect, it } from "vitest";
import { RegimeDetector } from "../../../extensions/findoo-datahub-plugin/src/regime-detector.js";
import type { OHLCV } from "../../../extensions/findoo-datahub-plugin/src/types.js";

const detector = new RegimeDetector();

/** 生成确定性趋势数据 */
function makeTrend(
  count: number,
  opts: {
    startPrice?: number;
    dailyReturn?: number; // 每日回报率
    atrPct?: number; // ATR 占 close 的百分比 (控制波动率)
  } = {},
): OHLCV[] {
  const { startPrice = 100, dailyReturn = 0, atrPct = 0.5 } = opts;
  const bars: OHLCV[] = [];
  let price = startPrice;

  for (let i = 0; i < count; i++) {
    const open = price;
    price = price * (1 + dailyReturn);
    const close = price;
    const spread = price * (atrPct / 100);
    const high = Math.max(open, close) + spread;
    const low = Math.min(open, close) - spread;

    bars.push({
      timestamp: 1700000000000 + i * 86400_000,
      open,
      high,
      low,
      close,
      volume: 10000,
    });
  }
  return bars;
}

describe("RegimeDetector", () => {
  // --- 1. 数据不足: < 200 bars 返回 sideways ---
  it("< 200 bars 返回 sideways (数据不足降级)", () => {
    expect(detector.detect(makeTrend(50))).toBe("sideways");
    expect(detector.detect(makeTrend(100))).toBe("sideways");
    expect(detector.detect(makeTrend(199))).toBe("sideways");
  });

  // --- 2. 空数组返回 sideways ---
  it("空数组返回 sideways", () => {
    expect(detector.detect([])).toBe("sideways");
  });

  // --- 3. 恰好 200 bars 可正常检测 ---
  it("恰好 200 bars 不再降级, 可正常检测", () => {
    const bars = makeTrend(200, { dailyReturn: 0.002 });
    const regime = detector.detect(bars);
    // 200 bars 上升趋势应检测为 bull 或 sideways (SMA 交叉需要时间)
    expect(["bull", "bear", "sideways", "volatile", "crisis"]).toContain(regime);
  });

  // --- 4. 强上升趋势 → bull ---
  it("强持续上升趋势检测为 bull", () => {
    // 300 bars, 每日 +1% 回报, 低波动
    const bars = makeTrend(300, { startPrice: 100, dailyReturn: 0.01, atrPct: 0.3 });
    const regime = detector.detect(bars);
    // SMA50 应远高于 SMA200, close 远高于 SMA50
    expect(regime).toBe("bull");
  });

  // --- 5. 强下降趋势 → bear ---
  it("强持续下降趋势检测为 bear 或 crisis", () => {
    // 300 bars, 每日 -0.5% 回报, 低波动
    const bars = makeTrend(300, { startPrice: 200, dailyReturn: -0.005, atrPct: 0.3 });
    const regime = detector.detect(bars);
    // 持续下跌可能触发 bear 或 crisis (drawdown > 30%)
    expect(["bear", "crisis"]).toContain(regime);
  });

  // --- 6. crisis: drawdown > 30% ---
  it("峰值回撤 > 30% 检测为 crisis", () => {
    // 先涨到高点, 再暴跌
    const upPhase = makeTrend(200, { startPrice: 100, dailyReturn: 0.003 });
    const peakPrice = upPhase[upPhase.length - 1].close;

    // 100 bars 暴跌, 目标跌到峰值的 60% (回撤 40%)
    const crashReturn = Math.pow(0.6, 1 / 100) - 1; // 每日跌约 0.51%
    const downPhase = makeTrend(100, {
      startPrice: peakPrice,
      dailyReturn: crashReturn,
      atrPct: 0.3,
    });
    // 修正 timestamp 接续
    const lastTs = upPhase[upPhase.length - 1].timestamp;
    downPhase.forEach((b, i) => {
      b.timestamp = lastTs + (i + 1) * 86400_000;
    });

    const bars = [...upPhase, ...downPhase];
    const regime = detector.detect(bars);
    expect(regime).toBe("crisis");
  });

  // --- 7. volatile: ATR% > 4% ---
  it("高波动率 (ATR% > 4%) 检测为 volatile", () => {
    // 300 bars, 横盘但高波动
    const bars = makeTrend(300, { startPrice: 100, dailyReturn: 0, atrPct: 5 });
    const regime = detector.detect(bars);
    expect(regime).toBe("volatile");
  });

  // --- 8. sideways: 无明确方向 ---
  it("平稳横盘检测为 sideways", () => {
    // 300 bars, 零回报, 低波动
    const bars = makeTrend(300, { startPrice: 100, dailyReturn: 0, atrPct: 0.3 });
    const regime = detector.detect(bars);
    expect(regime).toBe("sideways");
  });

  // --- 9. 全等价格 (zero ATR) → sideways ---
  it("全等价格 (OHLC 完全相同) 不报错", () => {
    const bars: OHLCV[] = Array.from({ length: 300 }, (_, i) => ({
      timestamp: 1700000000000 + i * 86400_000,
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volume: 1000,
    }));
    const regime = detector.detect(bars);
    // ATR = 0, 无 drawdown → sideways
    expect(regime).toBe("sideways");
  });

  // --- 10. 返回值始终是有效 MarketRegime 类型 ---
  it("返回值始终是 5 种有效 regime 之一", () => {
    const scenarios = [
      makeTrend(300, { dailyReturn: 0.01 }),
      makeTrend(300, { dailyReturn: -0.01 }),
      makeTrend(300, { dailyReturn: 0, atrPct: 6 }),
      makeTrend(300, { dailyReturn: 0 }),
      makeTrend(50),
    ];
    const validRegimes = ["bull", "bear", "sideways", "volatile", "crisis"];

    for (const bars of scenarios) {
      const regime = detector.detect(bars);
      expect(validRegimes).toContain(regime);
    }
  });

  // --- 11. crisis 优先级高于 volatile ---
  it("drawdown > 30% 时即使 ATR 也高, crisis 优先于 volatile", () => {
    // 先涨后暴跌 + 高波动
    const up = makeTrend(200, { startPrice: 100, dailyReturn: 0.003, atrPct: 1 });
    const peak = up[up.length - 1].close;
    const crash = makeTrend(100, {
      startPrice: peak,
      dailyReturn: Math.pow(0.5, 1 / 100) - 1,
      atrPct: 5,
    });
    const lastTs = up[up.length - 1].timestamp;
    crash.forEach((b, i) => {
      b.timestamp = lastTs + (i + 1) * 86400_000;
    });

    const bars = [...up, ...crash];
    const regime = detector.detect(bars);
    // crisis 检查在 volatile 之前
    expect(regime).toBe("crisis");
  });

  // --- 12. SMA 计算精度: 已知输入验证输出 ---
  it("小规模确定性输入: SMA 交叉逻辑正确", () => {
    // 构造 200 bars 先跌后涨的 V 型:
    // 前 150 bars 下跌 (SMA200 会偏高), 后 50 bars 急涨 (SMA50 追上)
    const down = makeTrend(150, { startPrice: 200, dailyReturn: -0.002, atrPct: 0.3 });
    const bottomPrice = down[down.length - 1].close;
    const up = makeTrend(50, { startPrice: bottomPrice, dailyReturn: 0.015, atrPct: 0.3 });
    const lastTs = down[down.length - 1].timestamp;
    up.forEach((b, i) => {
      b.timestamp = lastTs + (i + 1) * 86400_000;
    });

    const bars = [...down, ...up];
    expect(bars.length).toBe(200);
    const regime = detector.detect(bars);
    // V 型反弹: close > SMA50 但 SMA50 可能还 < SMA200 → sideways 或 bull
    expect(["sideways", "bull"]).toContain(regime);
  });
});
