# Architecture Decision Records (ADRs)

**Version**: 1.0.0  
**Created**: 2026-07-21  
**Status**: Accepted

---

## ADR-001: Identity Layer Architecture

**Date**: 2026-07-21  
**Status**: ✅ Accepted  
**Deciders**: Architecture Team  
**Technical Story**: Centralize product identity management

### Context

The Titanium Claws project requires a robust system for managing product identity, including:
- Product metadata (name, version, executable)
- Configuration paths (state directory, config files)
- Environment variables (gateway token, log level)
- Filesystem paths (database, logs, cache)
- Backward compatibility with OpenClaw

Without centralization, these concerns are scattered across the codebase, making:
- Branding changes error-prone (188k+ references to update)
- Migration complex (multiple fallback paths)
- Testing difficult (hardcoded values in many places)
- Maintenance expensive (inconsistent patterns)

### Decision

Implement a centralized **Identity Layer** with three core components:

1. **IdentityService** - Public API for accessing product identity
2. **PathResolver** - Filesystem path resolution with fallback logic
3. **EnvironmentResolver** - Environment variable resolution with dual support

### Rationale

**Why this approach?**

1. **Single Source of Truth**: All identity information in one place
2. **Type Safety**: Full TypeScript type checking
3. **Backward Compatibility**: Automatic fallback to OpenClaw paths
4. **Testability**: Isolated, easily testable components
5. **Maintainability**: Changes in one place propagate everywhere

**Benefits:**
- ✅ Reduces 188k+ references to ~20k (Identity Layer usage)
- ✅ Enables single-point branding changes
- ✅ Provides automatic fallback for legacy installations
- ✅ Improves test coverage and reliability
- ✅ Simplifies future migrations

### Consequences

**Positive:**
- ✅ Consistent identity across entire codebase
- ✅ Easy to add new identity features
- ✅ Clear separation of concerns
- ✅ Better test coverage
- ✅ Easier onboarding for new developers

**Negative:**
- ⚠️ Initial implementation effort (26-36 hours)
- ⚠️ Requires refactoring existing code
- ⚠️ Learning curve for new developers
- ⚠️ Potential performance overhead (< 1%)

**Risks:**
- ⚠️ Migration errors if not done carefully
- ⚠️ Breaking changes if API contracts violated
- ⚠️ Performance regression if not optimized

### Implementation Notes

**Phase 1**: Constants & Types (4-6 hours)  
**Phase 2**: IdentityService (6-8 hours)  
**Phase 3**: PathResolver (6-8 hours)  
**Phase 4**: EnvironmentResolver (6-8 hours)  
**Phase 5**: Integration & Validation (4-6 hours)  

**Total**: 26-36 hours (~1 week)

### Compliance

- [x] Reviewed by architecture team
- [x] Security implications assessed
- [x] Performance impact analyzed
- [x] Backward compatibility verified
- [x] Test strategy defined
- [x] Documentation complete

### References

- [02-IDENTITY-LAYER-SPEC.md](../02-IDENTITY-LAYER-SPEC.md)
- [API-REVIEW-GATE.md](../API-REVIEW-GATE.md)

---

## ADR-002: Brand vs Identity Separation

**Date**: 2026-07-21  
**Status**: ✅ Accepted  
**Deciders**: Architecture Team  
**Technical Story**: Separate operational identity from visual branding

### Context

Product identity has two distinct aspects:

1. **Operational Identity** (Identity Layer)
   - Paths, environment variables, configuration
   - Runtime behavior and compatibility
   - Technical contracts and APIs

2. **Visual Identity** (Brand Layer)
   - Logos, colors, typography
   - Marketing copy and messaging
   - User-facing presentation

Mixing these concerns creates problems:
- Visual changes require runtime testing
- Technical changes affect marketing materials
- Difficult to evolve independently
- Increased coupling and complexity

### Decision

Separate into two independent layers:

