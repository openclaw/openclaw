/**
 * Qdrant 记忆存储后端 - 支持多租户隔离
 * 
 * 特性：
 * - 基于 tenant_id 的过滤
 * - 支持作用域分层（company/department/personal）
 * - 自动注入租户标识
 */

import type { MemoryRecord, MemorySearchOptions, MemoryBackend } from '../memory/types.js';

/**
 * Qdrant 配置
 */
export interface QdrantBackendConfig {
  host: string;
  port: number;
  apiKey?: string;
  https?: boolean;
  
  // 多租户配置
  tenantId: string;  // 组织 ID
  userId?: string;   // 用户 ID（可选，用于个人记忆）
  
  // 集合配置
  collectionName?: string;
  vectorSize: number;
  distance?: 'Cosine' | 'Dot' | 'Euclid';
}

/**
 * 记忆 Payload 结构（Qdrant）
 */
export interface QdrantMemoryPayload {
  text: string;
  tenant_id: string;      // 组织 ID（必填，用于隔离）
  user_id?: string;       // 用户 ID（可选）
  scope: 'company' | 'department' | 'personal';  // 作用域
  category?: string;
  created_at: number;
  created_by: string;
  metadata?: Record<string, any>;
}

/**
 * Qdrant 记忆后端实现
 */
export class QdrantMemoryBackend implements MemoryBackend {
  private config: QdrantBackendConfig;
  private client: any;  // Qdrant client
  private initialized: boolean = false;

  constructor(config: QdrantBackendConfig) {
    this.config = config;
  }

