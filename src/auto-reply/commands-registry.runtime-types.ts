import type { shouldHandleTextCommands } from "./commands-text-routing.js";

/** Runtime-injected policy hook for whether text slash commands should be honored. */
export type ShouldHandleTextCommands = typeof shouldHandleTextCommands;
