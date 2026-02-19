import { loadConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ContentExtractor } from "./content-extractor.js";
import { RSSParser } from "./rss-parser.js";
import type {
  NewsArticle,
  NewsSource,
  AggregationStatus,
  AggregationConfig,
} from "./types.js";

/**
 * Built-in security and vulnerability RSS feed sources.
 */
const SECURITY_FEED_SOURCES: NewsSource[] = [
  {
    id: "nvd-cve",
    name: "NVD CVE Feed",
    url: "https://nvd.nist.gov/feeds/xml/cve/misc/nvd-rss.xml",
    enabled: true,
    category: "vulnerability",
    tags: ["cve", "nvd", "vulnerability"],
  },
  {
    id: "cisa-alerts",
    name: "CISA Alerts",
    url: "https://www.cisa.gov/uscert/ncas/alerts.xml",
    enabled: true,
    category: "security",
    tags: ["cisa", "alerts", "government"],
  },
  {
    id: "cisa-current-activity",
    name: "CISA Current Activity",
    url: "https://www.cisa.gov/uscert/ncas/current-activity.xml",
    enabled: true,
    category: "security",
    tags: ["cisa", "activity", "government"],
  },
  {
    id: "exploit-db",
    name: "Exploit Database",
    url: "https://www.exploit-db.com/rss.xml",
    enabled: true,
    category: "exploit",
    tags: ["exploit", "poc", "vulnerability"],
  },
  {
    id: "packet-storm",
    name: "Packet Storm Security",
    url: "https://rss.packetstormsecurity.com/",
    enabled: true,
    category: "security",
    tags: ["exploit", "advisory", "tools"],
  },
  {
    id: "krebs-security",
    name: "Krebs on Security",
    url: "https://krebsonsecurity.com/feed/",
    enabled: true,
    category: "news",
    tags: ["news", "breach", "analysis"],
  },
  {
    id: "threatpost",
    name: "Threatpost",
    url: "https://threatpost.com/feed/",
    enabled: true,
    category: "news",
    tags: ["news", "threat", "malware"],
  },
  {
    id: "schneier-security",
    name: "Schneier on Security",
    url: "https://www.schneier.com/feed/",
    enabled: true,
    category: "news",
    tags: ["news", "cryptography", "analysis"],
  },
  {
    id: "security-week",
    name: "SecurityWeek",
    url: "https://www.securityweek.com/feed/",
    enabled: true,
    category: "news",
    tags: ["news", "enterprise", "breach"],
  },
  {
    id: "dark-reading",
    name: "Dark Reading",
    url: "https://www.darkreading.com/rss.xml",
    enabled: true,
    category: "news",
    tags: ["news", "enterprise", "threat"],
  },
  {
    id: "github-advisory",
    name: "GitHub Security Advisories",
    url: "https://github.com/advisories.atom",
    enabled: true,
    category: "vulnerability",
    tags: ["github", "advisory", "dependency"],
  },
];

/**
 * CVE severity levels for filtering.
 */
export type CVESeverity = "critical" | "high" | "medium" | "low" | "unknown";

/**
 * Extended article with security-specific metadata.
 */
export interface SecurityArticle extends NewsArticle {
  cveIds?: string[];
  cvssScore?: number;
  severity?: CVESeverity;
  affectedProducts?: string[];
  references?: string[];
  exploitAvailable?: boolean;
}

/**
 * Security-specific aggregation configuration.
 */
export interface SecurityAggregationConfig extends AggregationConfig {
  includeSecurityFeeds?: boolean;
  securityFeedIds?: string[];
  minSeverity?: CVESeverity;
  filterByCVE?: boolean;
  cvePatterns?: string[];
}

/**
 * Main news aggregation engine.
 * Fetches articles from RSS feeds and extracts content.
 * Enhanced to support security and vulnerability feeds.
 */
export class NewsAggregator {
  private config: OpenClawConfig;
  private articles: Map<string, NewsArticle> = new Map();
  private securityArticles: Map<string, SecurityArticle> = new Map();
  private status: AggregationStatus = {
    running: false,
    articlesFetched: 0,
    errors: [],
  };

