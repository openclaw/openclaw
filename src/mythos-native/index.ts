/**
 * Mythos Native Bridge — TypeScript ↔ Rust Integration Layer
 *
 * This module provides the integration between OpenClaw's TypeScript codebase
 * and the Rust-based Mythos performance engines. Each native module is loaded
 * with graceful fallback to the existing JavaScript implementation.
 *
 * Architecture:
 *
 *   ┌─────────────────────────────────────────────────────────┐
 *   │  TypeScript (OpenClaw memory-core, gateway, agents)      │
 *   │  searchVector() → nativeVector.search()                  │
 *   │  searchKeyword() → nativeSearch.search()                 │
 *   │  embed() → nativeEmbed.embed()                           │
 *   │  sandbox.exec() → nativeSandbox.exec()                   │
 *   │  parseFrame() → nativeCodec.parseFrame()                 │
 *   │  findCausalChains() → nativeGraph.findCausalChains()     │
 *   └────────────────────┬────────────────────────────────────┘
 *                        │ Dynamic import (NAPI)
 *   ┌────────────────────┼────────────────────────────────────┐
 *   │  Rust (mythos-* crates via napi-rs)                      │
 *   │  • mythos-vector-engine    (HNSW via usearch)            │
 *   │  • mythos-search-engine    (BM25 via tantivy)            │
 *   │  • mythos-embedding-runtime(GPU via candle)              │
 *   │  • mythos-execution-sandbox(seccomp-bpf)                  │
 *   │  • mythos-protocol-codec   (simd-json)                   │
 *   │  • mythos-causal-graph     (petgraph)                    │
 *   └─────────────────────────────────────────────────────────┘
 *
 * Graceful Fallback:
 *   If a native module fails to load (not compiled, wrong platform, etc.),
 *   the bridge falls back to the existing JavaScript implementation.
 *   This ensures OpenClaw works without Rust compilation.
 */

// ─── Vector Engine ────────────────────────────────────────────────────────────

export interface NativeVectorIndex {
  new (
    dimensions: number,
    metric: "cosine" | "euclidean" | "innerProduct",
    maxElements?: number,
    efConstruction?: number,
    m?: number,
  ): NativeVectorIndexInstance;
  load(indexPath: string): NativeVectorIndexInstance;
}

export interface NativeVectorIndexInstance {
  save(indexPath: string): void;
  addBatch(
    ids: string[],
    vectors: number[],
    paths: string[],
    startLines: number[],
    endLines: number[],
  ): number;
  search(query: number[], topK: number): Promise<NativeSearchResult[]>;
  removeBatch(ids: string[]): number;
  stats(): NativeIndexStats;
  readonly size: number;
  has(id: string): boolean;
  clear(): void;
}

export interface NativeSearchResult {
  id: string;
  score: number;
  path: string;
  startLine: number;
  endLine: number;
}

export interface NativeIndexStats {
  totalVectors: number;
  dimensions: number;
  maxElements: number;
  memoryBytes: number;
  metric: string;
  m: number;
  efConstruction: number;
}

// ─── Search Engine ────────────────────────────────────────────────────────────

export interface NativeSearchIndex {
  new (indexPath: string, tokenizer?: string): NativeSearchIndexInstance;
  open(indexPath: string): NativeSearchIndexInstance;
}

export interface NativeSearchIndexInstance {
  indexBatch(docs: NativeIndexDocument[]): Promise<number>;
  search(
    query: string,
    topK: number,
    filters?: NativeSearchFilters,
  ): Promise<NativeTextSearchResult[]>;
  deleteBatch(ids: string[]): number;
  commit(): void;
  stats(): NativeSearchStats;
  readonly docCount: number;
}

export interface NativeIndexDocument {
  id: string;
  path: string;
  text: string;
  startLine: number;
  endLine: number;
  metadata?: string;
}

export interface NativeTextSearchResult {
  id: string;
  path: string;
  score: number;
  snippet: string;
  startLine: number;
  endLine: number;
}

export interface NativeSearchFilters {
  pathPrefix?: string;
  minScore?: number;
  dateAfter?: number;
}

export interface NativeSearchStats {
  docCount: number;
  sizeBytes: number;
  segmentCount: number;
}

// ─── Protocol Codec ───────────────────────────────────────────────────────────

export interface NativeProtocolCodec {
  new (maxPayload?: number): NativeProtocolCodecInstance;
}

export interface NativeProtocolCodecInstance {
  parseFrame(data: Buffer): NativeParsedFrame;
  serializeResponse(
    id: string,
    ok: string | null,
    error: NativeErrorPayload | null,
  ): Buffer;
  serializeEvent(event: string, data: string): Buffer;
  validateFrame(data: Buffer): NativeValidationResult;
  readonly maxPayloadSize: number;
}