  /**
   * 初始化连接
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      // 动态导入 Qdrant 客户端
      const { QdrantClient } = await import('@qdrant/js-client-rest');
      
      this.client = new QdrantClient({
        url: this.config.https 
          ? `https://${this.config.host}:${this.config.port}`
          : `http://${this.config.host}:${this.config.port}`,
        apiKey: this.config.apiKey,
      });

      // 创建或验证集合
      const collectionName = this.config.collectionName || 'memories';
      const collections = await this.client.getCollections();
      
      const exists = collections.collections.some(
        (c: any) => c.name === collectionName
      );

      if (!exists) {
        await this.client.createCollection(collectionName, {
          vectors: {
            size: this.config.vectorSize,
            distance: this.config.distance || 'Cosine',
          },
        });

        // 创建 tenant_id 的 payload 索引（加速过滤）
        await this.client.createPayloadIndex(collectionName, {
          field_name: 'tenant_id',
          field_schema: 'keyword',
        });

        console.log(`[Qdrant] 创建集合：${collectionName}`);
      }

      this.initialized = true;
      console.log(`[Qdrant] 已连接到 ${this.config.host}:${this.config.port}`);
    } catch (error) {
      console.error('[Qdrant] 初始化失败:', error);
      throw error;
    }
  }

  /**
   * 添加记忆（自动注入租户标识）
   */
  async addMemory(record: MemoryRecord): Promise<string> {
    await this.initialize();

    const collectionName = this.config.collectionName || 'memories';
    
    // 构建 Payload（自动注入租户信息）
    const payload: QdrantMemoryPayload = {
      text: record.text,
      tenant_id: this.config.tenantId,  // 强制注入组织 ID
      user_id: this.config.userId || record.userId,
      scope: record.scope || 'personal',
      category: record.category,
      created_at: record.createdAt || Date.now(),
      created_by: record.createdBy || this.config.userId || 'unknown',
      metadata: record.metadata,
    };

    // 生成唯一 ID
    const id = record.id || `mem_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // 上传到 Qdrant
    await this.client.upsert(collectionName, {
      points: [
        {
          id,
          vector: record.vector,
          payload,
        },
      ],
    });

    console.log(`[Qdrant] 添加记忆：${id} (tenant: ${this.config.tenantId})`);
    return id;
  }

  /**
   * 搜索记忆（自动添加租户过滤）
   */
  async search(
    queryVector: number[],
    options?: MemorySearchOptions
  ): Promise<MemoryRecord[]> {
    await this.initialize();

    const collectionName = this.config.collectionName || 'memories';
    const limit = options?.limit || 5;

    // 构建过滤条件（强制租户隔离）
    const filter: any = {
      must: [
        {
          key: 'tenant_id',
          match: { value: this.config.tenantId },
        },
      ],
    };

    // 可选：添加作用域过滤
    if (options?.scope) {
      filter.must.push({
        key: 'scope',
        match: { value: options.scope },
      });
    }

    // 可选：添加用户 ID 过滤（个人记忆）
    if (options?.userId && this.config.userId) {
      filter.must.push({
        key: 'user_id',
        match: { value: this.config.userId },
      });
    }

    // 执行搜索
    const results = await this.client.search(collectionName, {
      vector: queryVector,
      filter,
      limit,
      with_payload: true,
    });

    // 转换为 MemoryRecord 格式
    return results.map((result: any) => ({
      id: result.id,
      text: result.payload.text,
      vector: result.vector,
      scope: result.payload.scope,
      category: result.payload.category,
      createdAt: result.payload.created_at,
      createdBy: result.payload.created_by,
      userId: result.payload.user_id,
      metadata: result.payload.metadata,
      score: result.score,
    }));
  }

  /**
   * 删除记忆（验证租户权限）
   */
  async deleteMemory(memoryId: string): Promise<boolean> {
    await this.initialize();

    const collectionName = this.config.collectionName || 'memories';

    // 先验证记忆属于当前租户
    const memory = await this.getMemory(memoryId);
    if (!memory) {
      return false;
    }

    if (memory.metadata?.tenant_id !== this.config.tenantId) {
      throw new Error(
        `无权删除其他租户的记忆：${memoryId} (期望：${this.config.tenantId})`
      );
    }

    // 删除
    await this.client.delete(collectionName, {
      points: [memoryId],
    });

    console.log(`[Qdrant] 删除记忆：${memoryId}`);
    return true;
  }

  /**
   * 获取单个记忆
   */
  async getMemory(memoryId: string): Promise<MemoryRecord | null> {
    await this.initialize();

    const collectionName = this.config.collectionName || 'memories';

    try {
      const result = await this.client.retrieve(collectionName, {
        ids: [memoryId],
        with_payload: true,
      });

      if (!result || result.length === 0) {
        return null;
      }

      const item = result[0];
      
      // 验证租户权限
      if (item.payload.tenant_id !== this.config.tenantId) {
        console.warn(
          `[Qdrant] 越权访问尝试：${memoryId} (tenant: ${item.payload.tenant_id}, current: ${this.config.tenantId})`
        );
        return null;
      }

      return {
        id: item.id,
        text: item.payload.text,
        vector: item.vector,
        scope: item.payload.scope,
        category: item.payload.category,
        createdAt: item.payload.created_at,
        createdBy: item.payload.created_by,
        userId: item.payload.user_id,
        metadata: item.payload.metadata,
      };
    } catch (error) {
      console.error(`[Qdrant] 获取记忆失败：${memoryId}`, error);
      return null;
    }
  }

  /**
   * 批量添加记忆
   */
  async addMemories(records: MemoryRecord[]): Promise<string[]> {
    const ids = await Promise.all(
      records.map(record => this.addMemory(record))
    );
    return ids;
  }

  /**
   * 清空当前租户的所有记忆（危险操作）
   */
  async clearAll(): Promise<void> {
    await this.initialize();

    const collectionName = this.config.collectionName || 'memories';

    // 删除所有当前租户的记忆
    await this.client.delete(collectionName, {
      filter: {
        must: [
          {
            key: 'tenant_id',
            match: { value: this.config.tenantId },
          },
        ],
      },
    });

    console.log(`[Qdrant] 清空租户 ${this.config.tenantId} 的所有记忆`);
  }

  /**
   * 获取统计信息
   */
  async getStats(): Promise<{
    totalMemories: number;
    tenantId: string;
  }> {
    await this.initialize();

    const collectionName = this.config.collectionName || 'memories';

    // 统计当前租户的记忆数量
    const count = await this.client.count(collectionName, {
      filter: {
        must: [
          {
            key: 'tenant_id',
            match: { value: this.config.tenantId },
          },
        ],
      },
    });

    return {
      totalMemories: count.count,
      tenantId: this.config.tenantId,
    };
  }

  /**
   * 关闭连接
   */
  async close(): Promise<void> {
    if (this.client) {
      // Qdrant client 没有明确的关闭方法
      this.initialized = false;
      console.log('[Qdrant] 连接已关闭');
    }
  }
}

/**
 * 创建 Qdrant 后端实例
 */
export function createQdrantBackend(
  config: QdrantBackendConfig
): QdrantMemoryBackend {
  return new QdrantMemoryBackend(config);
}
