/**
 * semantic-router.ts — L1.5 Semantic Router
 *
 * 插在 L1 关键词匹配（task-resolver.ts）和 L2 LLM 分类之间。
 * 使用本地 embedding 向量 + 余弦相似度（点积，向量已 normalized）匹配意图。
 *
 * 性能目标：单次 resolve < 50ms（本地 embedding + 点积计算）
 */

import type { EmbeddingProvider } from "../../memory/embeddings.js";
import type { TaskType } from "./types.js";

/** 单条 route 向量缓存条目 */
interface RouteEntry {
  taskType: TaskType;
  embedding: number[];
}

/**
 * 余弦相似度（向量已 normalized，点积即可）
 */
function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

const MAX_CACHE_SIZE = 100;

export class SemanticRouter {
  private provider: EmbeddingProvider;
  private defaultThreshold: number;
  private minGap: number;
  private routes: RouteEntry[] = [];
  private initialized = false;
  private queryCache: Map<string, number[]> = new Map();

  /**
   * @param provider - EmbeddingProvider 实例（来自 memory/embeddings.ts）
   * @param defaultThreshold - 余弦相似度阈值，默认 0.68
   * @param minGap - top-1 与 top-2（不同 TaskType）的最小分差，低于此值视为分类不确定，默认 0.05
   */
  constructor(provider: EmbeddingProvider, defaultThreshold = 0.68, minGap = 0.05) {
    this.provider = provider;
    this.defaultThreshold = defaultThreshold;
    this.minGap = minGap;
  }

  /**
   * 预计算所有示例话语的 embedding 向量并缓存。
   * init 只需调用一次；config reload 时重建（外部重新 new SemanticRouter）。
   *
   * @param routes - TaskType → 示例话语数组
   */
  async init(routes: Map<TaskType, string[]>): Promise<void> {
    const entries: RouteEntry[] = [];

    for (const [taskType, utterances] of routes) {
      if (utterances.length === 0) {
        continue;
      }

      // embedBatch 批量处理，减少往返
      const embeddings = await this.provider.embedBatch(utterances);
      for (const embedding of embeddings) {
        entries.push({ taskType, embedding });
      }
    }

    this.routes = entries;
    this.initialized = true;
    this.queryCache.clear();
  }

  /**
   * 计算输入文本与所有 route 的余弦相似度，返回最高分且超过阈值的 TaskType。
   *
   * @param text - 用户输入文本
   * @param threshold - 相似度阈值，未传则使用构造函数的默认值
   * @returns 最匹配的 TaskType，或 null（未超过阈值）
   */
  async resolve(text: string, threshold?: number): Promise<TaskType | null> {
    if (!this.initialized || this.routes.length === 0) {
      return null;
    }

    const t = threshold ?? this.defaultThreshold;

    // LRU cache: check if embedding is already cached for this text
    let queryEmbedding: number[];
    const cached = this.queryCache.get(text);
    if (cached !== undefined) {
      queryEmbedding = cached;
    } else {
      queryEmbedding = await this.provider.embedQuery(text);
      // Evict oldest entry when cache is full
      if (this.queryCache.size >= MAX_CACHE_SIZE) {
        const oldestKey = this.queryCache.keys().next().value;
        if (oldestKey !== undefined) {
          this.queryCache.delete(oldestKey);
        }
      }
      this.queryCache.set(text, queryEmbedding);
    }

    let bestScore = -Infinity;
    let bestTaskType: TaskType | null = null;
    let secondBestScore = -Infinity;

    for (const { taskType, embedding } of this.routes) {
      const score = dotProduct(queryEmbedding, embedding);
      if (score > bestScore) {
        // 如果新的最优与当前最优属于不同 TaskType，当前最优降为次优候选
        if (bestTaskType !== null && taskType !== bestTaskType) {
          secondBestScore = Math.max(secondBestScore, bestScore);
        }
        bestScore = score;
        bestTaskType = taskType;
      } else if (bestTaskType !== null && taskType !== bestTaskType && score > secondBestScore) {
        secondBestScore = score;
      }
    }

    if (bestTaskType !== null && bestScore >= t) {
      // Confidence gap 检查：若 top-1 与 top-2（不同 TaskType）分差不足，分类不确定，fallback
      if (bestScore - secondBestScore < this.minGap) {
        return null;
      }
      return bestTaskType;
    }

    return null;
  }

  /** 当前是否已完成初始化 */
  get isInitialized(): boolean {
    return this.initialized;
  }

  /** 当前缓存的 route 条目数量（用于调试） */
  get routeCount(): number {
    return this.routes.length;
  }

  /** 当前 query embedding 缓存条目数量（用于调试和测试） */
  get cacheSize(): number {
    return this.queryCache.size;
  }
}
