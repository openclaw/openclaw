# OpenClaw Caching Layer

## Overview

A unified caching layer for OpenClaw that reduces API calls and improves response times through intelligent caching of:

- Web search results
- Model responses (for similar prompts)
- Tool call results (when deterministic)
- Session context/state

## Architecture

The caching layer consists of:

1. **CacheManager** - Central cache orchestrator
2. **CacheProviders** - Different storage backends (in-memory LRU, Redis, disk)
3. **CacheStrategies** - Different caching strategies per resource type
4. **CacheMetrics** - Performance monitoring and analytics

## Features

- **Multi-tier caching**: L1 (memory), L2 (Redis/disk)
- **Smart invalidation**: TTL-based and event-driven
- **Cache warming**: Pre-populate frequently used data
- **Compression**: Reduce memory footprint for large responses
- **Metrics**: Track hit rates, latency improvements

## Usage

```typescript
import { CacheManager } from "./cache-manager";

const cache = new CacheManager({
  provider: "lru", // or 'redis'
  maxSize: 100, // MB for memory, entries for Redis
  ttl: 15 * 60, // seconds
});

// Cache a web search
const result = await cache.getOrSet(
  "web-search",
  searchKey,
  async () => await performSearch(query),
  { ttl: 900 },
);
```

## Configuration

Cache settings can be configured in:

- Environment variables
- Configuration files
- Runtime parameters

## Metrics

The cache layer tracks:

- Hit/miss ratios
- Average latency reduction
- Memory usage
- Eviction rates
