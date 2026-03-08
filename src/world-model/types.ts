export type WorldModelState = {
  sessionId?: string;
  runId?: string;
  /** comprehensive snapshot of the conversation history or current context */
  messages?: unknown[];
  /** snapshot of relevant memory/knowledge retrieval context if available */
  context?: string;
};

export type WorldModelAction = {
  type: "text" | "tool_call" | "message_start" | "message_end" | "tool_execution_end";
  content?: unknown;
  role?: string;
  toolName?: string;
  toolCallId?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: unknown;
  isError?: boolean;
  usage?: unknown;
  /** Confidence score of the prediction (0.0 to 1.0) */
  confidence?: number;
  /** Reasoning behind the prediction or simulation */
  explanation?: string;
};

export interface IWorldModel {
  /**
   * Called when the agent observes a new state or performs an action.
   * Used for training (data collection) or logging.
   */
  observe(state: WorldModelState, action: WorldModelAction): Promise<void>;

  /**
   * Called to request a prediction from the world model.
   * Used for inference (runtime critique or guidance).
   */
  predict(state: WorldModelState): Promise<WorldModelAction[]>;

  /**
   * The Core "Dream" Step.
   * Predicts the next state given a current state and a hypothetical action.
   * This allows the agent to ask "What if I do X?" (Counterfactual simulation).
   */
  simulate(state: WorldModelState, action: WorldModelAction): Promise<WorldModelState>;
}
