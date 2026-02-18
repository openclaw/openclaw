/**
 * Houdini Claw - Knowledge Base Module
 *
 * Central module for the Houdini Claw knowledge base system.
 * Provides structured annotations, semantic search, and query capabilities
 * for Houdini node documentation, parameter ranges, recipes, and error patterns.
 *
 * Architecture:
 *   Backend (Cron):  crawl.ts → annotate.ts → ingest.ts → SQLite + sqlite-vec
 *   Frontend (Query): query.ts → db.ts → vector-search.ts → JSON response
 *   Seed data:       seed.ts → db.ts (human-verified baseline)
 */

export { initDatabase, KnowledgeBase, resolveDbPath } from "./db.js";
export { SCHEMA_SQL, VECTOR_TABLE_SQL } from "./schema.js";
export type {
  NodeCategory,
  SimulationSystem,
  ParameterAnnotation,
  Recipe,
  ErrorPattern,
} from "./schema.js";
export {
  generateEmbedding,
  semanticSearch,
  rebuildIndex,
  indexChunk,
  chunkNodeAnnotation,
  chunkParameterAnnotation,
} from "./vector-search.js";
export type { SearchResult } from "./vector-search.js";
export {
  runCrawl,
  crawlSideFxDoc,
  parseSideFxNodeDoc,
  discoverNodesFromSitemap,
  resolveNodePaths,
  ALL_NODE_PATHS,
} from "./crawl.js";
export type {
  CrawledPage,
  ParsedNodeDoc,
  DocParameter,
  DiscoveredNode,
} from "./crawl.js";
export { annotateNode, annotateAll } from "./annotate.js";
export { ingestAll } from "./ingest.js";
export { seedDatabase } from "./seed.js";
