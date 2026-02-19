import fs from "node:fs/promises";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory-summarizer");

export interface MemorySummarizerConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface MemoryFileSummary {
  originalPath: string;
  originalSize: number;
  summary: string;
  keyPoints: string[];
  entities: string[];
  generatedAt: number;
}

export interface SummarizationResult {
  success: boolean;
  summary?: MemoryFileSummary;
  error?: string;
  bytesSaved?: number;
}

const SUMMARY_PROMPT = `You are an expert at summarizing memory files. Your task is to create concise summaries that preserve:

1. Key decisions and their rationale
2. Important facts and technical details
3. Action items and TODOs
4. Critical context for future reference
5. Important entities (people, projects, concepts)

Format your response as:
## Summary
[A 2-3 paragraph summary capturing the essence]

## Key Points
- [Bullet point 1]
- [Bullet point 2]

## Entities
- [List important entities mentioned]

Be extremely concise. The summary should be 20-30% of the original length while preserving all critical information.`;

export class MemoryFileSummarizer {
  constructor(private config: MemorySummarizerConfig) {}

  async summarizeFile(filePath: string): Promise<SummarizationResult> {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const originalSize = Buffer.byteLength(content, "utf-8");

      if (originalSize < 1000) {
        return {
          success: false,
          error: "File too small to summarize (<1KB)",
        };
      }

      const summaryContent = await this.callLLM(content);

      const summary: MemoryFileSummary = {
        originalPath: filePath,
        originalSize,
        summary: summaryContent.summary,
        keyPoints: summaryContent.keyPoints,
        entities: summaryContent.entities,
        generatedAt: Date.now(),
      };

      const summaryText = this.formatSummaryAsMarkdown(summary);
      const bytesSaved = originalSize - Buffer.byteLength(summaryText, "utf-8");

      return {
        success: true,
        summary: { ...summary, originalSize },
        bytesSaved: Math.max(0, bytesSaved),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Failed to summarize ${filePath}: ${message}`);
      return {
        success: false,
        error: message,
      };
    }
  }

  async summarizeAndReplace(
    filePath: string,
    options: { backup?: boolean } = {},
  ): Promise<SummarizationResult> {
    const result = await this.summarizeFile(filePath);

    if (!result.success || !result.summary) {
      return result;
    }

    try {
      if (options.backup) {
        await fs.copyFile(filePath, `${filePath}.bak`);
      }

      const summaryText = this.formatSummaryAsMarkdown(result.summary);
      await fs.writeFile(filePath, summaryText, "utf-8");

      log.info(`Summarized ${filePath}: saved ${result.bytesSaved} bytes`);

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Failed to write summary: ${message}`,
      };
    }
  }

  private async callLLM(content: string): Promise<{
    summary: string;
    keyPoints: string[];
    entities: string[];
  }> {
    const truncatedContent = content.slice(0, 15000);

    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          { role: "system", content: SUMMARY_PROMPT },
          { role: "user", content: truncatedContent },
        ],
        temperature: 0.3,
        max_tokens: 2000,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`LLM API error: ${response.status} - ${text}`);
    }

    const data = await response.json();
    const responseContent = data.choices?.[0]?.message?.content || "";

    return this.parseSummaryResponse(responseContent);
  }

  private parseSummaryResponse(content: string): {
    summary: string;
    keyPoints: string[];
    entities: string[];
  } {
    const summaryMatch = content.match(/## Summary\s*([\s\S]*?)(?=## |$)/i);
    const keyPointsMatch = content.match(/## Key Points\s*([\s\S]*?)(?=## |$)/i);
    const entitiesMatch = content.match(/## Entities\s*([\s\S]*?)(?=## |$)/i);

    const summary = summaryMatch?.[1]?.trim() || content;
    const keyPoints = this.parseBulletPoints(keyPointsMatch?.[1] || "");
    const entities = this.parseBulletPoints(entitiesMatch?.[1] || "");

    return { summary, keyPoints, entities };
  }

  private parseBulletPoints(text: string): string[] {
    return text
      .split("\n")
      .map((line) => line.replace(/^[-*]\s*/, "").trim())
      .filter((line) => line.length > 0);
  }

  private formatSummaryAsMarkdown(summary: MemoryFileSummary): string {
    const lines: string[] = [
      `<!-- Auto-summarized at ${new Date(summary.generatedAt).toISOString()} -->`,
      `<!-- Original size: ${summary.originalSize} bytes -->`,
      "",
      "## Summary",
      "",
      summary.summary,
      "",
    ];

    if (summary.keyPoints.length > 0) {
      lines.push("## Key Points", "");
      for (const point of summary.keyPoints) {
        lines.push(`- ${point}`);
      }
      lines.push("");
    }

    if (summary.entities.length > 0) {
      lines.push("## Entities", "");
      for (const entity of summary.entities) {
        lines.push(`- ${entity}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }
}

export async function checkMemoryFileSizeThreshold(
  filePath: string,
  thresholdBytes: number,
): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.size > thresholdBytes;
  } catch {
    return false;
  }
}

export async function findLargeMemoryFiles(params: {
  workspaceDir: string;
  thresholdBytes: number;
  maxFiles?: number;
}): Promise<string[]> {
  const { workspaceDir, thresholdBytes, maxFiles = 10 } = params;
  const memoryDir = path.join(workspaceDir, "memory");

  const largeFiles: string[] = [];

  try {
    const entries = await fs.readdir(memoryDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) {
        continue;
      }

      const filePath = path.join(memoryDir, entry.name);
      const stat = await fs.stat(filePath);

      if (stat.size > thresholdBytes) {
        largeFiles.push(filePath);
      }

      if (largeFiles.length >= maxFiles) {
        break;
      }
    }
  } catch {
    // Memory directory doesn't exist
  }

  return largeFiles;
}
