import type { GatewayBrowserClient } from "../gateway.ts";
import type { TradingSnapshotResult } from "../types.ts";

export type TradingSnapshotState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  tradingSnapshotLoading: boolean;
  tradingSnapshot: TradingSnapshotResult | null;
  tradingSnapshotError: string | null;
};

export async function loadTradingSnapshotState(state: TradingSnapshotState): Promise<void> {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.tradingSnapshotLoading) {
    return;
  }
  state.tradingSnapshotLoading = true;
  state.tradingSnapshotError = null;
  try {
    state.tradingSnapshot = await state.client.request<TradingSnapshotResult>(
      "trading.snapshot",
      {},
    );
  } catch (err) {
    state.tradingSnapshotError = err instanceof Error ? err.message : String(err);
  } finally {
    state.tradingSnapshotLoading = false;
  }
}