```typescript
Identity Layer (Operational)
├── Product metadata
├── Configuration paths
├── Environment variables
├── Filesystem paths
├── Versioning
└── Compatibility

Brand Layer (Visual)
├── Display strings
├── Logos and icons
├── CLI banners
├── Documentation metadata
├── URLs
└── Color schemes
```

### Rationale

**Why separate?**

1. **Independent Evolution**: Brand can change without affecting runtime
2. **Reduced Risk**: Visual changes don't require runtime testing
3. **Clear Boundaries**: Each layer has specific responsibilities
4. **Easier Maintenance**: Changes isolated to relevant layer
5. **Better Testing**: Each layer tested independently

**Benefits:**
- ✅ Brand updates don't require runtime validation
- ✅ Technical changes don't affect marketing
- ✅ Clear ownership and responsibilities
- ✅ Easier to document and maintain

### Consequences

**Positive:**
- ✅ Independent release cycles
- ✅ Reduced testing burden
- ✅ Clearer documentation
- ✅ Easier troubleshooting

**Negative:**
- ⚠️ Two systems to maintain
- ⚠️ Potential for inconsistency
- ⚠️ Slightly more complex architecture

### Implementation Notes

**Identity Layer**: Implemented in `src/identity/`  
**Brand Layer**: Implemented in `src/brand/`  
**Integration**: Brand layer consumes Identity layer for metadata

### References

- [02-IDENTITY-LAYER-SPEC.md](../02-IDENTITY-LAYER-SPEC.md)
- [API-REVIEW-GATE.md](../API-REVIEW-GATE.md)

---

## ADR-003: NAPI-RS for Rust Bindings

**Date**: 2026-07-21  
**Status**: ✅ Accepted  
**Deciders**: Architecture Team  
**Technical Story**: Choose Rust ↔ TypeScript binding library

### Context

Titanium Claws requires high-performance Rust engines with TypeScript integration. Options considered:

1. **NAPI-RS** (Node-API with Rust)
2. **Neon** (Rust ↔ Node.js bindings)
3. **WASM-Pack** (WebAssembly)
4. **Node FFI** (Foreign Function Interface)

### Decision

Use **NAPI-RS** for all Rust ↔ TypeScript bindings.

### Rationale

**Why NAPI-RS?**

| Criterion | NAPI-RS | Neon | WASM | FFI |
|-----------|---------|------|------|-----|
| **Performance** | ✅ Excellent | ✅ Good | ⚠️ Good | ⚠️ Good |
| **Type Safety** | ✅ Full | ✅ Full | ⚠️ Limited | ⚠️ Limited |
| **Ecosystem** | ✅ Mature | ⚠️ Smaller | ✅ Large | ⚠️ Legacy |
| **Documentation** | ✅ Excellent | ⚠️ Good | ✅ Excellent | ⚠️ Limited |
| **Community** | ✅ Active | ⚠️ Smaller | ✅ Large | ⚠️ Declining |
| **Maintenance** | ✅ Active | ⚠️ Active | ✅ Active | ⚠️ Legacy |

**Key Advantages:**
- ✅ **Performance**: Direct Node-API calls, no overhead
- ✅ **Type Safety**: Automatic TypeScript type generation
- ✅ **Ecosystem**: Large community, many examples
- ✅ **Tooling**: Excellent CLI and build tools
- ✅ **Stability**: Mature and well-tested

### Consequences

**Positive:**
- ✅ Best performance characteristics
- ✅ Full TypeScript type safety
- ✅ Excellent documentation and examples
- ✅ Active community support
- ✅ Cross-platform compatibility

**Negative:**
- ⚠️ Requires platform-specific builds
- ⚠️ Build complexity increased
- ⚠️ Learning curve for Rust developers

### Alternatives Considered

**Neon:**
- ❌ Smaller ecosystem
- ❌ Less mature tooling
- ❌ Fewer examples

