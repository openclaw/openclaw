// Types
export type {
  CompletionLevel,
  TurnCompletionEvent,
  RunCompletionEvent,
  QueueCompletionEvent,
  CompletionEvent,
  ContinuationAction,
  ContinuationDecision,
  GoalState,
  CompletionHandler,
  CompletionHandlerRegistration,
} from "./types.js";

// Registry
export {
  onCompletion,
  processCompletion,
  clearCompletionHandlers,
  getHandlerCount,
} from "./registry.js";

// Emit functions
export { emitTurnCompletion, emitRunCompletion, emitQueueCompletion } from "./emit.js";

// Goal state persistence
export { persistGoalState, clearGoalState } from "./goal-state.js";

// Manager
export {
  initContinuationManager,
  stopContinuationManager,
  isManagerInitialized,
  registerSignalDetector,
  setSessionGoal,
  clearSessionGoal,
  getManagedSession,
  getSessionSignals,
  clearManagerState,
  resetSignalDetectors,
  type ContinuationSignal,
  type SignalDetector,
} from "./manager.js";
