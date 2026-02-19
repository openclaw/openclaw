import { Readability } from "@mozilla/readability";
import { JSDOM } from "linkedom";
import type { NewsArticle, NewsSource } from "./types.js";

/**
 * Parses RSS/Atom feeds and extracts article metadata.
 */
export class RSSParser {
  /**
   * Parses an RSS feed XML string and returns articles.
   */
  static async parseRSS(
    xml: string,
    source: NewsSource,
    baseUrl: string,
  ): Promise<NewsArticle[]> {
    const articles: NewsArticle[] = [];
    const dom = new JSDOM(xml, { contentType: "text/xml" });
    const doc = dom.window.document;

    // Handle RSS 2.0
    const items = doc.querySelectorAll("item");
    for (const item of items) {
      const title = item.querySelector("title")?.textContent?.trim();
      const link = item.querySelector("link")?.textContent?.trim();
      const description = item.querySelector("description")?.textContent?.trim();
      const pubDate = item.querySelector("pubDate")?.textContent?.trim();
      const author = item.querySelector("author")?.textContent?.trim();
      const categories = Array.from(item.querySelectorAll("category")).map(
        (cat) => cat.textContent?.trim() || "",
      );

      if (title && link) {
        articles.push({
          id: this.generateArticleId(link, source.id),
          sourceId: source.id,
          title,
          url: this.resolveUrl(link, baseUrl),
          description,
          publishedAt: this.parseDate(pubDate) || new Date(),
          fetchedAt: new Date(),
          author,
          categories: categories.filter(Boolean),
        });
      }
    }

    // Handle Atom feeds
    if (articles.length === 0) {
      const entries = doc.querySelectorAll("entry");
      for (const entry of entries) {
        const title = entry.querySelector("title")?.textContent?.trim();
        const link =
          entry.querySelector("link")?.getAttribute("href") ||
          entry.querySelector("link")?.textContent?.trim();
        const summary = entry.querySelector("summary")?.textContent?.trim();
        const published = entry.querySelector("published")?.textContent?.trim();
        const author = entry.querySelector("author > name")?.textContent?.trim();
        const categories = Array.from(entry.querySelectorAll("category")).map(
          (cat) => cat.getAttribute("term") || "",
        );

        if (title && link) {
          articles.push({
            id: this.generateArticleId(link, source.id),
            sourceId: source.id,
            title,
            url: this.resolveUrl(link, baseUrl),
            description: summary,
            publishedAt: this.parseDate(published) || new Date(),
            fetchedAt: new Date(),
            author,
            categories: categories.filter(Boolean),
          });
        }
      }
    }

    return articles;
  }

  /**
   * Generates a unique article ID from URL and source.
   */
  private static generateArticleId(url: string, sourceId: string): string {
    // Simple hash-based ID
    const hash = url.split("").reduce((acc, char) => {
      const hash = ((acc << 5) - acc + char.charCodeAt(0)) | 0;
      return hash;
    }, 0);
    return `${sourceId}_${Math.abs(hash).toString(36)}`;
  }

  /**
   * Resolves relative URLs to absolute.
   */
  private static resolveUrl(url: string, baseUrl: string): string {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      return url;
    }
    try {
      return new URL(url, baseUrl).href;
    } catch {
      return url;
    }
  }

  /**
   * Parses various date formats.
   */
  private static parseDate(dateStr?: string): Date | null {
    if (!dateStr) {
      return null;
    }
    const parsed = new Date(dateStr);
    return isNaN(parsed.getTime()) ? null : parsed;
  }

  /**
   * Extracts full article content from a URL using Readability.
   */
  static async extractContent(url: string): Promise<string | null> {
    try {
      // This would typically use web_fetch tool in practice
      // For now, return null - content extraction happens via web_fetch
      return null;
    } catch {
      return null;
    }
  }
}