  constructor() {
    this.config = loadConfig();
  }

  /**
   * Gets the aggregation configuration.
   */
  private getConfig(): SecurityAggregationConfig {
    const newsConfig = this.config.content?.newsAggregator;
    return {
      enabled: newsConfig?.enabled ?? false,
      sources: newsConfig?.sources || [],
      fetchInterval: newsConfig?.fetchInterval || 60, // default 60 minutes
      storagePath: newsConfig?.storagePath,
      maxArticlesPerSource: newsConfig?.maxArticlesPerSource || 100,
      includeSecurityFeeds: newsConfig?.includeSecurityFeeds ?? true,
      securityFeedIds: newsConfig?.securityFeedIds,
      minSeverity: newsConfig?.minSeverity,
      filterByCVE: newsConfig?.filterByCVE ?? false,
      cvePatterns: newsConfig?.cvePatterns,
    };
  }

  /**
   * Gets available security feed sources.
   */
  getSecurityFeedSources(): NewsSource[] {
    return [...SECURITY_FEED_SOURCES];
  }

  /**
   * Gets enabled security feeds based on config.
   */
  private getEnabledSecurityFeeds(): NewsSource[] {
    const config = this.getConfig();
    if (!config.includeSecurityFeeds) {
      return [];
    }

    if (config.securityFeedIds && config.securityFeedIds.length > 0) {
      return SECURITY_FEED_SOURCES.filter((s) =>
        config.securityFeedIds!.includes(s.id),
      );
    }

    return SECURITY_FEED_SOURCES.filter((s) => s.enabled);
  }

