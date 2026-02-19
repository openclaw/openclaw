import { loadConfig } from "../../config/config.js";
import type { NewsArticle } from "../news-aggregator/types.js";
import { ArticleScorer } from "./scorer.js";
import type { RankedArticle, RankingConfig } from "./types.js";

/**
 * Ranks articles by importance using multiple scoring factors.
 */
export class ArticleRanker {
  private config: RankingConfig;

  constructor(config?: Partial<RankingConfig>) {
    const defaultConfig: RankingConfig = {
      recencyWeight: 0.3,
      authorityWeight: 0.2,
      semanticWeight: 0.3,
      engagementWeight: 0.1,
      crossReferenceWeight: 0.1,
    };

    const cfg = loadConfig();
    const rankingConfig = cfg.content?.ranking;
    this.config = {
      recencyWeight: config?.recencyWeight ?? rankingConfig?.recencyWeight ?? defaultConfig.recencyWeight,
      authorityWeight: config?.authorityWeight ?? rankingConfig?.authorityWeight ?? defaultConfig.authorityWeight,
      semanticWeight: config?.semanticWeight ?? rankingConfig?.semanticWeight ?? defaultConfig.semanticWeight,
      engagementWeight: config?.engagementWeight ?? rankingConfig?.engagementWeight ?? defaultConfig.engagementWeight,
      crossReferenceWeight: config?.crossReferenceWeight ?? 0.1,
    };
  }

  /**
   * Ranks articles by importance.
   */
  rankArticles(
    articles: NewsArticle[],
    sourceAuthorityMap?: Record<string, number>,
    queryEmbedding?: number[],
  ): RankedArticle[] {
    const ranked: RankedArticle[] = articles.map((article) => {
      const score = ArticleScorer.scoreImportance(
        article,
        this.config,
        articles,
        sourceAuthorityMap,
        queryEmbedding,
      );

      const recency = ArticleScorer.scoreRecency(article);
      const authority = ArticleScorer.scoreAuthority(
        article.sourceId,
        sourceAuthorityMap,
      );
      const semantic = ArticleScorer.scoreSemantic(article, queryEmbedding);
      const engagement = ArticleScorer.scoreEngagement(article);
      const crossReferences = ArticleScorer.scoreCrossReferences(
        article,
        articles,
      );

      return {
        ...article,
        score,
        rankingFactors: {
          recency,
          authority,
          semantic,
          engagement,
          crossReferences,
        },
      };
    });

    // Sort by score (highest first)
    return ranked.sort((a, b) => b.score - a.score);
  }

  /**
   * Gets top N articles by importance.
   */
  getTopArticles(
    articles: NewsArticle[],
    limit: number,
    sourceAuthorityMap?: Record<string, number>,
    queryEmbedding?: number[],
  ): RankedArticle[] {
    const ranked = this.rankArticles(articles, sourceAuthorityMap, queryEmbedding);
    return ranked.slice(0, limit);
  }
}
