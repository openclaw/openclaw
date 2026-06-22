import { definePage } from "../../router/index.ts";
import type { AppViewState } from "../../ui/app-view-state.ts";

type ActivityRenderContext = { state: AppViewState };

export const page = definePage({
  id: "activity",
  path: "/activity",
  component: () =>
    import("./view.ts").then((module) => ({
      render: ({ state }: ActivityRenderContext) =>
        module.renderActivity({
          entries: state.activityEntries,
          filterText: state.activityFilterText,
          statusFilters: state.activityStatusFilters,
          toolFilter: state.activityToolFilter,
          expandedIds: state.activityExpandedIds,
          autoFollow: state.activityAutoFollow,
          onFilterTextChange: (next) => (state.activityFilterText = next),
          onToolFilterChange: (next) => (state.activityToolFilter = next),
          onStatusToggle: (status, enabled) => {
            state.activityStatusFilters = {
              ...state.activityStatusFilters,
              [status]: enabled,
            };
          },
          onToggleAutoFollow: (next) => {
            state.activityAutoFollow = next;
            if (next) {
              state.scheduleActivityScroll(true);
            }
          },
          onClear: () => {
            state.activityEntries = [];
            state.activityExpandedIds = new Set();
            state.activityAtBottom = true;
          },
          onExpandAll: () => {
            state.activityExpandedIds = new Set(state.activityEntries.map((entry) => entry.id));
          },
          onCollapseAll: () => {
            state.activityExpandedIds = new Set();
          },
          onEntryToggle: (id, open) => {
            const next = new Set(state.activityExpandedIds);
            if (open) {
              next.add(id);
            } else {
              next.delete(id);
            }
            state.activityExpandedIds = next;
          },
          onScroll: (event) => state.handleActivityScroll(event),
        }),
      onStateChange: ({ state }: ActivityRenderContext, changed) => {
        if (
          state.activityAutoFollow &&
          state.activityAtBottom &&
          (changed.has("activityEntries") || changed.has("activityAutoFollow"))
        ) {
          state.scheduleActivityScroll(changed.has("activityAutoFollow"));
        }
      },
    })),
});
