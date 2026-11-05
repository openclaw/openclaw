import type { AgentMemoryState } from "./memory-panel-state.ts";

export type DreamingProps = ReturnType<AgentMemoryState["view"]>["dreaming"] & {
  configOpening?: boolean;
  dreamDiaryActionLoading: boolean;
  header: ReturnType<AgentMemoryState["view"]>["header"];
  onRefresh: () => void;
  onSetEnabled: (enabled: boolean) => void;
};
