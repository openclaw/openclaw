/**
 * Context Archive - Context archiving module
 *
 * Provides LLM with proactive context compression and archiving capability
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

// Archive configuration interface
export interface ContextArchiveConfig {
  enabled: boolean;
  archiveDir: string;
  retentionDays: number;
  maxArchiveSize: number;
}

// Default configuration
const DEFAULT_CONFIG: ContextArchiveConfig = {
  enabled: true,
  archiveDir: path.join(homedir(), ".openclaw", "archives"),
  retentionDays: 30,
  maxArchiveSize: 100,
};

// Archive metadata
export interface ArchiveMetadata {
  session_id: string;
  created_at: string;
  topic: string;
  message_count: number;
  tokens_saved: number;
  importance: "high" | "medium" | "low";
}

// Compression request
export interface CompressContextRequest {
  topic: string;
  summary: string;
  key_decisions?: string[];
  message_range: {
    start: number;
    end: number;
  };
  importance?: "high" | "medium" | "low";
}

// Compression response
export interface CompressContextResponse {
  archive_id: string;
  archive_path: string;
  tokens_saved: number;
  message: string;
}

// Archive item
export interface ArchiveItem {
  id: string;
  path: string;
  topic: string;
  created_at: string;
  tokens_saved: number;
}

/**
 * ContextArchive class - Manage context archiving
 */
export class ContextArchive {
  private config: ContextArchiveConfig;
  private sessionId: string;

  constructor(sessionId: string, config?: Partial<ContextArchiveConfig>) {
    this.sessionId = sessionId;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Ensure archive directory exists for a specific date
   */
  private ensureArchiveDirectory(date: string): string {
    const archivePath = path.join(this.config.archiveDir, date);

    if (!fs.existsSync(archivePath)) {
      fs.mkdirSync(archivePath, { recursive: true });
    }
    return archivePath;
  }

  /**
   * Estimate token count
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Generate archive ID
   */
  private generateArchiveId(): string {
    return `${this.sessionId.slice(0, 8)}_${Date.now()}`;
  }

  /**
   * Generate archive filename
   */
  private generateArchiveFilename(topic: string, archiveId: string): string {
    const sanitizedTopic = topic
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .slice(0, 30);
    return `archive_${archiveId}_${sanitizedTopic}.md`;
  }

  /**
   * Validate that a path is inside the archive directory
   * Uses realpath to prevent symlink bypass attacks
   */
  private validateArchivePath(requestedPath: string): string {
    // Ensure archive directory exists and get its real path
    if (!fs.existsSync(this.config.archiveDir)) {
      throw new Error("Archive directory does not exist");
    }
    const archiveRoot = fs.realpathSync(this.config.archiveDir);

    // Get real path of requested file (will throw if file doesn't exist)
    const resolved = fs.realpathSync(requestedPath);

    if (!resolved.startsWith(archiveRoot + path.sep)) {
      throw new Error("Archive path is outside the allowed archive directory");
    }

    return resolved;
  }

  /**
   * Compress and archive context
   */
  async archive(request: CompressContextRequest): Promise<CompressContextResponse> {
    if (!this.config.enabled) {
      return {
        archive_id: "",
        archive_path: "",
        tokens_saved: 0,
        message: "Context archive is disabled",
      };
    }

    const { topic, summary, key_decisions = [], message_range, importance = "medium" } = request;

    const archiveId = this.generateArchiveId();
    const tokensSaved = this.estimateTokens(summary) + key_decisions.length * 50;

    const metadata: ArchiveMetadata = {
      session_id: this.sessionId,
      created_at: new Date().toISOString(),
      topic,
      message_count: message_range.end - message_range.start + 1,
      tokens_saved: tokensSaved,
      importance,
    };

    const archiveContent = this.formatArchiveContent(metadata, summary, key_decisions);

    // Ensure directory exists for current day (handles midnight crossing)
    const today = new Date().toISOString().split("T")[0];
    this.ensureArchiveDirectory(today);

    const filename = this.generateArchiveFilename(topic, archiveId);
    const archivePath = path.join(this.config.archiveDir, today, filename);

    fs.writeFileSync(archivePath, archiveContent, "utf-8");
    await this.updateIndex(metadata, archivePath);

    return {
      archive_id: archiveId,
      archive_path: archivePath,
      tokens_saved: tokensSaved,
      message: `Archived ${metadata.message_count} messages. Saved ~${tokensSaved} tokens.`,
    };
  }

  /**
   * Format archive content
   */
  private formatArchiveContent(
    metadata: ArchiveMetadata,
    summary: string,
    keyDecisions: string[],
  ): string {
    const decisionsSection =
      keyDecisions.length > 0
        ? `\n## Key Decisions\n\n${keyDecisions.map((d, i) => `${i + 1}. ${d}`).join("\n")}\n`
        : "";

    return `---
session_id: ${metadata.session_id}
created_at: ${metadata.created_at}
topic: ${metadata.topic}
message_count: ${metadata.message_count}
tokens_saved: ${metadata.tokens_saved}
importance: ${metadata.importance}
---

# ${metadata.topic}

## Summary

${summary}
${decisionsSection}---
*Generated by auto-context-archive*
*Retention: ${this.config.retentionDays} days*
`;
  }

  /**
   * Update archive index
   */
  private async updateIndex(metadata: ArchiveMetadata, archivePath: string): Promise<void> {
    const indexPath = path.join(this.config.archiveDir, "index.md");
    const relativePath = path.relative(this.config.archiveDir, archivePath);
    const indexEntry = `- [${metadata.topic}](${relativePath}) - ${metadata.created_at.slice(0, 10)} (${metadata.tokens_saved} tokens)\n`;

    if (fs.existsSync(indexPath)) {
      fs.appendFileSync(indexPath, indexEntry, "utf-8");
    } else {
      const header = `# OpenClaw Archive Index\n\nAuto-generated archive index.\n\n## Archives\n\n`;
      fs.writeFileSync(indexPath, header + indexEntry, "utf-8");
    }
  }

  /**
   * List archives
   */
  async list(options?: {
    date?: string;
    topic_keyword?: string;
    limit?: number;
  }): Promise<{ archives: ArchiveItem[]; total_count: number }> {
    const { date, topic_keyword, limit = 10 } = options || {};
    const archives: ArchiveItem[] = [];

    // If no date specified, search across all date directories
    const searchDirs: string[] = [];
    if (date) {
      searchDirs.push(path.join(this.config.archiveDir, date));
    } else if (fs.existsSync(this.config.archiveDir)) {
      const entries = fs.readdirSync(this.config.archiveDir);
      for (const entry of entries) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(entry)) {
          searchDirs.push(path.join(this.config.archiveDir, entry));
        }
      }
    }