  /**
   * Starts the aggregation process.
   */
  async start(): Promise<void> {
    const config = this.getConfig();
    if (!config.enabled) {
      throw new Error("News aggregator is not enabled in config");
    }

    this.status.running = true;
    this.status.errors = [];

    try {
      // Fetch user-configured sources
      await this.fetchAllSources(config.sources);

      // Fetch security feeds if enabled
      const securityFeeds = this.getEnabledSecurityFeeds();
      if (securityFeeds.length > 0) {
        await this.fetchSecurityFeeds(securityFeeds);
      }

      this.status.lastRun = new Date();
      this.status.nextRun = new Date(
        Date.now() + config.fetchInterval * 60 * 1000,
      );
    } catch (error) {
      this.status.errors.push(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      this.status.running = false;
    }
  }

  /**
   * Stops the aggregation process.
   */
  stop(): void {
    this.status.running = false;
  }

  /**
   * Fetches articles from all enabled sources.
   */
  private async fetchAllSources(sources: NewsSource[]): Promise<void> {
    const enabledSources = sources.filter((s) => s.enabled);
    let totalFetched = 0;

    for (const source of enabledSources) {
      try {
        const articles = await this.fetchSource(source);
        for (const article of articles) {
          this.articles.set(article.id, article);
        }
        totalFetched += articles.length;
      } catch (error) {
        this.status.errors.push(
          `Failed to fetch ${source.name}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    this.status.articlesFetched = totalFetched;
  }

  /**
   * Fetches articles from security and vulnerability feeds.
   */
  private async fetchSecurityFeeds(feeds: NewsSource[]): Promise<void> {
    for (const feed of feeds) {
      try {
        const articles = await this.fetchSource(feed);
        const securityArticles = articles.map((article) =>
          this.parseSecurityMetadata(article),
        );

        // Apply severity filtering
        const config = this.getConfig();
        const filtered = this.filterBySeverity(
          securityArticles,
          config.minSeverity,
        );

        for (const article of filtered) {
          this.securityArticles.set(article.id, article);
          this.articles.set(article.id, article);
        }

        this.status.articlesFetched += filtered.length;
      } catch (error) {
        this.status.errors.push(
          `Failed to fetch security feed ${feed.name}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /**
   * Parses security-specific metadata from an article.
   */
  private parseSecurityMetadata(article: NewsArticle): SecurityArticle {
    const securityArticle: SecurityArticle = { ...article };

    // Extract CVE IDs from title and content
    const cvePattern = /CVE-\d{4}-\d{4,}/gi;
    const text = `${article.title} ${article.summary || ""} ${article.fullContent || ""}`;
    const cveMatches = text.match(cvePattern);
    if (cveMatches) {
      securityArticle.cveIds = [...new Set(cveMatches.map((c) => c.toUpperCase()))];
    }

    // Try to extract CVSS score
    const cvssPattern = /CVSS[:\s]+(\d+\.?\d*)/i;
    const cvssMatch = text.match(cvssPattern);
    if (cvssMatch) {
      securityArticle.cvssScore = parseFloat(cvssMatch[1]);
      securityArticle.severity = this.cvssToSeverity(securityArticle.cvssScore);
    }

    // Check for exploit indicators
    const exploitIndicators = [
      /exploit\s+(available|released|published)/i,
      /proof[- ]of[- ]concept/i,
      /poc\s+(released|available)/i,
      /actively\s+exploited/i,
      /in[- ]the[- ]wild/i,
    ];
    securityArticle.exploitAvailable = exploitIndicators.some((pattern) =>
      pattern.test(text),
    );

    // Extract references (URLs)
    const urlPattern = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;
    const urlMatches = text.match(urlPattern);
    if (urlMatches) {
      securityArticle.references = [...new Set(urlMatches)].slice(0, 10);
    }

    // Infer severity from keywords if not set
    if (!securityArticle.severity) {
      securityArticle.severity = this.inferSeverityFromText(text);
    }

    return securityArticle;
  }

  /**
   * Converts CVSS score to severity level.
   */
  private cvssToSeverity(score: number): CVESeverity {
    if (score >= 9.0) return "critical";
    if (score >= 7.0) return "high";
    if (score >= 4.0) return "medium";
    if (score > 0) return "low";
    return "unknown";
  }

  /**
   * Infers severity from article text content.
   */
  private inferSeverityFromText(text: string): CVESeverity {
    const lowerText = text.toLowerCase();

    if (
      lowerText.includes("critical") ||
      lowerText.includes("severe") ||
      lowerText.includes("emergency") ||
      lowerText.includes("zero-day") ||
      lowerText.includes("0-day")
    ) {
      return "critical";
    }

    if (
      lowerText.includes("high severity") ||
      lowerText.includes("important") ||
      lowerText.includes("serious")
    ) {
      return "high";
    }

    if (
      lowerText.includes("medium severity") ||
      lowerText.includes("moderate")
    ) {
      return "medium";
    }

    if (lowerText.includes("low severity") || lowerText.includes("minor")) {
      return "low";
    }

    return "unknown";
  }

  /**
   * Filters articles by minimum severity.
   */
  private filterBySeverity(
    articles: SecurityArticle[],
    minSeverity?: CVESeverity,
  ): SecurityArticle[] {
    if (!minSeverity || minSeverity === "unknown") {
      return articles;
    }

    const severityOrder: Record<CVESeverity, number> = {
      critical: 4,
      high: 3,
      medium: 2,
      low: 1,
      unknown: 0,
    };

    const minLevel = severityOrder[minSeverity];
    return articles.filter(
      (a) => severityOrder[a.severity || "unknown"] >= minLevel,
    );
  }

  /**
   * Fetches articles from a single source.
   */
  private async fetchSource(source: NewsSource): Promise<NewsArticle[]> {
    const response = await fetch(source.url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const xml = await response.text();
    const baseUrl = new URL(source.url).origin;
    const articles = await RSSParser.parseRSS(xml, source, baseUrl);

    // Limit articles per source
    const config = this.getConfig();
    const maxArticles = config.maxArticlesPerSource || 100;
    return articles.slice(0, maxArticles);
  }

  /**
   * Enhances articles with full content extraction.
   */
  async enhanceArticles(articles: NewsArticle[]): Promise<NewsArticle[]> {
    const enhanced: NewsArticle[] = [];

    for (const article of articles) {
      try {
        const response = await fetch(article.url);
        if (response.ok) {
          const html = await response.text();
          const enhancedArticle = ContentExtractor.enhanceArticle(
            article,
            html,
          );
          enhanced.push(enhancedArticle);
        } else {
          enhanced.push(article);
        }
      } catch {
        enhanced.push(article);
      }
    }

    return enhanced;
  }

  /**
   * Gets all articles.
   */
  getArticles(): NewsArticle[] {
    return Array.from(this.articles.values());
  }

  /**
   * Gets all security articles.
   */
  getSecurityArticles(): SecurityArticle[] {
    return Array.from(this.securityArticles.values());
  }

  /**
   * Gets security articles by severity.
   */
  getSecurityArticlesBySeverity(severity: CVESeverity): SecurityArticle[] {
    return Array.from(this.securityArticles.values()).filter(
      (a) => a.severity === severity,
    );
  }

  /**
   * Gets security articles with active exploits.
   */
  getExploitedVulnerabilities(): SecurityArticle[] {
    return Array.from(this.securityArticles.values()).filter(
      (a) => a.exploitAvailable,
    );
  }

  /**
   * Searches security articles by CVE ID.
   */
  searchByCVE(cveId: string): SecurityArticle[] {
    const normalizedCve = cveId.toUpperCase();
    return Array.from(this.securityArticles.values()).filter((a) =>
      a.cveIds?.includes(normalizedCve),
    );
  }

  /**
   * Gets articles from a specific source.
   */
  getArticlesBySource(sourceId: string): NewsArticle[] {
    return Array.from(this.articles.values()).filter(
      (a) => a.sourceId === sourceId,
    );
  }

  /**
   * Gets articles by category (e.g., 'security', 'vulnerability', 'exploit').
   */
  getArticlesByCategory(category: string): NewsArticle[] {
    return Array.from(this.articles.values()).filter((a) => {
      const source = [...this.getConfig().sources, ...SECURITY_FEED_SOURCES].find(
        (s) => s.id === a.sourceId,
      );
      return source?.category === category;
    });
  }

  /**
   * Gets aggregation status.
   */
  getStatus(): AggregationStatus {
    return {
      ...this.status,
      articlesFetched: this.articles.size,
    };
  }

  /**
   * Gets security-specific status.
   */
  getSecurityStatus(): {
    totalSecurityArticles: number;
    bySeverity: Record<CVESeverity, number>;
    withExploits: number;
    uniqueCVEs: number;
  } {
    const articles = Array.from(this.securityArticles.values());
    const bySeverity: Record<CVESeverity, number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      unknown: 0,
    };

    const allCVEs = new Set<string>();

    for (const article of articles) {
      bySeverity[article.severity || "unknown"]++;
      article.cveIds?.forEach((cve) => allCVEs.add(cve));
    }

    return {
      totalSecurityArticles: articles.length,
      bySeverity,
      withExploits: articles.filter((a) => a.exploitAvailable).length,
      uniqueCVEs: allCVEs.size,
    };
  }

  /**
   * Adds a new source.
   */
  addSource(source: NewsSource): void {
    const config = this.getConfig();
    config.sources.push(source);
    // In practice, this would update the config file
  }

  /**
   * Removes a source.
   */
  removeSource(sourceId: string): void {
    const config = this.getConfig();
    config.sources = config.sources.filter((s) => s.id !== sourceId);
    // Remove articles from this source
    for (const [id, article] of this.articles.entries()) {
      if (article.sourceId === sourceId) {
        this.articles.delete(id);
        this.securityArticles.delete(id);
      }
    }
  }

  /**
   * Enables or disables a security feed.
   */
  toggleSecurityFeed(feedId: string, enabled: boolean): boolean {
    const feed = SECURITY_FEED_SOURCES.find((f) => f.id === feedId);
    if (feed) {
      feed.enabled = enabled;
      return true;
    }
    return false;
  }
}
