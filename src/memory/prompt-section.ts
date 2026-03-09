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

/** Clear the registered builder (called on plugin reload and in tests). */
export function clearMemoryPromptSection(): void {
  _builder = undefined;
}

/** @deprecated Use {@link clearMemoryPromptSection}. */
export const _resetMemoryPromptSection = clearMemoryPromptSection;