export interface NativeParsedFrame {
  frameType: string;
  id?: string;
  method?: string;
  event?: string;
  payloadRaw?: string;
  valid: boolean;
  error?: string;
}

export interface NativeErrorPayload {
  code: string;
  message: string;
  details?: string;
  retryable?: boolean;
  retryAfterMs?: number;
}

export interface NativeValidationResult {
  valid: boolean;
  frameSize: number;
  maxPayload: number;
  error?: string;
}

// ─── Causal Graph ─────────────────────────────────────────────────────────────

export interface NativeCausalGraph {
  new (): NativeCausalGraphInstance;
  load(path: string): NativeCausalGraphInstance;
}

export interface NativeCausalGraphInstance {
  save(path: string): void;
  addNode(node: NativeGraphNode): string;
  addEdge(
    from: string,
    to: string,
    relation: string,
    weight: number,
    sourceSession?: string,
  ): void;
  findCausalChains(
    startId: string,
    maxDepth: number,
    minWeight?: number,
  ): NativeCausalPath[];
  findRelated(nodeId: string, maxResults: number): NativeGraphNode[];
  temporalQuery(
    startTime: number,
    endTime: number,
    nodeType?: string,
  ): NativeGraphNode[];
  getNode(id: string): NativeGraphNode | null;
  removeNode(id: string): boolean;
  merge(other: NativeCausalGraphInstance): NativeMergeStats;
  stats(): NativeGraphStats;
  readonly nodeCount: number;
  readonly edgeCount: number;
}

export interface NativeGraphNode {
  id: string;
  nodeType: string;
  content: string;
  timestamp: number;
  confidence: number;
  metadata?: string;
}

export interface NativeCausalPath {
  nodes: NativeGraphNode[];
  edges: Array<{
    from: string;
    to: string;
    relation: string;
    weight: number;
    timestamp: number;
    sourceSession?: string;
  }>;
  totalWeight: number;
  confidence: number;
}

export interface NativeMergeStats {
  nodesAdded: number;
  nodesUpdated: number;
  edgesAdded: number;
  conflicts: number;
}

export interface NativeGraphStats {
  nodeCount: number;
  edgeCount: number;
  nodeTypes: Record<string, number>;
  relationTypes: Record<string, number>;
}

// ─── Module Loader ────────────────────────────────────────────────────────────

/**
 * Attempt to load a native Rust module. Returns null if not available.
 *
 * The module name corresponds to the NAPI-RS generated .node file.
 * In development: crates/mythos-*/index.node
 * In production: node_modules/@openclaw/mythos-*/index.node
 */
async function tryLoadNative<T>(moduleName: string): Promise<T | null> {
  try {
    const mod = await import(moduleName);
    return mod as T;
  } catch {
    // Native module not available — will fall back to JS implementation
    return null;
  }
}

/**
 * Load all available native modules.
 * Returns a map of module name → loaded module (or null if unavailable).
 */
export async function loadAllNativeModules(): Promise<{
  vectorEngine: NativeVectorIndex | null;
  searchEngine: NativeSearchIndex | null;
  protocolCodec: NativeProtocolCodec | null;
  causalGraph: NativeCausalGraph | null;
}> {
  const [vectorEngine, searchEngine, protocolCodec, causalGraph] =
    await Promise.all([
      tryLoadNative<NativeVectorIndex>("@openclaw/mythos-vector-engine"),
      tryLoadNative<NativeSearchIndex>("@openclaw/mythos-search-engine"),
      tryLoadNative<NativeProtocolCodec>("@openclaw/mythos-protocol-codec"),
      tryLoadNative<NativeCausalGraph>("@openclaw/mythos-causal-graph"),
    ]);

  return { vectorEngine, searchEngine, protocolCodec, causalGraph };
}

// ─── Diagnostic ───────────────────────────────────────────────────────────────

/**
 * Check which native modules are available.
 * Used by `openclaw doctor` to report Rust integration status.
 */
export async function checkNativeModuleAvailability(): Promise<{
  available: string[];
  unavailable: string[];
  details: Record<string, string>;
}> {
  const modules = await loadAllNativeModules();
  const available: string[] = [];
  const unavailable: string[] = [];
  const details: Record<string, string> = {};

  for (const [name, mod] of Object.entries(modules)) {
    if (mod !== null) {
      available.push(name);
      details[name] = "loaded";
    } else {
      unavailable.push(name);
      details[name] = "not available (falling back to JS)";
    }
  }

  return { available, unavailable, details };
}
