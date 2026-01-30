/**
 * Semantic chunking for markdown memory files.
 * Respects heading boundaries, code blocks, and paragraph structure.
 */

export interface SemanticChunkOptions {
  /** Maximum tokens per chunk (default: 600) */
  maxTokens: number;
  /** Minimum tokens per chunk, smaller chunks are merged (default: 50) */
  minTokens: number;
  /** Include heading context in each chunk (default: true) */
  includeHeadingContext: boolean;
}

export interface Section {
  heading: string;
  level: number;
  content: string;
  startLine: number;
  endLine: number;
  contentType: "prose" | "list" | "code" | "table" | "mixed";
}

export interface SemanticChunk {
  text: string;
  startLine: number;
  endLine: number;
  headingBreadcrumb: string[];
  contentType: Section["contentType"];
  isComplete: boolean;
}

const DEFAULT_OPTIONS: SemanticChunkOptions = {
  maxTokens: 600,
  minTokens: 50,
  includeHeadingContext: true,
};

/**
 * Estimate token count from text (rough: 1 token ≈ 4 chars).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Detect the primary content type of a section.
 */
function detectContentType(content: string): Section["contentType"] {
  const hasCode = /```[\s\S]*?```/.test(content);
  const hasTable = /^\|.+\|$/m.test(content);
  const hasList = /^(\s*[-*+]|\s*\d+\.)\s+/m.test(content);

  if (hasCode && (hasTable || hasList)) return "mixed";
  if (hasCode) return "code";
  if (hasTable) return "table";
  if (hasList) return "list";
  return "prose";
}

/**
 * Parse markdown into sections based on headings.
 */
export function parseMarkdownSections(markdown: string): Section[] {
  const lines = markdown.split("\n");
  const sections: Section[] = [];
  let currentSection: Section | null = null;
  let contentLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

    if (headingMatch) {
      // Save previous section
      if (currentSection) {
        currentSection.content = contentLines.join("\n").trim();
        currentSection.endLine = i;
        currentSection.contentType = detectContentType(currentSection.content);
        if (currentSection.content || currentSection.heading) {
          sections.push(currentSection);
        }
      }

      // Start new section
      currentSection = {
        heading: headingMatch[2] ?? "",
        level: headingMatch[1]?.length ?? 1,
        content: "",
        startLine: i + 1,
        endLine: i + 1,
        contentType: "prose",
      };
      contentLines = [];
    } else if (currentSection) {
      contentLines.push(line);
    } else {
      // Content before any heading - create implicit section
      if (line.trim()) {
        currentSection = {
          heading: "",
          level: 0,
          content: "",
          startLine: i + 1,
          endLine: i + 1,
          contentType: "prose",
        };
        contentLines = [line];
      }
    }
  }

  // Don't forget last section
  if (currentSection) {
    currentSection.content = contentLines.join("\n").trim();
    currentSection.endLine = lines.length;
    currentSection.contentType = detectContentType(currentSection.content);
    if (currentSection.content || currentSection.heading) {
      sections.push(currentSection);
    }
  }

  return sections;
}

/**
 * Split section content at paragraph boundaries.
 */
function splitAtParagraphs(
  section: Section,
  options: SemanticChunkOptions,
  headingStack: string[],
): SemanticChunk[] {
  const paragraphs = section.content.split(/\n\n+/).filter((p) => p.trim());
  if (paragraphs.length === 0) return [];

  const chunks: SemanticChunk[] = [];
  let buffer: string[] = [];
  let bufferTokens = 0;

  const headingPrefix =
    options.includeHeadingContext && section.heading
      ? `${"#".repeat(section.level)} ${section.heading}\n\n`
      : "";
  const headingTokens = estimateTokens(headingPrefix);

  const flushBuffer = (isLast: boolean) => {
    if (buffer.length === 0) return;
    const content = headingPrefix + buffer.join("\n\n");
    chunks.push({
      text: content,
      startLine: section.startLine,
      endLine: section.endLine,
      headingBreadcrumb: [...headingStack],
      contentType: section.contentType,
      isComplete: isLast && chunks.length === 0,
    });
    buffer = [];
    bufferTokens = headingTokens;
  };

  bufferTokens = headingTokens;

  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i] ?? "";
    const paraTokens = estimateTokens(para);
    const isLast = i === paragraphs.length - 1;

    if (bufferTokens + paraTokens > options.maxTokens && buffer.length > 0) {
      flushBuffer(false);
    }

    buffer.push(para);
    bufferTokens += paraTokens;
  }

  flushBuffer(true);
  return chunks;
}

/**
 * Chunk sections respecting semantic boundaries.
 */
export function chunkSections(
  sections: Section[],
  options: SemanticChunkOptions,
): SemanticChunk[] {
  const chunks: SemanticChunk[] = [];
  const headingStack: string[] = [];

  for (const section of sections) {
    // Maintain heading breadcrumb
    if (section.level > 0) {
      headingStack.length = section.level - 1;
      headingStack.push(section.heading);
    }

    const headingPrefix =
      options.includeHeadingContext && section.heading
        ? `${"#".repeat(section.level)} ${section.heading}\n\n`
        : "";

    const fullContent = headingPrefix + section.content;
    const tokenCount = estimateTokens(fullContent);

    if (tokenCount <= options.maxTokens) {
      // Section fits in one chunk
      if (tokenCount >= options.minTokens || section.heading) {
        chunks.push({
          text: fullContent,
          startLine: section.startLine,
          endLine: section.endLine,
          headingBreadcrumb: [...headingStack],
          contentType: section.contentType,
          isComplete: true,
        });
      }
    } else {
      // Need to split at paragraph boundaries
      const subChunks = splitAtParagraphs(section, options, headingStack);
      chunks.push(...subChunks);
    }
  }

  // Filter out tiny chunks (but keep ones with headings)
  return chunks.filter(
    (c) =>
      estimateTokens(c.text) >= options.minTokens ||
      c.headingBreadcrumb.length > 0,
  );
}

/**
 * Main entry point - chunk markdown semantically.
 */
export function semanticChunk(
  markdown: string,
  options?: Partial<SemanticChunkOptions>,
): SemanticChunk[] {
  const opts: SemanticChunkOptions = { ...DEFAULT_OPTIONS, ...options };
  const sections = parseMarkdownSections(markdown);
  return chunkSections(sections, opts);
}
