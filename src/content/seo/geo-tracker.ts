import type { RankedArticle } from "../ranking/types.js";

export type RankingCheck = {
  articleId: string;
  articleUrl: string;
  engine: string;
  query: string;
  position?: number;
  checkedAt: Date;
  error?: string;
};

export type GEORankingResult = {
  articleId: string;
  articleUrl: string;
  rankings: RankingCheck[];
};

/**
 * Tracks article rankings in Generative Engine Optimization (GEO) systems.
 * GEO refers to optimizing for AI search engines like ChatGPT, Grok, etc.
 */
export class GEOTracker {
  /**
   * Checks rankings for articles in AI search engines.
   */
  static async checkRankings(
    articles: RankedArticle[],
    queries: string[],
    engines: string[] = ["chatgpt", "grok", "claude", "perplexity"],
  ): Promise<GEORankingResult[]> {
    const results: GEORankingResult[] = [];

    for (const article of articles) {
      const rankings: RankingCheck[] = [];

      for (const engine of engines) {
        for (const query of queries) {
          try {
            const ranking = await this.checkRanking(article, query, engine);
            rankings.push(ranking);
          } catch (error) {
            rankings.push({
              articleId: article.id,
              articleUrl: article.url,
              engine,
              query,
              checkedAt: new Date(),
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      results.push({
        articleId: article.id,
        articleUrl: article.url,
        rankings,
      });
    }

    return results;
  }

  /**
   * Checks ranking for a single article in a search engine.
   * In practice, this would use web_search or API calls to check rankings.
   */
  private static async checkRanking(
    article: RankedArticle,
    query: string,
    engine: string,
  ): Promise<RankingCheck> {
    // Placeholder implementation
    // In practice, this would:
    // 1. Use web_search to search for the query in the engine
    // 2. Check if the article URL appears in results
    // 3. Return the position (1-indexed) or undefined if not found

    return {
      articleId: article.id,
      articleUrl: article.url,
      engine,
      query,
      checkedAt: new Date(),
      // position would be set here in real implementation
    };
  }

  /**
   * Generates queries for an article based on its content.
   */
  static generateQueries(article: RankedArticle): string[] {
    const queries: string[] = [];

    // Use title as primary query
    queries.push(article.title);

    // Extract key phrases from title
    const titleWords = article.title.split(/\s+/);
    if (titleWords.length > 3) {
      // Use first few words as query
      queries.push(titleWords.slice(0, 5).join(" "));
    }

    // Use categories as queries
    if (article.categories && article.categories.length > 0) {
      for (const category of article.categories.slice(0, 3)) {
        queries.push(category);
      }
    }

    return queries.slice(0, 5); // Limit to 5 queries
  }

  /**
   * Formats ranking results for display.
   */
  static formatRankings(results: GEORankingResult[]): string {
    const lines: string[] = [];

    for (const result of results) {
      lines.push(`## ${result.articleUrl}`);
      lines.push("");

      for (const ranking of result.rankings) {
        if (ranking.error) {
          lines.push(
            `- ${ranking.engine} (${ranking.query}): Error - ${ranking.error}`,
          );
        } else if (ranking.position) {
          lines.push(
            `- ${ranking.engine} (${ranking.query}): Position ${ranking.position}`,
          );
        } else {
          lines.push(
            `- ${ranking.engine} (${ranking.query}): Not found in top results`,
          );
        }
      }

      lines.push("");
    }

    return lines.join("\n");
  }
}