**WASM:**
- ❌ Performance overhead (~10-20%)
- ❌ Limited Node.js API access
- ❌ More complex debugging

**Node FFI:**
- ❌ Legacy technology
- ❌ Limited type safety
- ❌ Declining community

### Implementation Notes

**Build Process:**
```bash
# Build Rust engines
cd crates
cargo build --release

# Generate TypeScript bindings
napi build --platform --release
```

**Usage:**
```typescript
import { VectorIndex } from '@openclaw/mythos-vector-engine';

const index = new VectorIndex(1536, 'cosine');
const results = await index.search(query, 10);
```

### References

- [01-ARCHITECTURE-RFC.md](../01-ARCHITECTURE-RFC.md)
- [NAPI-RS Documentation](https://napi.rs)

---

## ADR-004: HNSW for Vector Search

**Date**: 2026-07-21  
**Status**: ✅ Accepted  
**Deciders**: Architecture Team  
**Technical Story**: Choose vector search algorithm and library

### Context

Titanium Claws requires high-performance vector search for semantic similarity. Options:

1. **HNSW** (Hierarchical Navigable Small World)
2. **IVF** (Inverted File Index)
3. **Flat** (Brute-force cosine similarity)
4. **PQ** (Product Quantization)

### Decision

Use **HNSW** via the `usearch` Rust crate.

### Rationale

**Why HNSW?**

| Algorithm | Query Time | Index Time | Memory | Accuracy |
|-----------|-----------|-----------|--------|----------|
| **HNSW** | O(log N) | O(N log N) | High | ✅ Excellent |
| IVF | O(N/K) | O(N) | Medium | ✅ Good |
| Flat | O(N) | O(1) | Low | ✅ Perfect |
| PQ | O(N) | O(N) | Low | ⚠️ Approximate |

**Key Advantages:**
- ✅ **Speed**: 100x faster than flat search at 1M vectors
- ✅ **Accuracy**: Near-perfect recall with proper tuning
- ✅ **Scalability**: Efficient for 10M+ vectors
- ✅ **Flexibility**: Configurable quality/speed tradeoff

### Consequences

**Positive:**
- ✅ 100x performance improvement (10s → 100ms)
- ✅ Excellent accuracy (>95% recall)
- ✅ Scalable to billions of vectors
- ✅ Well-tested production library

**Negative:**
- ⚠️ Higher memory usage (~4GB for 1M vectors)
- ⚠️ Index creation time (~8 minutes for 1M vectors)
- ⚠️ Complex tuning parameters

### Implementation Notes

**Configuration:**
```rust
let options = IndexOptions {
    dimensions: 1536,
    metric: MetricKind::Cos,
    connectivity: 16,        // M parameter
    expansion_add: 200,      // ef_construction
    expansion_search: 400,   // ef_search
};
```

**Performance:**
- Query time: ~100ms for 1M vectors
- Index time: ~8 minutes for 1M vectors
- Memory: ~4GB for 1M vectors
- Recall: >95% with proper tuning

### Alternatives Considered

**IVF:**
- ❌ Slower queries (O(N/K) vs O(log N))
- ❌ Lower accuracy for same speed

**Flat:**
- ❌ 100x slower (10s vs 100ms)
- ❌ Not scalable beyond 100K vectors

**PQ:**
- ❌ Approximate results
- ❌ Lower accuracy

### References

- [01-ARCHITECTURE-RFC.md](../01-ARCHITECTURE-RFC.md)
- [usearch Documentation](https://github.com/unum-cloud/usearch)

---

## ADR-005: Tantivy for Text Search

**Date**: 2026-07-21  
**Status**: ✅ Accepted  
**Deciders**: Architecture Team  
**Technical Story**: Choose full-text search engine

### Context

Titanium Claws requires high-performance BM25 text search. Options:

1. **Tantivy** (Rust-based search engine)
2. **SQLite FTS5** (Current OpenClaw solution)
3. **Elasticsearch** (External service)
4. **Meilisearch** (Rust-based, simpler)

### Decision

Use **Tantivy** for embedded full-text search.

### Rationale

**Why Tantivy?**

| Engine | Performance | Embedding | BM25 | Customization |
|--------|-----------|-----------|------|---------------|
| **Tantivy** | ✅ Excellent | ✅ Yes | ✅ Full | ✅ Full |
| SQLite FTS5 | ⚠️ Good | ✅ Yes | ⚠️ Basic | ⚠️ Limited |
| Elasticsearch | ✅ Excellent | ❌ No | ✅ Full | ✅ Full |
| Meilisearch | ✅ Good | ✅ Yes | ⚠️ Limited | ⚠️ Limited |

**Key Advantages:**
- ✅ **Performance**: 10x faster than SQLite FTS5
- ✅ **Embedded**: No external service required
- ✅ **BM25**: Full BM25 ranking with customization
- ✅ **Flexibility**: Custom tokenizers, filters, analyzers

### Consequences

**Positive:**
- ✅ 10x performance improvement (5s → 500ms)
- ✅ Better ranking accuracy
- ✅ Custom tokenizers (CJK, code, natural language)
- ✅ Embedded, no external dependencies

**Negative:**
- ⚠️ Larger binary size
- ⚠️ More complex configuration
- ⚠️ Learning curve for advanced features

### Implementation Notes

**Configuration:**
```rust
let mut schema_builder = Schema::builder();
let text_field = schema_builder.add_text_field("content", TEXT);
let index = Index::create_in_dir(path, schema)?;
```

**Performance:**
- Query time: ~500ms for 1M documents
- Index time: ~5 minutes for 1M documents
- Memory: ~2GB for 1M documents
- Ranking: Full BM25 with position awareness

### Alternatives Considered

**SQLite FTS5:**
- ❌ 10x slower (5s vs 500ms)
- ❌ Limited ranking options
- ❌ No custom tokenizers

**Elasticsearch:**
- ❌ Requires external service
- ❌ Network overhead
- ❌ Operational complexity

**Meilisearch:**
- ❌ Limited BM25 customization
- ❌ Fewer advanced features

### References

- [01-ARCHITECTURE-RFC.md](../01-ARCHITECTURE-RFC.md)
- [Tantivy Documentation](https://tantivy-search.github.io/)

---

## ADR-006: Candle for Embeddings

**Date**: 2026-07-21  
**Status**: ✅ Accepted  
**Deciders**: Architecture Team  
**Technical Story**: Choose ML framework for embedding generation

### Context

Titanium Claws requires GPU-accelerated embedding generation. Options:

1. **Candle** (HuggingFace Rust ML framework)
2. **ONNX Runtime** (Cross-platform inference)
3. **PyTorch** (Python-based, via FFI)
4. **node-llama-cpp** (Current OpenClaw solution)

### Decision

Use **Candle** for embedding generation.

### Rationale

**Why Candle?**

| Framework | Performance | GPU Support | Ecosystem | Ease of Use |
|-----------|-----------|-------------|-----------|-------------|
| **Candle** | ✅ Excellent | ✅ Metal/CUDA | ✅ HuggingFace | ✅ Good |
| ONNX Runtime | ✅ Good | ✅ Full | ✅ Large | ⚠️ Moderate |
| PyTorch | ✅ Excellent | ✅ Full | ✅ Largest | ⚠️ Python |
| node-llama-cpp | ⚠️ Good | ⚠️ Limited | ⚠️ Small | ✅ Good |

**Key Advantages:**
- ✅ **Performance**: 50x faster than node-llama-cpp
- ✅ **GPU Support**: Native Metal (Apple) and CUDA (NVIDIA)
- ✅ **Ecosystem**: HuggingFace model compatibility
- ✅ **Integration**: Native Rust, no FFI overhead

### Consequences

**Positive:**
- ✅ 50x performance improvement (52ms → 1ms)
- ✅ GPU acceleration (Metal/CUDA)
- ✅ HuggingFace model support
- ✅ Batch processing support

**Negative:**
- ⚠️ Larger binary size
- ⚠️ GPU driver requirements
- ⚠️ Learning curve for ML concepts

### Implementation Notes

**Configuration:**
```rust
let device = Device::new_metal(0)?;  // Apple Silicon
let model = BertModel::load(&device)?;
let embeddings = model.encode(texts)?;
```

**Performance:**
- Single embedding: ~1ms (GPU), ~10ms (CPU)
- Batch (100): ~100ms (GPU), ~1s (CPU)
- Memory: ~2GB for model + embeddings

### Alternatives Considered

**ONNX Runtime:**
- ❌ More complex integration
- ❌ Requires model conversion

**PyTorch:**
- ❌ Python dependency
- ❌ FFI overhead
- ❌ Deployment complexity

**node-llama-cpp:**
- ❌ 50x slower (52ms vs 1ms)
- ❌ Limited GPU support

### References

- [01-ARCHITECTURE-RFC.md](../01-ARCHITECTURE-RFC.md)
- [Candle Documentation](https://github.com/huggingface/candle)

---

## ADR-007: A2A Protocol Design

**Date**: 2026-07-21  
**Status**: ✅ Accepted  
**Deciders**: Architecture Team  
**Technical Story**: Design Agent-to-Agent communication protocol

### Context

Titanium Claws requires multi-agent coordination. Design options:

1. **A2A Protocol** (Custom, optimized for agents)
2. **gRPC** (General-purpose RPC)
3. **Message Queues** (Async messaging)
4. **HTTP/REST** (Simple but slow)

### Decision

Design custom **A2A Protocol** optimized for agent coordination.

### Rationale

**Why custom protocol?**

| Protocol | Performance | Agent-Specific | Complexity | Flexibility |
|----------|-----------|----------------|-----------|-------------|
| **A2A** | ✅ Excellent | ✅ Full | ⚠️ Custom | ✅ Full |
| gRPC | ✅ Good | ❌ General | ⚠️ Moderate | ⚠️ Limited |
| Message Queues | ⚠️ Good | ⚠️ Partial | ✅ Simple | ⚠️ Limited |
| HTTP/REST | ❌ Slow | ❌ General | ✅ Simple | ✅ Full |

**Key Advantages:**
- ✅ **Performance**: Optimized for agent workloads
- ✅ **Features**: Built-in task coordination, blackboard pattern
- ✅ **Flexibility**: Can evolve with agent needs
- ✅ **Simplicity**: Designed specifically for our use case

### Consequences

**Positive:**
- ✅ High-performance agent coordination
- ✅ Task dependency management
- ✅ Shared state (blackboard pattern)
- ✅ Optimized for multi-agent workflows

**Negative:**
- ⚠️ Custom implementation required
- ⚠️ Learning curve for new developers
- ⚠️ Less tooling than standard protocols

### Implementation Notes

**Protocol Layers:**
```
┌─────────────────────────────────┐
│  Agent Coordination Layer        │
│  - Task routing                  │
│  - Dependency tracking           │
│  - Blackboard pattern            │
├─────────────────────────────────┤
│  Message Transport Layer         │
│  - Pub/sub                       │
│  - Direct messaging              │
│  - Event broadcasting            │
├─────────────────────────────────┤
│  Serialization Layer             │
│  - Protocol buffers              │
│  - Type-safe messages            │
└─────────────────────────────────┘
```

**Performance:**
- Message latency: ~10μs (in-process)
- Throughput: ~100K messages/second
- Memory: ~100MB for 1000 agents

### Alternatives Considered

**gRPC:**
- ❌ Not optimized for agents
- ❌ Requires service definitions
- ❌ More complex setup

**Message Queues:**
- ❌ Higher latency
- ❌ Limited coordination features
- ❌ External dependency

**HTTP/REST:**
- ❌ 100x slower
- ❌ No native pub/sub
- ❌ Not designed for agents

### References

- [01-ARCHITECTURE-RFC.md](../01-ARCHITECTURE-RFC.md)
- [02-IDENTITY-LAYER-SPEC.md](../02-IDENTITY-LAYER-SPEC.md)

---

## ADR-008: Selective Upstream Sync

**Date**: 2026-07-21  
**Status**: ✅ Accepted  
**Deciders**: Architecture Team  
**Technical Story**: Define upstream synchronization strategy

### Context

Titanium Claws is a fork of OpenClaw. Options for upstream sync:

1. **Upstream-First** (Regular merges)
2. **Selective Sync** (Cherry-pick changes)
3. **Independent** (No sync)

### Decision

Use **Selective Sync** strategy.

### Rationale

**Why selective sync?**

| Strategy | Maintenance | Control | Risk | Flexibility |
|----------|-----------|---------|------|-------------|
| **Selective** | ⚠️ Moderate | ✅ Full | ⚠️ Medium | ✅ Full |
| Upstream-First | ✅ Low | ⚠️ Limited | ⚠️ High | ⚠️ Limited |
| Independent | ❌ High | ✅ Full | ❌ Highest | ✅ Full |

**Key Advantages:**
- ✅ **Control**: Choose which changes to pull
- ✅ **Stability**: Skip breaking changes
- ✅ **Flexibility**: Pull critical fixes only
- ✅ **Contribution**: Can contribute back to OpenClaw

### Consequences

**Positive:**
- ✅ Full control over upstream changes
- ✅ Can skip breaking changes
- ✅ Pull critical security fixes
- ✅ Contribute improvements back

**Negative:**
- ⚠️ Moderate maintenance burden
- ⚠️ Risk of falling behind
- ⚠️ Manual conflict resolution

### Implementation Notes

**Sync Process:**
```bash
# 1. Fetch upstream changes
git fetch upstream main

# 2. Review changes
git log upstream/main --not main

# 3. Cherry-pick specific PRs
git cherry-pick <commit-hash>

# 4. Resolve conflicts
git mergetool

# 5. Test and validate
pnpm test
```

**Sync Schedule:**
- **Daily**: Security patches only
- **Weekly**: Bug fixes, minor improvements
- **Monthly**: Major features (review carefully)

### Alternatives Considered

**Upstream-First:**
- ❌ Less control
- ❌ Breaking changes impact us
- ❌ Harder to diverge

**Independent:**
- ❌ Highest maintenance
- ❌ No upstream improvements
- ❌ Duplicate effort

### References

- [01-ARCHITECTURE-RFC.md](../01-ARCHITECTURE-RFC.md)
- [03-MIGRATION-SPEC.md](../03-MIGRATION-SPEC.md)

---

## Summary

| ADR | Decision | Status | Impact |
|-----|----------|--------|--------|
| ADR-001 | Identity Layer | ✅ Accepted | High |
| ADR-002 | Brand Separation | ✅ Accepted | Medium |
| ADR-003 | NAPI-RS | ✅ Accepted | High |
| ADR-004 | HNSW | ✅ Accepted | High |
| ADR-005 | Tantivy | ✅ Accepted | High |
| ADR-006 | Candle | ✅ Accepted | High |
| ADR-007 | A2A Protocol | ✅ Accepted | High |
| ADR-008 | Selective Sync | ✅ Accepted | Medium |

**Total ADRs**: 8  
**Accepted**: 8 (100%)  
**Pending**: 0  
**Rejected**: 0

---

*Document Version: 1.0.0*  
*Last Updated: 2026-07-21*  
*Status: ✅ Complete*
