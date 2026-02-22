/**
 * Semantic clustering for memory search results.
 *
 * Groups search results by semantic similarity using embedding vectors
 * before diversity re-ranking. This improves result quality by:
 * - Identifying and grouping duplicate/near-duplicate content
 * - Enabling cluster-aware diversity (select from different semantic groups)
 * - Providing better context for MMR re-ranking
 *
 * Uses DBSCAN (Density-Based Spatial Clustering) algorithm which:
 * - Doesn't require pre-specifying number of clusters
 * - Handles noise/outliers naturally
 * - Works well with cosine distance in high-dimensional spaces
 *
 * @see Ester et al., "A Density-Based Algorithm for Discovering Clusters" (1996)
 */

import { cosineSimilarity } from "./internal.js";

export type ClusterConfig = {
  /** Enable/disable clustering. Default: false (opt-in) */
  enabled: boolean;
  /** Epsilon: maximum distance for points to be in same cluster. Default: 0.15 */
  epsilon: number;
  /** MinPts: minimum points to form a dense region. Default: 2 */
  minPoints: number;
};

export const DEFAULT_CLUSTER_CONFIG: ClusterConfig = {
  enabled: false,
  epsilon: 0.15, // cosine distance of 0.15 = similarity of 0.85 (very similar)
  minPoints: 2,
};

export type ClusterableItem = {
  id: string;
  embedding?: number[];
};

export type ClusterResult<T extends ClusterableItem> = {
  clusterId: number; // -1 for noise/outliers
  items: T[];
};

/**
 * Compute cosine distance (1 - cosine similarity) between two embeddings.
 * Returns a value in [0, 2] where 0 means identical vectors.
 */
function cosineDistance(a: number[], b: number[]): number {
  return 1 - cosineSimilarity(a, b);
}

/**
 * DBSCAN clustering algorithm implementation.
 *
 * @param items - Items with embeddings to cluster
 * @param config - Clustering configuration
 * @returns Array of clusters, each containing items from the same semantic group
 */
export function clusterByEmbeddings<T extends ClusterableItem>(
  items: T[],
  config: Partial<ClusterConfig> = {},
): ClusterResult<T>[] {
  const {
    enabled = DEFAULT_CLUSTER_CONFIG.enabled,
    epsilon = DEFAULT_CLUSTER_CONFIG.epsilon,
    minPoints = DEFAULT_CLUSTER_CONFIG.minPoints,
  } = config;

  // Early exits
  if (!enabled || items.length === 0) {
    return items.length > 0 ? [{ clusterId: 0, items: [...items] }] : [];
  }

  // Filter items that have embeddings
  const withEmbeddings = items.filter((item) => item.embedding && item.embedding.length > 0);
  const withoutEmbeddings = items.filter((item) => !item.embedding || item.embedding.length === 0);

  if (withEmbeddings.length === 0) {
    // No embeddings available, return all items as a single cluster
    return [{ clusterId: 0, items: [...items] }];
  }

  // DBSCAN algorithm
  const labels = Array.from({ length: withEmbeddings.length }, () => -1); // -1 = unvisited
  let clusterId = 0;

  for (let i = 0; i < withEmbeddings.length; i++) {
    if (labels[i] !== -1) {
      continue; // Already visited
    }

    const neighbors = findNeighbors(withEmbeddings, i, epsilon);

    if (neighbors.length < minPoints) {
      labels[i] = -1; // Mark as noise
      continue;
    }

    // Start a new cluster
    labels[i] = clusterId;
    expandCluster(withEmbeddings, labels, i, neighbors, clusterId, epsilon, minPoints);
    clusterId++;
  }

  // Group items by cluster ID
  const clusterMap = new Map<number, T[]>();

  for (let i = 0; i < withEmbeddings.length; i++) {
    const label = labels[i];
    const item = withEmbeddings[i];
    if (!clusterMap.has(label)) {
      clusterMap.set(label, []);
    }
    clusterMap.get(label)!.push(item);
  }

  // Add items without embeddings to noise cluster
  if (withoutEmbeddings.length > 0) {
    const noiseCluster = clusterMap.get(-1) ?? [];
    noiseCluster.push(...withoutEmbeddings);
    clusterMap.set(-1, noiseCluster);
  }

  // Convert to result format, sorted by cluster ID (noise last)
  const results: ClusterResult<T>[] = [];
  const sortedIds = Array.from(clusterMap.keys()).toSorted((a, b) => {
    if (a === -1) {
      return 1; // Noise goes last
    }
    if (b === -1) {
      return -1;
    }
    return a - b;
  });

  for (const id of sortedIds) {
    const items = clusterMap.get(id);
    if (items && items.length > 0) {
      results.push({ clusterId: id, items });
    }
  }

  return results;
}

