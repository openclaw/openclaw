/**
 * Qdrant 记忆后端单元测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  QdrantMemoryBackend,
  type QdrantConfig,
  type MemoryRecord,
} from './qdrant-backend.js';

describe('QdrantMemoryBackend', () => {
  let backend: QdrantMemoryBackend;
  let mockQdrantClient: any;

  beforeEach(() => {
    // Mock Qdrant client
    mockQdrantClient = {
      search: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
      createCollection: vi.fn(),
    };

    const config: QdrantConfig = {
      host: 'localhost',
      port: 6333,
      apiKey: 'test_key',
      tenantId: 'org_test123',
      collectionName: 'test_memories',
    };

    backend = new QdrantMemoryBackend(config, mockQdrantClient);
  });

  describe('initialize', () => {
    it('should create collection if not exists', async () => {
      mockQdrantClient.collectionExists = vi.fn().mockResolvedValue(false);

      await backend.initialize();

      expect(mockQdrantClient.createCollection).toHaveBeenCalledWith({
        collection_name: 'test_memories',
        vectors: expect.any(Object),
      });
    });

    it('should skip creation if collection exists', async () => {
      mockQdrantClient.collectionExists = vi.fn().mockResolvedValue(true);

      await backend.initialize();

      expect(mockQdrantClient.createCollection).not.toHaveBeenCalled();
    });
  });

  describe('addMemory', () => {
    it('should add memory with tenant_id filter', async () => {
      const memory: MemoryRecord = {
        text: 'Test memory content',
        userId: 'user_abc',
        scope: 'personal',
        category: 'test',
      };

      mockQdrantClient.upsert.mockResolvedValue({ status: 'completed' });

      const result = await backend.addMemory(memory);

      expect(mockQdrantClient.upsert).toHaveBeenCalledWith({
        collection_name: 'test_memories',
        points: expect.arrayContaining([
          expect.objectContaining({
            payload: expect.objectContaining({
              tenant_id: 'org_test123',
              user_id: 'user_abc',
              scope: 'personal',
              category: 'test',
              text: 'Test memory content',
            }),
          }),
        ]),
      });

      expect(result).toBeDefined();
    });

    it('should automatically inject tenant_id from config', async () => {
      const memory: MemoryRecord = {
        text: 'Test memory',
        userId: 'user_xyz',
      };

      await backend.addMemory(memory);

      const callArgs = mockQdrantClient.upsert.mock.calls[0][0];
      expect(callArgs.points[0].payload.tenant_id).toBe('org_test123');
    });

    it('should handle metadata correctly', async () => {
      const memory: MemoryRecord = {
        text: 'Test memory',
        userId: 'user_123',
        scope: 'company',
        category: 'company_policy',
        metadata: {
          department: 'engineering',
          priority: 'high',
        },
      };

      await backend.addMemory(memory);

      const callArgs = mockQdrantClient.upsert.mock.calls[0][0];
      const payload = callArgs.points[0].payload;

      expect(payload.department).toBe('engineering');
      expect(payload.priority).toBe('high');
    });
  });

  describe('searchMemories', () => {
    it('should search with tenant_id filter', async () => {
      mockQdrantClient.search.mockResolvedValue([
        {
          id: 'memory_1',
          score: 0.95,
          payload: {
            text: 'Relevant memory',
            tenant_id: 'org_test123',
            user_id: 'user_abc',
          },
        },
      ]);

      const results = await backend.searchMemories('query text', {
        limit: 5,
        userId: 'user_abc',
      });

      // Verify tenant_id filter is applied
      const searchArgs = mockQdrantClient.search.mock.calls[0][0];
      expect(searchArgs.filter.must).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: 'tenant_id',
            match: { value: 'org_test123' },
          }),
        ])
      );

      expect(results.length).toBe(1);
      expect(results[0].text).toBe('Relevant memory');
      expect(results[0].score).toBe(0.95);
    });

    it('should filter by scope when provided', async () => {
      await backend.searchMemories('query', {
        limit: 5,
        scope: 'company',
      });

      const searchArgs = mockQdrantClient.search.mock.calls[0][0];
      expect(searchArgs.filter.must).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: 'scope',
            match: { value: 'company' },
          }),
        ])
      );
    });

    it('should filter by user_id when provided', async () => {
      await backend.searchMemories('query', {
        limit: 5,
        userId: 'user_specific',
      });

      const searchArgs = mockQdrantClient.search.mock.calls[0][0];
      expect(searchArgs.filter.must).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: 'user_id',
            match: { value: 'user_specific' },
          }),
        ])
      );
    });

    it('should handle empty results', async () => {
      mockQdrantClient.search.mockResolvedValue([]);

      const results = await backend.searchMemories('nonexistent query');

      expect(results.length).toBe(0);
    });

    it('should respect limit parameter', async () => {
      mockQdrantClient.search.mockResolvedValue([]);

      await backend.searchMemories('query', { limit: 10 });

      const searchArgs = mockQdrantClient.search.mock.calls[0][0];
      expect(searchArgs.limit).toBe(10);
    });
  });

  describe('deleteMemory', () => {
    it('should delete memory by id', async () => {
      mockQdrantClient.delete.mockResolvedValue({ status: 'completed' });

      await backend.deleteMemory('memory_123');

      expect(mockQdrantClient.delete).toHaveBeenCalledWith({
        collection_name: 'test_memories',
        points: {
          ids: ['memory_123'],
        },
      });
    });

    it('should verify tenant ownership before deletion', async () => {
      // Mock search to verify ownership
      mockQdrantClient.search.mockResolvedValue([
        { id: 'memory_123', payload: { tenant_id: 'org_test123' } },
      ]);

      await backend.deleteMemory('memory_123');

      // Should verify tenant_id matches before deleting
      expect(mockQdrantClient.search).toHaveBeenCalled();
      expect(mockQdrantClient.delete).toHaveBeenCalled();
    });

    it('should throw error when deleting memory from different tenant', async () => {
      // Mock search to return different tenant
      mockQdrantClient.search.mockResolvedValue([
        { id: 'memory_456', payload: { tenant_id: 'org_other' } },
      ]);

      await expect(backend.deleteMemory('memory_456')).rejects.toThrow(
        'Cannot delete memory from different tenant'
      );

      expect(mockQdrantClient.delete).not.toHaveBeenCalled();
    });
  });

  describe('getMemoryById', () => {
    it('should retrieve memory by id', async () => {
      mockQdrantClient.search.mockResolvedValue([
        {
          id: 'memory_789',
          payload: {
            text: 'Specific memory',
            tenant_id: 'org_test123',
            user_id: 'user_abc',
            scope: 'personal',
          },
        },
      ]);

      const memory = await backend.getMemoryById('memory_789');

      expect(memory).not.toBeNull();
      expect(memory!.id).toBe('memory_789');
      expect(memory!.text).toBe('Specific memory');
    });

    it('should return null when memory not found', async () => {
      mockQdrantClient.search.mockResolvedValue([]);

      const memory = await backend.getMemoryById('nonexistent');

      expect(memory).toBeNull();
    });

    it('should verify tenant_id matches', async () => {
      mockQdrantClient.search.mockResolvedValue([
        { id: 'memory_999', payload: { tenant_id: 'org_other' } },
      ]);

      const memory = await backend.getMemoryById('memory_999');

      // Should return null for different tenant
      expect(memory).toBeNull();
    });
  });

  describe('updateMemory', () => {
    it('should update existing memory', async () => {
      // First, mock the search to find existing memory
      mockQdrantClient.search.mockResolvedValueOnce([
        { id: 'memory_123', payload: { tenant_id: 'org_test123' } },
      ]);

      mockQdrantClient.upsert.mockResolvedValue({ status: 'completed' });

      await backend.updateMemory('memory_123', {
        text: 'Updated content',
        metadata: { version: 2 },
      });

      expect(mockQdrantClient.upsert).toHaveBeenCalled();
    });

    it('should throw error when updating non-existent memory', async () => {
      mockQdrantClient.search.mockResolvedValue([]);

      await expect(
        backend.updateMemory('nonexistent', { text: 'new text' })
      ).rejects.toThrow('Memory not found');
    });
  });

  describe('multi-tenant isolation', () => {
    it('should prevent cross-tenant memory access', async () => {
      // Setup: Search returns memory from different tenant
      mockQdrantClient.search.mockResolvedValue([
        {
          id: 'memory_cross',
          payload: { tenant_id: 'org_evil', text: 'Secret data' },
        },
      ]);

      // Attempt to access should fail
      const memory = await backend.getMemoryById('memory_cross');

      expect(memory).toBeNull();
    });

    it('should enforce tenant_id on all write operations', async () => {
      const memory: MemoryRecord = {
        text: 'Attempt injection',
        userId: 'user_hacker',
        metadata: {
          tenant_id: 'org_evil', // Attempt to override tenant_id
        },
      };

      await backend.addMemory(memory);

      const callArgs = mockQdrantClient.upsert.mock.calls[0][0];
      // tenant_id should be from config, not from input
      expect(callArgs.points[0].payload.tenant_id).toBe('org_test123');
    });
  });

  describe('scope-based filtering', () => {
    it('should support hierarchical scope filtering', async () => {
      mockQdrantClient.search.mockResolvedValue([]);

      // Search in company scope
      await backend.searchMemories('query', {
        scope: 'company',
        limit: 5,
      });

      const searchArgs = mockQdrantClient.search.mock.calls[0][0];
      expect(searchArgs.filter.must).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: 'scope',
            match: { value: 'company' },
          }),
        ])
      );
    });

    it('should support multiple scope filtering', async () => {
      mockQdrantClient.search.mockResolvedValue([]);

      await backend.searchMemories('query', {
        scopes: ['company', 'department'],
        limit: 5,
      });

      const searchArgs = mockQdrantClient.search.mock.calls[0][0];
      // Should use should clause for OR logic
      expect(searchArgs.filter).toBeDefined();
    });
  });

  describe('error handling', () => {
    it('should handle Qdrant connection errors', async () => {
      mockQdrantClient.search.mockRejectedValue(
        new Error('Connection refused')
      );

      await expect(backend.searchMemories('query')).rejects.toThrow(
        'Qdrant connection error'
      );
    });

    it('should handle timeout errors', async () => {
      mockQdrantClient.search.mockRejectedValue(
        new Error('Request timeout')
      );

      await expect(backend.searchMemories('query')).rejects.toThrow(
        'Qdrant request timeout'
      );
    });
  });
});
