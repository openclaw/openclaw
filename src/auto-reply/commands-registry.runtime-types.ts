/** Runtime type contracts for command routing helpers loaded across lazy boundaries. */
import type { shouldHandleTextCommands } from "./commands-text-routing.js";

/** Runtime-injected policy hook for whether text slash commands should be honored. */
export type ShouldHandleTextCommands = typeof shouldHandleTextCommands;
