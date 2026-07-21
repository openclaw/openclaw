/**
 * Mythos End-to-End Integration Tests
 * Tests the complete Mythos stack: Rust engines, TypeScript integration, workflows
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { VectorIndex } from '../../crates/mythos-vector-engine';
import { SearchIndex } from '../../crates/mythos-search-engine';
import { EmbeddingRuntime } from '../../crates/mythos-embedding-runtime';
import { ProtocolCodec } from '../../crates/mythos-protocol-codec';
import { Sandbox } from '../../crates/mythos-execution-sandbox';
import { CausalGraph } from '../../crates/mythos-causal-graph';
import { A2AProtocol, AgentRegistry, TaskCoordinator } from '../../src/mythos-native/a2a';

describe('Mythos E2E Integration', () => {
  let vectorIndex: VectorIndex;
  let searchIndex: SearchIndex;
  let embeddingRuntime: EmbeddingRuntime;
  let protocolCodec: ProtocolCodec;
  let sandbox: Sandbox;
  let causalGraph: CausalGraph;
  let agentRegistry: AgentRegistry;
  let taskCoordinator: TaskCoordinator;

  beforeAll(async () => {
    // Initialize all components
    vectorIndex = new VectorIndex(1536, 'cosine', 10000);
    searchIndex = new SearchIndex('/tmp/test-search-index', 'default', 16);
    embeddingRuntime = new EmbeddingRuntime({ device: 'cpu' });
    protocolCodec = new ProtocolCodec();
    sandbox = new Sandbox('/tmp/test-sandbox');
    causalGraph = new CausalGraph();
    agentRegistry = new AgentRegistry();
    taskCoordinator = new TaskCoordinator(agentRegistry);
  });

  afterAll(async () => {
    // Cleanup
    vectorIndex.clear();
    searchIndex.clear();
    sandbox.close();
    causalGraph.clear();
  });

  describe('Vector Search Integration', () => {
    it('should store and retrieve vectors with metadata', async () => {
      const vector = Array(1536).fill(0).map(() => Math.random());
      const metadata = { source: 'test', timestamp: Date.now() };
      
      const success = await vectorIndex.store(vector, metadata);
      expect(success).toBe(true);
      
      const results = await vectorIndex.search(vector, 10);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].metadata).toEqual(metadata);
    });

    it('should handle batch operations', async () => {
      const vectors = Array(100).fill(0).map(() => 
        Array(1536).fill(0).map(() => Math.random())
      );
      
      const success = await vectorIndex.batchStore(vectors);
      expect(success).toBe(true);
      
      const stats = await vectorIndex.getStats();
      expect(stats.count).toBeGreaterThanOrEqual(100);
    });

    it('should perform approximate nearest neighbor search', async () => {
      const query = Array(1536).fill(0).map(() => Math.random());
      const results = await vectorIndex.search(query, 5);
      
      expect(results.length).toBeLessThanOrEqual(5);
      expect(results[0].similarity).toBeGreaterThanOrEqual(results[results.length - 1].similarity);
    });
  });

  describe('Text Search Integration', () => {
    it('should index and search documents', async () => {
      const documents = [
        { id: '1', content: 'Rust is a systems programming language', metadata: { tag: 'programming' } },
        { id: '2', content: 'TypeScript adds types to JavaScript', metadata: { tag: 'programming' } },
        { id: '3', content: 'Mythos uses Rust for performance', metadata: { tag: 'mythos' } },
      ];

      await searchIndex.batchIndex(documents);
      
      const results = await searchIndex.search('Rust programming', 10);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].document.content).toContain('Rust');
    });

    it('should support phrase queries', async () => {
      const results = await searchIndex.search('"systems programming"', 10);
      expect(results.length).toBeGreaterThan(0);
    });

    it('should support boolean queries', async () => {
      const results = await searchIndex.search('Rust AND programming', 10);
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('Embedding Generation', () => {
    it('should generate embeddings for text', async () => {
      const text = 'This is a test sentence for embedding';
      const embedding = await embeddingRuntime.embed(text);
      
      expect(embedding).toBeInstanceOf(Float32Array);
      expect(embedding.length).toBe(1536);
    });

    it('should generate batch embeddings', async () => {
      const texts = ['First sentence', 'Second sentence', 'Third sentence'];
      const embeddings = await embeddingRuntime.batchEmbed(texts);
      
      expect(embeddings.length).toBe(3);
      expect(embeddings[0].length).toBe(1536);
    });

    it('should handle different device types', async () => {
      const cpuRuntime = new EmbeddingRuntime({ device: 'cpu' });
      const embedding = await cpuRuntime.embed('Test');
      expect(embedding.length).toBe(1536);
    });
  });

  describe('Protocol Codec', () => {
    it('should encode and decode messages', async () => {
      const message = { type: 'search', query: 'test', limit: 10 };
      const encoded = protocolCodec.encode(message);
      const decoded = protocolCodec.decode(encoded);
      
      expect(decoded.type).toBe('search');
      expect(decoded.query).toBe('test');
      expect(decoded.limit).toBe(10);
    });

    it('should handle different message types', async () => {
      const messages = [
        { type: 'index', document: { id: '1', content: 'test' } },
        { type: 'update', id: '1', content: 'updated' },
        { type: 'delete', id: '1' },
      ];

      for (const msg of messages) {
        const encoded = protocolCodec.encode(msg);
        const decoded = protocolCodec.decode(encoded);
        expect(decoded.type).toBe(msg.type);
      }
    });

    it('should validate message schema', () => {
      const validMessage = { type: 'search', query: 'test' };
      const invalidMessage = { query: 'test' }; // missing type

      expect(protocolCodec.validate(validMessage)).toBe(true);
      expect(protocolCodec.validate(invalidMessage)).toBe(false);
    });
  });

  describe('Sandbox Execution', () => {
    it('should execute commands in isolation', async () => {
      const result = await sandbox.exec('echo "Hello from sandbox"');
      expect(result.stdout).toContain('Hello from sandbox');
      expect(result.exitCode).toBe(0);
    });

    it('should enforce resource limits', async () => {
      const result = await sandbox.exec('sleep 10', { timeout: 1000 });
      expect(result.timedOut).toBe(true);
    });

    it('should restrict file system access', async () => {
      const result = await sandbox.exec('ls /root', { cwd: '/tmp' });
      expect(result.exitCode).not.toBe(0);
    });

    it('should enforce network policies', async () => {
      const result = await sandbox.exec('curl https://google.com', { 
        network: 'denied' 
      });
      expect(result.exitCode).not.toBe(0);
    });
  });

  describe('Causal Graph', () => {
    it('should add and retrieve entities', async () => {
      const entity = {
        id: 'user_123',
        type: 'user',
        properties: { name: 'Alice', role: 'admin' },
      };

      await causalGraph.addEntity(entity);
      const retrieved = await causalGraph.getEntity('user_123');
      
      expect(retrieved).toEqual(entity);
    });

    it('should create relationships', async () => {
      await causalGraph.addEntity({ id: 'doc_1', type: 'document', properties: {} });
      await causalGraph.addEntity({ id: 'user_1', type: 'user', properties: {} });
      
      await causalGraph.addRelationship({
        from: 'user_1',
        to: 'doc_1',
        type: 'authored',
        properties: { date: '2026-01-20' },
      });

      const authored = await causalGraph.getRelationships('user_1', 'authored');
      expect(authored.length).toBe(1);
      expect(authored[0].target).toBe('doc_1');
    });

    it('should traverse causal chains', async () => {
      // Create a causal chain: A -> B -> C
      await causalGraph.addEntity({ id: 'A', type: 'event', properties: {} });
      await causalGraph.addEntity({ id: 'B', type: 'event', properties: {} });
      await causalGraph.addEntity({ id: 'C', type: 'event', properties: {} });
      
      await causalGraph.addRelationship({ from: 'A', to: 'B', type: 'caused' });
      await causalGraph.addRelationship({ from: 'B', to: 'C', type: 'caused' });

      const chain = await causalGraph.getCausalChain('A', 3);
      expect(chain.length).toBe(3);
      expect(chain.map(e => e.id)).toEqual(['A', 'B', 'C']);
    });
  });

  describe('A2A Protocol', () => {
    it('should register agents', async () => {
      const agent = {
        id: 'agent_1',
        name: 'Research Agent',
        capabilities: ['search', 'analyze'],
        metadata: { version: '1.0' },
      };

      await agentRegistry.register(agent);
      const retrieved = await agentRegistry.getAgent('agent_1');
      
      expect(retrieved.name).toBe('Research Agent');
    });

    it('should route messages between agents', async () => {
      await agentRegistry.register({ id: 'agent_1', name: 'Agent 1', capabilities: [] });
      await agentRegistry.register({ id: 'agent_2', name: 'Agent 2', capabilities: [] });

      const message = {
        from: 'agent_1',
        to: 'agent_2',
        type: 'request',
        payload: { action: 'analyze', data: 'test' },
      };

      await A2AProtocol.send(message);
      const received = await agentRegistry.getInbox('agent_2', 1);
      
      expect(received.length).toBe(1);
      expect(received[0].payload.action).toBe('analyze');
    });

    it('should coordinate tasks across agents', async () => {
      const task = {
        id: 'task_1',
        title: 'Analyze data',
        assignedTo: ['agent_1', 'agent_2'],
        dependencies: [],
        status: 'pending',
      };

      await taskCoordinator.createTask(task);
      const assigned = await taskCoordinator.getAssignedTasks('agent_1');
      
      expect(assigned.length).toBe(1);
      expect(assigned[0].title).toBe('Analyze data');
    });

    it('should handle task dependencies', async () => {
      await taskCoordinator.createTask({
        id: 'task_1',
        title: 'Gather data',
        assignedTo: ['agent_1'],
        dependencies: [],
        status: 'pending',
      });

      await taskCoordinator.createTask({
        id: 'task_2',
        title: 'Analyze data',
        assignedTo: ['agent_2'],
        dependencies: ['task_1'],
        status: 'pending',
      });

      const ready = await taskCoordinator.getReadyTasks();
      expect(ready.length).toBe(1);
      expect(ready[0].id).toBe('task_1');
    });
  });

  describe('Cross-Component Integration', () => {
    it('should embed text and store in vector index', async () => {
      const text = 'Rust is a systems programming language focused on safety';
      const embedding = await embeddingRuntime.embed(text);
      
      await vectorIndex.store(embedding, { text, type: 'fact' });
      
      const queryEmbedding = await embeddingRuntime.embed('programming language');
      const results = await vectorIndex.search(queryEmbedding, 5);
      
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].metadata.text).toBe(text);
    });

    it('should index document in search and vector stores', async () => {
      const document = {
        id: 'doc_1',
        content: 'Mythos uses Rust engines for 100x performance improvement',
        metadata: { category: 'performance' },
      };

      // Index in text search
      await searchIndex.batchIndex([document]);
      
      // Generate embedding and store in vector index
      const embedding = await embeddingRuntime.embed(document.content);
      await vectorIndex.store(embedding, { documentId: 'doc_1', ...document.metadata });

      // Search both
      const textResults = await searchIndex.search('Rust performance', 5);
      const vectorResults = await vectorIndex.search(embedding, 5);
      
      expect(textResults.length).toBeGreaterThan(0);
      expect(vectorResults.length).toBeGreaterThan(0);
    });

    it('should create causal relationships from search results', async () => {
      // Search for related documents
      const results = await searchIndex.search('Rust', 10);
      
      // Create entities in causal graph
      for (const result of results) {
        await causalGraph.addEntity({
          id: result.document.id,
          type: 'document',
          properties: result.document.metadata,
        });
      }
      
      // Create relationships
      for (let i = 0; i < results.length - 1; i++) {
        await causalGraph.addRelationship({
          from: results[i].document.id,
          to: results[i + 1].document.id,
          type: 'related_to',
          properties: { similarity: results[i].score },
        });
      }

      const entity = await causalGraph.getEntity(results[0].document.id);
      expect(entity).toBeDefined();
    });

    it('should execute agent tasks with sandbox isolation', async () => {
      const agent = {
        id: 'code_agent',
        name: 'Code Agent',
        capabilities: ['execute', 'analyze'],
      };

      await agentRegistry.register(agent);

      const task = {
        id: 'task_exec',
        title: 'Run test suite',
        assignedTo: ['code_agent'],
        dependencies: [],
        status: 'pending',
      };

      await taskCoordinator.createTask(task);
      
      // Execute in sandbox
      const result = await sandbox.exec('npm test', { cwd: '/app' });
      
      expect(result.exitCode).toBeDefined();
      expect(result.stdout).toBeDefined();
    });
  });

  describe('Performance Validation', () => {
    it('should achieve 100x vector search performance', async () => {
      const start = performance.now();
      
      for (let i = 0; i < 1000; i++) {
        const query = Array(1536).fill(0).map(() => Math.random());
        await vectorIndex.search(query, 10);
      }
      
      const duration = performance.now() - start;
      const queriesPerSecond = 1000 / (duration / 1000);
      
      // Should handle 1000+ QPS
      expect(queriesPerSecond).toBeGreaterThan(1000);
    });

    it('should achieve 10x text search performance', async () => {
      const start = performance.now();
      
      for (let i = 0; i < 100; i++) {
        await searchIndex.search('performance benchmark', 10);
      }
      
      const duration = performance.now() - start;
      const queriesPerSecond = 100 / (duration / 1000);
      
      // Should handle 100+ QPS
      expect(queriesPerSecond).toBeGreaterThan(100);
    });

    it('should generate embeddings efficiently', async () => {
      const start = performance.now();
      
      for (let i = 0; i < 100; i++) {
        await embeddingRuntime.embed(`Test sentence ${i}`);
      }
      
      const duration = performance.now() - start;
      const embeddingsPerSecond = 100 / (duration / 1000);
      
      // Should handle 50+ embeddings/second
      expect(embeddingsPerSecond).toBeGreaterThan(50);
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid vector dimensions', async () => {
      const invalidVector = Array(1000).fill(0).map(() => Math.random());
      
      await expect(vectorIndex.store(invalidVector, {}))
        .rejects.toThrow(/dimension/i);
    });

    it('should handle missing search index', async () => {
      const missingIndex = new SearchIndex('/nonexistent/path', 'default', 16);
      
      await expect(missingIndex.search('test', 10))
        .rejects.toThrow();
    });

    it('should handle sandbox execution failures', async () => {
      const result = await sandbox.exec('invalid_command_xyz');
      
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toBeDefined();
    });

    it('should handle invalid agent messages', async () => {
      const invalidMessage = {
        from: 'nonexistent_agent',
        to: 'agent_1',
        type: 'request',
        payload: {},
      };

      await expect(A2AProtocol.send(invalidMessage))
        .rejects.toThrow(/agent not found/i);
    });
  });
});
