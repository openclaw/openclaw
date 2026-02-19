import type { NewsArticle } from "../news-aggregator/types.js";
import type { RankingConfig } from "./types.js";

/**
 * Scoring algorithms for ranking articles by importance.
 */
export class ArticleScorer {
  /**
   * Calculates recency score (newer articles score higher).
   */
  static scoreRecency(article: NewsArticle, maxAgeHours: number = 168): number {
    const ageHours =
      (Date.now() - article.publishedAt.getTime()) / (1000 * 60 * 60);
    if (ageHours <= 0) {
      return 1.0; // Just published
    }
    if (ageHours >= maxAgeHours) {
      return 0.0; // Too old
    }
    // Exponential decay
    return Math.exp(-ageHours / (maxAgeHours / 3));
  }

  /**
   * Calculates authority score based on source reputation.
   */
  static scoreAuthority(
    sourceId: string,
    sourceAuthorityMap: Record<string, number> = {},
  ): number {
    // Default authority scores for known sources
    const defaultAuthorities: Record<string, number> = {
      hackernews: 0.9,
      techcrunch: 0.8,
      arstechnica: 0.85,
      theverge: 0.8,
      wired: 0.85,
    };

    return (
      sourceAuthorityMap[sourceId] ||
      defaultAuthorities[sourceId.toLowerCase()] ||
      0.5
    );
  }

  /**
   * Calculates semantic relevance score (placeholder - would use embeddings).
   */
  static scoreSemantic(
    article: NewsArticle,
    queryEmbedding?: number[],
  ): number {
    // In practice, this would use vector similarity
    // For now, return a placeholder score based on keywords
    const aiKeywords = [
      "ai",
      "artificial intelligence",
      "machine learning",
      "llm",
      "gpt",
      "claude",
      "agent",
      "autonomous",
    ];

    const text = `${article.title} ${article.description || ""}`.toLowerCase();
    const matches = aiKeywords.filter((keyword) => text.includes(keyword))
      .length;
    return Math.min(matches / aiKeywords.length, 1.0);
  }

  /**
   * Calculates engagement score (placeholder - would use actual metrics).
   */
  static scoreEngagement(article: NewsArticle): number {
    // In practice, this would use actual engagement metrics
    // For now, return a placeholder
    return 0.5;
  }

  /**
   * Calculates cross-reference score (how many other articles reference this).
   */
  static scoreCrossReferences(
    article: NewsArticle,
    allArticles: NewsArticle[],
  ): number {
    const articleUrl = article.url.toLowerCase();
    let references = 0;

    for (const other of allArticles) {
      const otherText = `${other.title} ${other.description || ""}`.toLowerCase();
      if (otherText.includes(articleUrl) || otherText.includes(article.title.toLowerCase())) {
        references++;
      }
    }

    // Normalize to 0-1 range (assuming max 10 references = 1.0)
    return Math.min(references / 10, 1.0);
  }

  /**
   * Calculates overall importance score.
   */
  static scoreImportance(
    article: NewsArticle,
    config: RankingConfig,
    allArticles: NewsArticle[],
    sourceAuthorityMap?: Record<string, number>,
    queryEmbedding?: number[],
  ): number {
    const recency = this.scoreRecency(article);
    const authority = this.scoreAuthority(article.sourceId, sourceAuthorityMap);
    const semantic = this.scoreSemantic(article, queryEmbedding);
    const engagement = this.scoreEngagement(article);
    const crossReferences = this.scoreCrossReferences(article, allArticles);

    const totalWeight =
      config.recencyWeight +
      config.authorityWeight +
      config.semanticWeight +
      config.engagementWeight +
      config.crossReferenceWeight;

    if (totalWeight === 0) {
      return 0;
    }

    const weightedScore =
      (recency * config.recencyWeight +
        authority * config.authorityWeight +
        semantic * config.semanticWeight +
        engagement * config.engagementWeight +
        crossReferences * config.crossReferenceWeight) /
      totalWeight;

    return weightedScore;
  }
}
