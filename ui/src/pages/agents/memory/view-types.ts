import type { AgentMemoryState } from "./memory-panel-state.ts";

export type DreamingProps = ReturnType<AgentMemoryState["view"]>["dreaming"];