    for (const searchDir of searchDirs) {
      if (!fs.existsSync(searchDir)) continue;

      const files = fs.readdirSync(searchDir).filter((f) => f.endsWith(".md"));

      for (const file of files) {
        const filePath = path.join(searchDir, file);
        const content = fs.readFileSync(filePath, "utf-8");

        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (frontmatterMatch) {
          const frontmatter = frontmatterMatch[1];
          const topicMatch = frontmatter.match(/topic:\s*(.+)/);
          const createdAtMatch = frontmatter.match(/created_at:\s*(.+)/);
          const tokensMatch = frontmatter.match(/tokens_saved:\s*(\d+)/);
          const idMatch = file.match(/archive_([^_]+)_/);

          const sessionIdMatch = frontmatter.match(/session_id:\s*(.+)/);
          const topic = topicMatch ? topicMatch[1].trim() : "Unknown";
          const createdAt = createdAtMatch ? createdAtMatch[1].trim() : "";
          const tokensSaved = tokensMatch ? parseInt(tokensMatch[1], 10) : 0;
          const archiveSessionId = sessionIdMatch ? sessionIdMatch[1].trim() : "";
          const id = idMatch ? idMatch[1] : file;

          // Filter by session ID for data isolation
          if (archiveSessionId !== this.sessionId) {
            continue;
          }

          if (topic_keyword && !topic.toLowerCase().includes(topic_keyword.toLowerCase())) {
            continue;
          }

          archives.push({
            id,
            path: filePath,
            topic,
            created_at: createdAt,
            tokens_saved: tokensSaved,
          });
        }
      }
    }

    // Sort by date descending, then apply limit
    archives.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const totalCount = archives.length;
    const limited = archives.slice(0, limit);

    return { archives: limited, total_count: totalCount };
  }

  /**
   * Recall archive content
   */
  async recall(
    archivePath: string,
    mode: "summary" | "full" | "key_points" = "summary",
  ): Promise<{ content: string; tokens_added: number }> {
    // Validate path is inside archive directory (security fix)
    const validatedPath = this.validateArchivePath(archivePath);

    if (!fs.existsSync(validatedPath)) {
      throw new Error(`Archive not found: ${validatedPath}`);
    }

    const content = fs.readFileSync(validatedPath, "utf-8");

    // Extract sections using stable boundaries
    const summaryMatch = content.match(/## Summary\n\n([\s\S]*?)(?=\n## Key Decisions|\n---)/);
    const decisionsMatch = content.match(/## Key Decisions\n\n([\s\S]*?)(?=\n---)/);

    let recalledContent = "";

    switch (mode) {
      case "summary":
        recalledContent = summaryMatch ? summaryMatch[1].trim() : "";
        break;
      case "key_points":
        recalledContent = decisionsMatch ? decisionsMatch[1].trim() : "";
        break;
      case "full":
        recalledContent = content.replace(/^---\n[\s\S]*?\n---\n/, "");
        break;
    }

    return {
      content: recalledContent,
      tokens_added: this.estimateTokens(recalledContent),
    };
  }

  /**
   * Cleanup expired archives
   */
  async cleanup(): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.config.retentionDays);

    let deletedCount = 0;

    if (!fs.existsSync(this.config.archiveDir)) {
      return 0;
    }

    const dateDirs = fs.readdirSync(this.config.archiveDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));

    for (const dateDir of dateDirs) {
      const dirDate = new Date(dateDir);
      if (dirDate < cutoffDate) {
        const dirPath = path.join(this.config.archiveDir, dateDir);
        fs.rmSync(dirPath, { recursive: true, force: true });
        deletedCount++;
      }
    }

    return deletedCount;
  }
}

// Factory function
export function createContextArchive(
  sessionId: string,
  config?: Partial<ContextArchiveConfig>,
): ContextArchive {
  return new ContextArchive(sessionId, config);
}

export default ContextArchive;