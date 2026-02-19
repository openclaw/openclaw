import { Readability } from "@mozilla/readability";
import { JSDOM } from "linkedom";
import type { NewsArticle, SecurityArticle } from "./types.js";

/**
 * Patterns that may indicate prompt injection attempts in content.
 * Used for RAG poisoning detection per LLM security features plan.
 */
const INJECTION_PATTERNS = [
  /ignore\s+(previous|all|above)\s+instructions?/i,
  /disregard\s+(previous|all|above)\s+instructions?/i,
  /new\s+instructions?:/i,
  /system\s*prompt:/i,
  /\[INST\]/i,
  /<<SYS>>/i,
  /\{\{.*\}\}/,
  /<\|im_start\|>/i,
  /\u200B/, // zero-width space
  /\u200C/, // zero-width non-joiner
  /\u200D/, // zero-width joiner
  /\uFEFF/, // byte order mark
];

/**
 * Result of content security analysis.
 */
export interface ContentSecurityResult {
  hasSuspiciousPatterns: boolean;
  detectedPatterns: string[];
  riskScore: number; // 0-100
}

/**
 * Extracts readable content from web pages using Readability.
 * Includes security analysis for RAG poisoning detection.
 */
export class ContentExtractor {
  /**
   * Extracts main content from HTML using Readability.
   */
  static extractContent(html: string, url: string): {
    content: string;
    title: string;
    excerpt: string;
    imageUrl?: string;
  } | null {
    try {
      const dom = new JSDOM(html, { url });
      const reader = new Readability(dom.window.document);
      const article = reader.parse();

      if (!article) {
        return null;
      }

      return {
        content: article.textContent || article.content || "",
        title: article.title || "",
        excerpt: article.excerpt || "",
        // Note: Readability doesn't extract imageUrl, would need separate extraction
        imageUrl: undefined,
      };
    } catch (error) {
      console.error(`Failed to extract content from ${url}:`, error);
      return null;
    }
  }

  /**
   * Analyzes content for potential prompt injection patterns.
   * Part of RAG poisoning detection for LLM security.
   */
  static analyzeContentSecurity(content: string): ContentSecurityResult {
    const detectedPatterns: string[] = [];

    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(content)) {
        detectedPatterns.push(pattern.source);
      }
    }

    // Calculate risk score based on number and type of patterns
    const riskScore = Math.min(100, detectedPatterns.length * 25);

    return {
      hasSuspiciousPatterns: detectedPatterns.length > 0,
      detectedPatterns,
      riskScore,
    };
  }

  /**
   * Enhances an article with extracted content.
   */
  static enhanceArticle(
    article: NewsArticle,
    html: string,
  ): NewsArticle & { extractedContent?: string; securityAnalysis?: ContentSecurityResult } {
    const extracted = this.extractContent(html, article.url);
    if (extracted) {
      const securityAnalysis = this.analyzeContentSecurity(extracted.content);
      return {
        ...article,
        content: extracted.content,
        description: extracted.excerpt || article.description,
        imageUrl: extracted.imageUrl || article.imageUrl,
        extractedContent: extracted.content,
        securityAnalysis,
      };
    }
    return article;
  }

  /**
   * Enhances a security article with extracted content and security analysis.
   */
  static enhanceSecurityArticle(
    article: SecurityArticle,
    html: string,
  ): SecurityArticle & { extractedContent?: string; securityAnalysis?: ContentSecurityResult } {
    const extracted = this.extractContent(html, article.url);
    if (extracted) {
      const securityAnalysis = this.analyzeContentSecurity(extracted.content);
      return {
        ...article,
        content: extracted.content,
        description: extracted.excerpt || article.description,
        imageUrl: extracted.imageUrl || article.imageUrl,
        extractedContent: extracted.content,
        securityAnalysis,
      };
    }
    return article;
  }
}
