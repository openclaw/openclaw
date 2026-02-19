import type { RankedArticle, Cluster } from "./types.js";

/**
 * Clusters articles by semantic similarity.
 * Uses simple keyword-based clustering (in practice, would use embeddings).
 */
export class ArticleClusterer {
  /**
   * Clusters articles by semantic similarity.
   */
  static clusterArticles(
    articles: RankedArticle[],
    minClusterSize: number = 2,
  ): Cluster[] {
    const clusters: Cluster[] = [];
    const processed = new Set<string>();

    for (const article of articles) {
      if (processed.has(article.id)) {
        continue;
      }

      const cluster = this.findOrCreateCluster(article, articles, processed);
      if (cluster.articles.length >= minClusterSize) {
        clusters.push(cluster);
      }
    }

    return clusters;
  }

  /**
   * Finds or creates a cluster for an article.
   */
  private static findOrCreateCluster(
    article: RankedArticle,
    allArticles: RankedArticle[],
    processed: Set<string>,
  ): Cluster {
    const clusterArticles: RankedArticle[] = [article];
    processed.add(article.id);

    const keywords = this.extractKeywords(article);
    const clusterId = `cluster_${article.id}`;

    // Find similar articles
    for (const other of allArticles) {
      if (processed.has(other.id)) {
        continue;
      }

      const similarity = this.calculateSimilarity(article, other);
      if (similarity > 0.3) {
        // Threshold for clustering
        clusterArticles.push(other);
        processed.add(other.id);
        keywords.push(...this.extractKeywords(other));
      }
    }

    // Deduplicate keywords
    const uniqueKeywords = Array.from(new Set(keywords)).slice(0, 10);

    return {
      id: clusterId,
      label: this.generateClusterLabel(clusterArticles),
      articles: clusterArticles.sort((a, b) => b.score - a.score),
      keywords: uniqueKeywords,
    };
  }

  /**
   * Extracts keywords from an article.
   */
  private static extractKeywords(article: RankedArticle): string[] {
    const text = `${article.title} ${article.description || ""}`.toLowerCase();
    const words = text.split(/\s+/);
    const stopWords = new Set([
      "the",
      "a",
      "an",
      "and",
      "or",
      "but",
      "in",
      "on",
      "at",
      "to",
      "for",
      "of",
      "with",
      "by",
      "from",
      "as",
      "is",
      "was",
      "are",
      "were",
      "be",
      "been",
      "being",
      "have",
      "has",
      "had",
      "do",
      "does",
      "did",
      "will",
      "would",
      "could",
      "should",
      "may",
      "might",
      "must",
      "can",
      "this",
      "that",
      "these",
      "those",
    ]);

    const keywords = words
      .filter((word) => word.length > 3 && !stopWords.has(word))
      .slice(0, 10);

    return keywords;
  }

  /**
   * Calculates similarity between two articles.
   */
  private static calculateSimilarity(
    a: RankedArticle,
    b: RankedArticle,
  ): number {
    const aKeywords = new Set(this.extractKeywords(a));
    const bKeywords = new Set(this.extractKeywords(b));

    const intersection = new Set(
      [...aKeywords].filter((x) => bKeywords.has(x)),
    );
    const union = new Set([...aKeywords, ...bKeywords]);

    if (union.size === 0) {
      return 0;
    }

    // Jaccard similarity
    return intersection.size / union.size;
  }

  /**
   * Generates a label for a cluster.
   */
  private static generateClusterLabel(articles: RankedArticle[]): string {
    if (articles.length === 0) {
      return "Empty Cluster";
    }

    // Use the title of the highest-scoring article
    const topArticle = articles[0];
    const words = topArticle.title.split(/\s+/).slice(0, 5);
    return words.join(" ");
  }
}
