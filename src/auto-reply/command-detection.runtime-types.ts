/** Runtime type contracts for command-detection helpers loaded across lazy boundaries. */
import type {
  isControlCommandMessage,
  shouldComputeCommandAuthorized,
} from "./command-detection.js";

/** Runtime-injected predicate for deciding whether visible text is an OpenClaw command. */
export type IsControlCommandMessage = typeof isControlCommandMessage;

/** Runtime-injected predicate for deciding whether command authorization must be computed. */
export type ShouldComputeCommandAuthorized = typeof shouldComputeCommandAuthorized;
