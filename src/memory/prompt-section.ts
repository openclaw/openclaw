import type { MemoryCitationsMode } from "../config/types.memory.js";

/**
 * Callback that the active memory plugin provides to build
 * its section of the agent system prompt.
 */
export type MemoryPromptSectionBuilder = (params: {
  availableTools: Set<string>;
  citationsMode?: MemoryCitationsMode;
}) => string[];

// Module-level singleton — only one memory plugin can be active (exclusive slot).
let _builder: MemoryPromptSectionBuilder | undefined;

export function registerMemoryPromptSection(builder: MemoryPromptSectionBuilder): void {
  _builder = builder;
}

export function buildMemoryPromptSection(params: {
  availableTools: Set<string>;
  citationsMode?: MemoryCitationsMode;
}): string[] {
  return _builder?.(params) ?? [];
}

/** Reset state (for tests). */
export function _resetMemoryPromptSection(): void {
  _builder = undefined;
}
