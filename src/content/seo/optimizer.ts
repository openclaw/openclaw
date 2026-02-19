import type { RankedArticle } from "../ranking/types.js";
import { CrossLinker } from "./crosslinker.js";
import { GEOTracker } from "./geo-tracker.js";

export type OptimizationSuggestion = {
  type: "crosslink" | "title" | "description" | "keywords" | "structure";
  priority: "high" | "medium" | "low";
  articleId: string;
  suggestion: string;
  reason: string;
};

/**
 * Provides SEO/GEO optimization suggestions for articles.
 */
export class SEOOptimizer {
  /**
   * Analyzes articles and provides optimization suggestions.
   */
  static analyze(
    articles: RankedArticle[],
  ): OptimizationSuggestion[] {
    const suggestions: OptimizationSuggestion[] = [];

    // Check for missing cross-links
    const crossLinks = CrossLinker.generateCrossLinks(articles);
    for (const result of crossLinks) {
      if (result.links.length === 0) {
        suggestions.push({
          type: "crosslink",
          priority: "medium",
          articleId: result.articleId,
          suggestion: "Add cross-links to related articles",
          reason: "No related articles found for cross-linking",
        });
      }
    }

    // Check title length
    for (const article of articles) {
      if (article.title.length < 30) {
        suggestions.push({
          type: "title",
          priority: "high",
          articleId: article.id,
          suggestion: `Expand title (currently ${article.title.length} chars, recommend 50-60)`,
          reason: "Short titles may not rank well in search engines",
        });
      } else if (article.title.length > 70) {
        suggestions.push({
          type: "title",
          priority: "medium",
          articleId: article.id,
          suggestion: `Shorten title (currently ${article.title.length} chars, recommend 50-60)`,
          reason: "Long titles may be truncated in search results",
        });
      }
    }

    // Check description length
    for (const article of articles) {
      if (!article.description || article.description.length < 120) {
        suggestions.push({
          type: "description",
          priority: "high",
          articleId: article.id,
          suggestion: "Add or expand description (recommend 120-160 chars)",
          reason: "Descriptions help with SEO and click-through rates",
        });
      } else if (article.description.length > 160) {
        suggestions.push({
          type: "description",
          priority: "medium",
          articleId: article.id,
          suggestion: `Shorten description (currently ${article.description.length} chars, recommend 120-160)`,
          reason: "Long descriptions may be truncated",
        });
      }
    }

    // Check for keywords
    for (const article of articles) {
      if (!article.categories || article.categories.length === 0) {
        suggestions.push({
          type: "keywords",
          priority: "medium",
          articleId: article.id,
          suggestion: "Add categories/keywords",
          reason: "Keywords help with discoverability",
        });
      }
    }

    return suggestions.sort((a, b) => {
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });
  }

  /**
   * Generates optimization report.
   */
  static generateReport(
    articles: RankedArticle[],
  ): string {
    const suggestions = this.analyze(articles);
    const lines: string[] = [];

    lines.push("# SEO/GEO Optimization Report");
    lines.push("");
    lines.push(`**Total Articles:** ${articles.length}`);
    lines.push(`**Total Suggestions:** ${suggestions.length}`);
    lines.push("");

    const byPriority = {
      high: suggestions.filter((s) => s.priority === "high"),
      medium: suggestions.filter((s) => s.priority === "medium"),
      low: suggestions.filter((s) => s.priority === "low"),
    };

    if (byPriority.high.length > 0) {
      lines.push("## High Priority");
      lines.push("");
      for (const suggestion of byPriority.high) {
        lines.push(`- **[${suggestion.type}]** ${suggestion.suggestion}`);
        lines.push(`  - Article: ${suggestion.articleId}`);
        lines.push(`  - Reason: ${suggestion.reason}`);
        lines.push("");
      }
    }

    if (byPriority.medium.length > 0) {
      lines.push("## Medium Priority");
      lines.push("");
      for (const suggestion of byPriority.medium) {
        lines.push(`- **[${suggestion.type}]** ${suggestion.suggestion}`);
        lines.push(`  - Article: ${suggestion.articleId}`);
        lines.push(`  - Reason: ${suggestion.reason}`);
        lines.push("");
      }
    }

    if (byPriority.low.length > 0) {
      lines.push("## Low Priority");
      lines.push("");
      for (const suggestion of byPriority.low) {
        lines.push(`- **[${suggestion.type}]** ${suggestion.suggestion}`);
        lines.push(`  - Article: ${suggestion.articleId}`);
        lines.push(`  - Reason: ${suggestion.reason}`);
        lines.push("");
      }
    }

    return lines.join("\n");
  }
}
