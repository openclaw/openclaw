/**
 * Session FTS + hybrid ranking for gateway session search/recall.
 * Re-exports memory-core implementation so gateway code imports via plugin-sdk only
 * (see AGENTS.md: avoid deep-importing bundled plugin src trees from gateway core).
 */
export { bm25RankToScore, buildFtsQuery } from "../../extensions/memory-core/src/memory/hybrid.js";
export {
  searchKeyword,
  type SearchRowResult,
} from "../../extensions/memory-core/src/memory/manager-search.js";
