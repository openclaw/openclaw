import type { ResolveMarkdownTableModeParams } from "./markdown-tables.types.js";
import type { MarkdownTableMode } from "./types.base.js";
export declare const DEFAULT_TABLE_MODES: ReadonlyMap<string, MarkdownTableMode>;
export type { ResolveMarkdownTableMode, ResolveMarkdownTableModeParams, } from "./markdown-tables.types.js";
export declare function resolveMarkdownTableMode(params: ResolveMarkdownTableModeParams): MarkdownTableMode;
