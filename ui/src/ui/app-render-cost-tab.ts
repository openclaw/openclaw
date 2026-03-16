import { nothing } from "lit";
import type { AppViewState } from "./app-view-state.ts";
import {
  loadCostSummary,
  loadCostTimeseries,
  loadCostByModel,
  loadTopSessions,
  loadLedgerItems,
  deleteLedgerItem,
  exportCostData,
} from "./controllers/cost.ts";
import { renderCost } from "./views/cost.ts";

let costDateDebounceTimeout: number | null = null;

async function loadAllCostData(state: AppViewState): Promise<void> {
  if (!state.client || !state.connected) {
    return;
  }

  state.costLoading = true;
  state.costError = null;

  try {
    const [summary, timeseries, byModel, topSessions, ledgerItems] = await Promise.all([
      loadCostSummary(state.client, state.costStartDate, state.costEndDate),
      loadCostTimeseries(state.client, state.costStartDate, state.costEndDate),
      loadCostByModel(state.client, state.costStartDate, state.costEndDate),
      loadTopSessions(state.client, state.costStartDate, state.costEndDate),
      loadLedgerItems(state.client),
    ]);

    state.costSummary = summary;
    state.costTimeseries = timeseries;
    state.costByModel = byModel;
    state.costTopSessions = topSessions;
    state.costLedgerItems = ledgerItems;
  } catch (err) {
    state.costError = err instanceof Error ? err.message : String(err);
  } finally {
    state.costLoading = false;
  }
}

function debouncedLoadCost(state: AppViewState): void {
  if (costDateDebounceTimeout) {
    clearTimeout(costDateDebounceTimeout);
  }
  costDateDebounceTimeout = window.setTimeout(() => void loadAllCostData(state), 400);
}

export function renderCostTab(state: AppViewState) {
  if (state.tab !== "cost") {
    return nothing;
  }

  return renderCost({
    state: {
      client: state.client,
      connected: state.connected,
      loading: state.costLoading,
      error: state.costError,
      startDate: state.costStartDate,
      endDate: state.costEndDate,
      summary: state.costSummary,
      timeseries: state.costTimeseries,
      byModel: state.costByModel,
      topSessions: state.costTopSessions,
      ledgerItems: state.costLedgerItems,
      ledgerLoading: state.costLedgerLoading,
      activeTab: state.costActiveTab,
    },
    onDateChange: (startDate, endDate) => {
      state.costStartDate = startDate;
      state.costEndDate = endDate;
      debouncedLoadCost(state);
    },
    onPresetClick: (days) => {
      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - days + 1);

      state.costEndDate = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")}`;
      state.costStartDate = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`;

      void loadAllCostData(state);
    },
    onRefresh: () => loadAllCostData(state),
    onTabChange: (tab) => {
      state.costActiveTab = tab;
    },
    onExport: async (format) => {
      if (!state.client) {
        return;
      }
      try {
        const data = await exportCostData(
          state.client,
          state.costStartDate,
          state.costEndDate,
          format,
        );

        const blob = new Blob([data], {
          type: format === "csv" ? "text/csv" : "application/json",
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `cost-export-${state.costStartDate}-to-${state.costEndDate}.${format}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch (err) {
        state.costError = err instanceof Error ? err.message : String(err);
      }
    },
    onDeleteLedgerItem: async (id) => {
      if (!state.client) {
        return;
      }
      try {
        await deleteLedgerItem(state.client, id);
        state.costLedgerItems = state.costLedgerItems.filter((item) => item.id !== id);
      } catch (err) {
        state.costError = err instanceof Error ? err.message : String(err);
      }
    },
  });
}
