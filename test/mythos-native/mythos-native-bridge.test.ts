/**
 * TypeScript Integration Tests for Mythos Native Bridge
 * Tests the integration layer between OpenClaw and Rust native engines
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  loadAllNativeModules,
  checkNativeAvailability,
} from '../../src/mythos-native/index.js';

import {
  createNativeVectorSearch,
  nativeVectorSearch,
  isNativeVectorAvailable,
} from '../../src/mythos-native/vector-engine.js';

import {
  createNativeTextSearch,
  nativeTextSearch,
  isNativeSearchAvailable,
} from '../../src/mythos-native/search-engine.js';

import {
  createNativeCodec,
  parseFrame,
  isNativeCodecAvailable,
} from '../../src/mythos-native/protocol-codec.js';

import {
  createCausalGraph,
  loadCausalGraph,
  isCausalGraphAvailable,
} from '../../src/mythos-native/causal-graph.js';

describe('Mythos Native Module Loader', () => {
  it('should load all native modules (or gracefully fail)', async () => {
    const modules = await loadAllNativeModules();

    // Modules should be either loaded or null
    expect(modules).toHaveProperty('vectorEngine');
    expect(modules).toHaveProperty('searchEngine');
    expect(modules).toHaveProperty('protocolCodec');
    expect(modules).toHaveProperty('causalGraph');

    // Each module is either loaded or null
    if (modules.vectorEngine !== null) {
      expect(typeof modules.vectorEngine).toBe('object');
    }
    if (modules.searchEngine !== null) {
      expect(typeof modules.searchEngine).toBe('object');
    }
    if (modules.protocolCodec !== null) {
      expect(typeof modules.protocolCodec).toBe('object');
    }
    if (modules.causalGraph !== null) {
      expect(typeof modules.causalGraph).toBe('object');
    }
  });

  it('should check native availability', async () => {
    const availability = await checkNativeAvailability();

    expect(availability).toHaveProperty('vectorEngine');
    expect(availability).toHaveProperty('searchEngine');
    expect(availability).toHaveProperty('protocolCodec');
    expect(availability).toHaveProperty('causalGraph');

    // Values should be either the engine name or 'unavailable'
    const validValues = ['HNSW', 'Tantivy', 'simd-json', 'petgraph', 'unavailable'];
    expect(validValues).toContain(availability.vectorEngine);
    expect(validValues).toContain(availability.searchEngine);
    expect(validValues).toContain(availability.protocolCodec);
    expect(validValues).toContain(availability.causalGraph);
  });
});

describe('Vector Engine Integration', () => {
  it('should check if native vector engine is available', async () => {
    const available = await isNativeVectorAvailable();
    expect(typeof available).toBe('boolean');
  });

  it('should create native vector search (if available)', async () => {
    const search = await createNativeVectorSearch({
      indexPath: '/tmp/test-vector-index',
      dimensions: 1536,
    });

    if (await isNativeVectorAvailable()) {
      expect(search).not.toBeNull();
      expect(search).toBeDefined();
    } else {
      expect(search).toBeNull();
    }
  });

  it('should perform native vector search (if available)', async () => {
    if (!(await isNativeVectorAvailable())) {
      // Skip test if native engine not available
      return;
    }

    const search = await createNativeVectorSearch({
      indexPath: '/tmp/test-vector-index',
      dimensions: 3,
    });

    expect(search).not.toBeNull();

    // Add some vectors
    await search.addBatch(
      ['v1', 'v2', 'v3'],
      [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
      ['/f1.md', '/f2.md', '/f3.md'],
      [1, 6, 11],
      [5, 10, 15]
    );

    // Search
    const results = await nativeVectorSearch(search, [1.0, 0.0, 0.0], 2);

    expect(results).toBeInstanceOf(Array);
    expect(results.length).toBeLessThanOrEqual(2);
    expect(results[0]).toHaveProperty('id');
    expect(results[0]).toHaveProperty('score');
    expect(results[0]).toHaveProperty('path');
  });
});

describe('Search Engine Integration', () => {
  it('should check if native search engine is available', async () => {
    const available = await isNativeSearchAvailable();
    expect(typeof available).toBe('boolean');
  });

  it('should create native text search (if available)', async () => {
    const search = await createNativeTextSearch({
      indexPath: '/tmp/test-text-index',
      tokenizer: 'default',
    });

    if (await isNativeSearchAvailable()) {
      expect(search).not.toBeNull();
      expect(search).toBeDefined();
    } else {
      expect(search).toBeNull();
    }
  });

  it('should perform native text search (if available)', async () => {
    if (!(await isNativeSearchAvailable())) {
      return;
    }

    const search = await createNativeTextSearch({
      indexPath: '/tmp/test-text-index',
    });

    expect(search).not.toBeNull();

    // Index some documents
    await search.indexBatch([
      {
        id: 'doc1',
        path: '/file1.md',
        text: 'OpenClaw is an AI agent framework',
        startLine: 1,
        endLine: 10,
      },
      {
        id: 'doc2',
        path: '/file2.md',
        text: 'Mythos-class capabilities with Rust engines',
        startLine: 1,
        endLine: 10,
      },
    ]);

    // Search
    const results = await nativeTextSearch(search, 'agent', 10);

    expect(results).toBeInstanceOf(Array);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toHaveProperty('id');
    expect(results[0]).toHaveProperty('score');
    expect(results[0]).toHaveProperty('snippet');
  });
});

describe('Protocol Codec Integration', () => {
  it('should check if native codec is available', async () => {
    const available = await isNativeCodecAvailable();
    expect(typeof available).toBe('boolean');
  });

  it('should create native codec (if available)', async () => {
    const codec = await createNativeCodec(1024 * 1024);

    if (await isNativeCodecAvailable()) {
      expect(codec).not.toBeNull();
      expect(codec).toBeDefined();
    } else {
      expect(codec).toBeNull();
    }
  });

  it('should parse frame with native codec (if available)', async () => {
    if (!(await isNativeCodecAvailable())) {
      return;
    }

    const codec = await createNativeCodec(1024 * 1024);
    expect(codec).not.toBeNull();

    const frameBuffer = Buffer.from(
      JSON.stringify({
        type: 'req',
        id: 'req1',
        method: 'search',
        params: { query: 'test' },
      })
    );

    const frame = await parseFrame(frameBuffer, codec);

    expect(frame).toBeDefined();
    expect(frame.valid).toBe(true);
    expect(frame.frameType).toBe('req');
    expect(frame.id).toBe('req1');
    expect(frame.method).toBe('search');
  });

  it('should fall back to JSON.parse when codec unavailable', async () => {
    const frameBuffer = Buffer.from(
      JSON.stringify({
        type: 'req',
        id: 'req2',
        method: 'memory.search',
        params: { query: 'rust' },
      })
    );

    // Pass null codec to force fallback
    const frame = await parseFrame(frameBuffer, null);

    expect(frame).toBeDefined();
    expect(frame.valid).toBe(true);
    expect(frame.frameType).toBe('req');
    expect(frame.id).toBe('req2');
    expect(frame.method).toBe('memory.search');
  });

  it('should handle invalid JSON gracefully', async () => {
    const invalidBuffer = Buffer.from('{"type":"req","id":"req1"'); // Missing closing brace

    const frame = await parseFrame(invalidBuffer, null);

    expect(frame).toBeDefined();
    expect(frame.valid).toBe(false);
    expect(frame.error).toBeDefined();
  });
});

describe('Causal Graph Integration', () => {
  it('should check if causal graph is available', async () => {
    const available = await isCausalGraphAvailable();
    expect(typeof available).toBe('boolean');
  });

  it('should create causal graph (if available)', async () => {
    const graph = await createCausalGraph();

    if (await isCausalGraphAvailable()) {
      expect(graph).not.toBeNull();
      expect(graph).toBeDefined();
    } else {
      expect(graph).toBeNull();
    }
  });

  it('should add nodes to causal graph (if available)', async () => {
    if (!(await isCausalGraphAvailable())) {
      return;
    }

    const graph = await createCausalGraph();
    expect(graph).not.toBeNull();

    graph.addNode({
      id: 'node1',
      nodeType: 'fact',
      content: 'Test fact',
      timestamp: Date.now(),
      confidence: 0.9,
    });

    graph.addNode({
      id: 'node2',
      nodeType: 'concept',
      content: 'Test concept',
      timestamp: Date.now(),
      confidence: 0.85,
    });

    expect(graph.nodeCount).toBe(2);
  });

  it('should add edges and find causal chains (if available)', async () => {
    if (!(await isCausalGraphAvailable())) {
      return;
    }

    const graph = await createCausalGraph();
    expect(graph).not.toBeNull();

    graph.addNode({
      id: 'A',
      nodeType: 'event',
      content: 'Event A',
      timestamp: 1000,
      confidence: 0.9,
    });

    graph.addNode({
      id: 'B',
      nodeType: 'event',
      content: 'Event B',
      timestamp: 2000,
      confidence: 0.85,
    });

    graph.addEdge('A', 'B', 'causes', 0.9, 'session1');

    expect(graph.edgeCount).toBe(1);

    // Find causal chains
    const chains = graph.findCausalChains('A', 10, 0.5);

    expect(chains).toBeInstanceOf(Array);
    expect(chains.length).toBeGreaterThan(0);
    expect(chains[0].nodes).toBeInstanceOf(Array);
    expect(chains[0].nodes.length).toBe(2);
  });

  it('should save and load causal graph (if available)', async () => {
    if (!(await isCausalGraphAvailable())) {
      return;
    }

    const graph = await createCausalGraph();
    expect(graph).not.toBeNull();

    graph.addNode({
      id: 'test',
      nodeType: 'fact',
      content: 'Test',
      timestamp: Date.now(),
      confidence: 0.8,
    });

    // Save
    graph.save('/tmp/test-causal-graph.json');

    // Load
    const loaded = await loadCausalGraph('/tmp/test-causal-graph.json');

    expect(loaded).not.toBeNull();
    expect(loaded.nodeCount).toBe(1);
  });
});

describe('Memory Core Integration', () => {
  it('should gracefully fallback when native engines unavailable', async () => {
    // This test verifies the fallback mechanism
    // Even if native engines are not available, the system should work

    const vectorSearch = await createNativeVectorSearch({
      indexPath: '/tmp/nonexistent-index',
      dimensions: 1536,
    });

    // If native not available, should return null
    if (!(await isNativeVectorAvailable())) {
      expect(vectorSearch).toBeNull();
    }

    // Similar for text search
    const textSearch = await createNativeTextSearch({
      indexPath: '/tmp/nonexistent-index',
    });

    if (!(await isNativeSearchAvailable())) {
      expect(textSearch).toBeNull();
    }
  });
});
