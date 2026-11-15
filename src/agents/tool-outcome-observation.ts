import type { AgentTool } from "../../packages/agent-core/src/types.js";

export type ToolOutcomeObservation = {
  toolName: string;
  argsHash: string;
  resultHash: string;
  resultContentSource?: AgentTool["resultContentSource"];
  /** Monotonic model-call order within the owning embedded run. */
  toolCallOrdinal?: number;
  terminalPresentation?: string;
  presentationOnly?: boolean;
};

export type ToolOutcomeObserver = (observation: ToolOutcomeObservation) => void;
