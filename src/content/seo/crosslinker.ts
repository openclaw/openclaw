import type { RankedArticle } from "../ranking/types.js";

export type CrossLink = {
  fromArticleId: string;
  toArticleId: string;
  anchorText: string;
  relevanceScore: number;
};

export type CrossLinkResult = {
  articleId: string;
  links: CrossLink[];
};

/**
 * Generates cross-links between related articles for SEO.
 */
export class CrossLinker {
  /**
   * Generates cross-links for all articles.
   */
  static generateCrossLinks(
    articles: RankedArticle[],
    maxLinksPerArticle: number = 5,
    minRelevanceScore: number = 0.3,
  ): CrossLinkResult[] {
    const results: CrossLinkResult[] = [];

    for (const article of articles) {
      const links = this.findRelatedArticles(
        article,
        articles,
        maxLinksPerArticle,
        minRelevanceScore,
      );
      results.push({
        articleId: article.id,
        links,
      });
    }

    return results;
  }

  /**
   * Finds related articles for cross-linking.
   */
  private static findRelatedArticles(
    article: RankedArticle,
    allArticles: RankedArticle[],
    maxLinks: number,
    minScore: number,
  ): CrossLink[] {
    const candidates: CrossLink[] = [];

    for (const other of allArticles) {
      if (other.id === article.id) {
        continue;
      }

      const relevance = this.calculateRelevance(article, other);
      if (relevance >= minScore) {
        const anchorText = this.generateAnchorText(article, other);
        candidates.push({
          fromArticleId: article.id,
          toArticleId: other.id,
          anchorText,
          relevanceScore: relevance,
        });
      }
    }

    // Sort by relevance and take top N
    return candidates
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, maxLinks);
  }

  /**
   * Calculates relevance between two articles.
   */
  private static calculateRelevance(
    a: RankedArticle,
    b: RankedArticle,
  ): number {
    // Keyword overlap
    const aKeywords = this.extractKeywords(a);
    const bKeywords = this.extractKeywords(b);
    const overlap = aKeywords.filter((k) => bKeywords.has(k)).length;
    const keywordScore = overlap / Math.max(aKeywords.size, bKeywords.size, 1);

    // Category overlap
    const aCategories = new Set(a.categories || []);
    const bCategories = new Set(b.categories || []);
    const categoryOverlap = [...aCategories].filter((c) => bCategories.has(c))
      .length;
    const categoryScore =
      categoryOverlap / Math.max(aCategories.size, bCategories.size, 1);

    // Source similarity (same source = higher relevance)
    const sourceScore = a.sourceId === b.sourceId ? 0.2 : 0;

    return keywordScore * 0.6 + categoryScore * 0.2 + sourceScore;
  }

  /**
   * Extracts keywords from an article.
   */
  private static extractKeywords(article: RankedArticle): Set<string> {
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
    ]);

    return new Set(
      words.filter((w) => w.length > 3 && !stopWords.has(w)).slice(0, 20),
    );
  }

  /**
   * Generates anchor text for a cross-link.
   */
  private static generateAnchorText(
    from: RankedArticle,
    to: RankedArticle,
  ): string {
    // Use the title of the target article, truncated if needed
    const title = to.title;
    if (title.length <= 60) {
      return title;
    }
    return title.substring(0, 57) + "...";
  }

  /**
   * Formats cross-links as HTML anchor tags.
   */
  static formatAsHTML(links: CrossLink[], baseUrl: string = ""): string {
    return links
      .map(
        (link) =>
          `<a href="${baseUrl}/${link.toArticleId}" rel="related">${link.anchorText}</a>`,
      )
      .join(", ");
  }

  /**
   * Formats cross-links as Markdown links.
   */
  static formatAsMarkdown(
    links: CrossLink[],
    articleUrlMap: Record<string, string>,
  ): string {
    return links
      .map((link) => {
        const url = articleUrlMap[link.toArticleId] || `#${link.toArticleId}`;
        return `[${link.anchorText}](${url})`;
      })
      .join(", ");
  }
}