/**
 * Find all neighbors of a point within epsilon distance.
 */
function findNeighbors<T extends ClusterableItem>(
  items: T[],
  pointIdx: number,
  epsilon: number,
): number[] {
  const neighbors: number[] = [];
  const point = items[pointIdx];
  if (!point.embedding) {
    return neighbors;
  }

  for (let i = 0; i < items.length; i++) {
    if (i === pointIdx) {
      continue;
    }
    const other = items[i];
    if (!other.embedding) {
      continue;
    }
    const distance = cosineDistance(point.embedding, other.embedding);
    if (distance <= epsilon) {
      neighbors.push(i);
    }
  }

  return neighbors;
}

/**
 * Expand a cluster by recursively adding neighbors.
 */
function expandCluster<T extends ClusterableItem>(
  items: T[],
  labels: number[],
  pointIdx: number,
  neighbors: number[],
  clusterId: number,
  epsilon: number,
  minPoints: number,
): void {
  const queue = [...neighbors];

  while (queue.length > 0) {
    const currentIdx = queue.shift()!;

    if (labels[currentIdx] === -1) {
      // Unvisited or noise — assign to cluster
      labels[currentIdx] = clusterId;
    } else {
      // Already in another cluster — skip
      continue;
    }

    const currentNeighbors = findNeighbors(items, currentIdx, epsilon);

    if (currentNeighbors.length >= minPoints) {
      // This point can expand the cluster
      for (const neighborIdx of currentNeighbors) {
        if (labels[neighborIdx] === -1) {
          // Unvisited or noise
          queue.push(neighborIdx);
        }
      }
    }
  }
}

/**
 * Get cluster statistics for debugging/monitoring.
 */
export function getClusterStats<T extends ClusterableItem>(
  clusters: ClusterResult<T>[],
): {
  totalClusters: number;
  noiseClusters: number;
  averageClusterSize: number;
  largestClusterSize: number;
} {
  const noiseClusters = clusters.filter((c) => c.clusterId === -1).length;
  const realClusters = clusters.filter((c) => c.clusterId !== -1);
  const totalItemsInRealClusters = realClusters.reduce((sum, c) => sum + c.items.length, 0);

  return {
    totalClusters: realClusters.length,
    noiseClusters,
    averageClusterSize:
      realClusters.length > 0 ? totalItemsInRealClusters / realClusters.length : 0,
    largestClusterSize: Math.max(...clusters.map((c) => c.items.length), 0),
  };
}

/**
 * Select diverse representatives from clusters for MMR input.
 * Takes the highest-scoring item from each cluster.
 */
export function selectClusterRepresentatives<T extends ClusterableItem & { score: number }>(
  clusters: ClusterResult<T>[],
  maxPerCluster: number = 1,
): T[] {
  const representatives: T[] = [];

  for (const cluster of clusters) {
    // Sort by score descending
    const sorted = [...cluster.items].toSorted((a, b) => b.score - a.score);
    representatives.push(...sorted.slice(0, maxPerCluster));
  }

  return representatives;
}
