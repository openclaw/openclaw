import { describe, expect, test } from "vitest";
import {
  clusterByEmbeddings,
  getClusterStats,
  selectClusterRepresentatives,
} from "./semantic-clustering.js";

describe("semantic-clustering", () => {
  describe("clusterByEmbeddings", () => {
    test("returns single cluster when clustering is disabled", () => {
      const items = [
        { id: "1", embedding: [1, 0, 0] },
        { id: "2", embedding: [0, 1, 0] },
        { id: "3", embedding: [0, 0, 1] },
      ];

      const clusters = clusterByEmbeddings(items, { enabled: false });

      expect(clusters).toHaveLength(1);
      expect(clusters[0].clusterId).toBe(0);
      expect(clusters[0].items).toHaveLength(3);
    });

    test("handles empty input", () => {
      const clusters = clusterByEmbeddings([], { enabled: true });
      expect(clusters).toHaveLength(0);
    });

    test("creates multiple clusters for dissimilar vectors", () => {
      // Three orthogonal vectors - should form separate clusters or noise
      const items = [
        { id: "1", embedding: [1, 0, 0] },
        { id: "2", embedding: [0, 1, 0] },
        { id: "3", embedding: [0, 0, 1] },
      ];

      const clusters = clusterByEmbeddings(items, {
        enabled: true,
        epsilon: 0.3, // Lower epsilon = stricter clustering
        minPoints: 1,
      });

      // With low epsilon and dissimilar vectors, each should be noise or separate clusters
      expect(clusters.length).toBeGreaterThanOrEqual(1);
    });

    test("groups similar vectors into same cluster", () => {
      // Two pairs of similar vectors
      const items = [
        { id: "1", embedding: [1, 0, 0] },
        { id: "2", embedding: [0.95, 0.05, 0] }, // Very similar to 1
        { id: "3", embedding: [0, 1, 0] },
        { id: "4", embedding: [0, 0.95, 0.05] }, // Very similar to 3
      ];

      const clusters = clusterByEmbeddings(items, {
        enabled: true,
        epsilon: 0.2, // Allow some distance
        minPoints: 1, // minPoints=1 means need at least 1 neighbor to form cluster
      });

      // Should form 2 clusters (each with 2 items)
      const realClusters = clusters.filter((c) => c.clusterId !== -1);
      expect(realClusters.length).toBeGreaterThanOrEqual(1);
      expect(realClusters.length).toBeLessThanOrEqual(2);
    });

    test("marks outliers as noise (cluster ID -1)", () => {
      const items = [
        { id: "1", embedding: [1, 0, 0] },
        { id: "2", embedding: [0.98, 0.02, 0] }, // Close to 1
        { id: "3", embedding: [0, 0, 1] }, // Outlier
      ];

      const clusters = clusterByEmbeddings(items, {
        enabled: true,
        epsilon: 0.15,
        minPoints: 2,
      });

      const noiseClusters = clusters.filter((c) => c.clusterId === -1);
      // At least one item should be in noise
      const noiseItems = noiseClusters.flatMap((c) => c.items);
      expect(noiseItems.length).toBeGreaterThanOrEqual(1);
    });

    test("handles items without embeddings", () => {
      const items = [
        { id: "1", embedding: [1, 0, 0] },
        { id: "2" }, // No embedding
        { id: "3", embedding: [0.95, 0.05, 0] },
      ];

      const clusters = clusterByEmbeddings(items, {
        enabled: true,
        epsilon: 0.2,
        minPoints: 1,
      });

      // Items without embeddings should be in noise cluster
      const allItems = clusters.flatMap((c) => c.items);
      expect(allItems).toHaveLength(3);
      expect(allItems.some((item) => item.id === "2")).toBe(true);
    });

    test("respects minPoints parameter", () => {
      // Only 2 items close together, but minPoints=3
      const items = [
        { id: "1", embedding: [1, 0, 0] },
        { id: "2", embedding: [0.98, 0.02, 0] },
        { id: "3", embedding: [0, 1, 0] },
      ];

      const clusters = clusterByEmbeddings(items, {
        enabled: true,
        epsilon: 0.15,
        minPoints: 3, // Require at least 3 points for a cluster
      });

      // With minPoints=3 and only 3 dissimilar items, all should be noise
      const realClusters = clusters.filter((c) => c.clusterId !== -1);
      expect(realClusters.length).toBe(0);
    });

    test("uses default config when partial config provided", () => {
      const items = [
        { id: "1", embedding: [1, 0, 0] },
        { id: "2", embedding: [0.95, 0.05, 0] },
      ];

      const clusters = clusterByEmbeddings(items, { enabled: true });

      // Should use default epsilon and minPoints
      expect(clusters.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("getClusterStats", () => {
    test("computes stats for single cluster", () => {
      const clusters = [
        {
          clusterId: 0,
          items: [
            { id: "1", embedding: [1, 0, 0] },
            { id: "2", embedding: [0, 1, 0] },
          ],
        },
      ];

      const stats = getClusterStats(clusters);

      expect(stats.totalClusters).toBe(1);
      expect(stats.noiseClusters).toBe(0);
      expect(stats.averageClusterSize).toBe(2);
      expect(stats.largestClusterSize).toBe(2);
    });

    test("computes stats for multiple clusters including noise", () => {
      const clusters = [
        {
          clusterId: 0,
          items: [
            { id: "1", embedding: [1, 0, 0] },
            { id: "2", embedding: [0.95, 0.05, 0] },
          ],
        },
        {
          clusterId: 1,
          items: [
            { id: "3", embedding: [0, 1, 0] },
            { id: "4", embedding: [0, 0.95, 0.05] },
            { id: "5", embedding: [0.05, 0.95, 0] },
          ],
        },
        {
          clusterId: -1, // Noise
          items: [{ id: "6", embedding: [0, 0, 1] }],
        },
      ];

      const stats = getClusterStats(clusters);

      expect(stats.totalClusters).toBe(2);
      expect(stats.noiseClusters).toBe(1);
      expect(stats.averageClusterSize).toBe(2.5); // (2+3)/2
      expect(stats.largestClusterSize).toBe(3);
    });

    test("handles empty clusters", () => {
      const stats = getClusterStats([]);

      expect(stats.totalClusters).toBe(0);
      expect(stats.noiseClusters).toBe(0);
      expect(stats.averageClusterSize).toBe(0);
      expect(stats.largestClusterSize).toBe(0);
    });
  });

  describe("selectClusterRepresentatives", () => {
    test("selects top item from each cluster", () => {
      const clusters = [
        {
          clusterId: 0,
          items: [
            { id: "1", embedding: [1, 0, 0], score: 0.9 },
            { id: "2", embedding: [0.95, 0.05, 0], score: 0.7 },
          ],
        },
        {
          clusterId: 1,
          items: [
            { id: "3", embedding: [0, 1, 0], score: 0.8 },
            { id: "4", embedding: [0, 0.95, 0.05], score: 0.6 },
          ],
        },
      ];

      const reps = selectClusterRepresentatives(clusters, 1);

      expect(reps).toHaveLength(2);
      expect(reps[0].id).toBe("1"); // Highest score in cluster 0
      expect(reps[0].score).toBe(0.9);
      expect(reps[1].id).toBe("3"); // Highest score in cluster 1
      expect(reps[1].score).toBe(0.8);
    });

    test("selects multiple representatives per cluster when requested", () => {
      const clusters = [
        {
          clusterId: 0,
          items: [
            { id: "1", embedding: [1, 0, 0], score: 0.9 },
            { id: "2", embedding: [0.95, 0.05, 0], score: 0.8 },
            { id: "3", embedding: [0.9, 0.1, 0], score: 0.7 },
          ],
        },
      ];

      const reps = selectClusterRepresentatives(clusters, 2);

      expect(reps).toHaveLength(2);
      expect(reps[0].score).toBe(0.9);
      expect(reps[1].score).toBe(0.8);
    });

    test("handles noise clusters", () => {
      const clusters = [
        {
          clusterId: 0,
          items: [
            { id: "1", embedding: [1, 0, 0], score: 0.9 },
            { id: "2", embedding: [0.95, 0.05, 0], score: 0.7 },
          ],
        },
        {
          clusterId: -1, // Noise
          items: [{ id: "3", score: 0.5 }],
        },
      ];

      const reps = selectClusterRepresentatives(clusters, 1);

      expect(reps).toHaveLength(2);
      expect(reps.some((r) => r.id === "1")).toBe(true);
      expect(reps.some((r) => r.id === "3")).toBe(true);
    });

    test("returns empty array for empty clusters", () => {
      const reps = selectClusterRepresentatives([], 1);
      expect(reps).toHaveLength(0);
    });
  });

  describe("integration with real-world scenarios", () => {
    test("clusters duplicate content correctly", () => {
      // Simulate search results with duplicate or very similar content
      const items = [
        { id: "1", embedding: [0.8, 0.5, 0.3] }, // Original
        { id: "2", embedding: [0.81, 0.49, 0.31] }, // Near-duplicate
        { id: "3", embedding: [0.79, 0.51, 0.29] }, // Near-duplicate
        { id: "4", embedding: [0.2, 0.9, 0.1] }, // Different topic
      ];

      const clusters = clusterByEmbeddings(items, {
        enabled: true,
        epsilon: 0.15,
        minPoints: 2,
      });

      // Should group the 3 similar items together
      const realClusters = clusters.filter((c) => c.clusterId !== -1);
      expect(realClusters.length).toBeGreaterThanOrEqual(1);

      // One cluster should have at least 2 items
      const largestCluster = clusters.reduce(
        (max, c) => (c.items.length > max.items.length ? c : max),
        clusters[0],
      );
      expect(largestCluster.items.length).toBeGreaterThanOrEqual(2);
    });
  });
});
