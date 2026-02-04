import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chunkMarkdown,
  chunkMarkdownLegacy,
  chunkMarkdownSemantic,
  listMemoryFiles,
  normalizeExtraMemoryPaths,
  parseMarkdownBlocks,
} from "./internal.js";

describe("normalizeExtraMemoryPaths", () => {
  it("trims, resolves, and dedupes paths", () => {
    const workspaceDir = path.join(os.tmpdir(), "memory-test-workspace");
    const absPath = path.resolve(path.sep, "shared-notes");
    const result = normalizeExtraMemoryPaths(workspaceDir, [
      " notes ",
      "./notes",
      absPath,
      absPath,
      "",
    ]);
    expect(result).toEqual([path.resolve(workspaceDir, "notes"), absPath]);
  });
});

describe("listMemoryFiles", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("includes files from additional paths (directory)", async () => {
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Default memory");
    const extraDir = path.join(tmpDir, "extra-notes");
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "note1.md"), "# Note 1");
    await fs.writeFile(path.join(extraDir, "note2.md"), "# Note 2");
    await fs.writeFile(path.join(extraDir, "ignore.txt"), "Not a markdown file");

    const files = await listMemoryFiles(tmpDir, [extraDir]);
    expect(files).toHaveLength(3);
    expect(files.some((file) => file.endsWith("MEMORY.md"))).toBe(true);
    expect(files.some((file) => file.endsWith("note1.md"))).toBe(true);
    expect(files.some((file) => file.endsWith("note2.md"))).toBe(true);
    expect(files.some((file) => file.endsWith("ignore.txt"))).toBe(false);
  });

  it("includes files from additional paths (single file)", async () => {
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Default memory");
    const singleFile = path.join(tmpDir, "standalone.md");
    await fs.writeFile(singleFile, "# Standalone");

    const files = await listMemoryFiles(tmpDir, [singleFile]);
    expect(files).toHaveLength(2);
    expect(files.some((file) => file.endsWith("standalone.md"))).toBe(true);
  });

  it("handles relative paths in additional paths", async () => {
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Default memory");
    const extraDir = path.join(tmpDir, "subdir");
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "nested.md"), "# Nested");

    const files = await listMemoryFiles(tmpDir, ["subdir"]);
    expect(files).toHaveLength(2);
    expect(files.some((file) => file.endsWith("nested.md"))).toBe(true);
  });

  it("ignores non-existent additional paths", async () => {
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Default memory");

    const files = await listMemoryFiles(tmpDir, ["/does/not/exist"]);
    expect(files).toHaveLength(1);
  });

  it("ignores symlinked files and directories", async () => {
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Default memory");
    const extraDir = path.join(tmpDir, "extra");
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "note.md"), "# Note");

    const targetFile = path.join(tmpDir, "target.md");
    await fs.writeFile(targetFile, "# Target");
    const linkFile = path.join(extraDir, "linked.md");

    const targetDir = path.join(tmpDir, "target-dir");
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(targetDir, "nested.md"), "# Nested");
    const linkDir = path.join(tmpDir, "linked-dir");

    let symlinksOk = true;
    try {
      await fs.symlink(targetFile, linkFile, "file");
      await fs.symlink(targetDir, linkDir, "dir");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        symlinksOk = false;
      } else {
        throw err;
      }
    }

    const files = await listMemoryFiles(tmpDir, [extraDir, linkDir]);
    expect(files.some((file) => file.endsWith("note.md"))).toBe(true);
    if (symlinksOk) {
      expect(files.some((file) => file.endsWith("linked.md"))).toBe(false);
      expect(files.some((file) => file.endsWith("nested.md"))).toBe(false);
    }
  });
});

describe("chunkMarkdown", () => {
  it("splits overly long lines into max-sized chunks (legacy mode)", () => {
    const chunkTokens = 400;
    const maxChars = chunkTokens * 4;
    const content = "a".repeat(maxChars * 3 + 25);
    // Use legacy mode for this test as it tests character-based splitting
    const chunks = chunkMarkdown(content, { tokens: chunkTokens, overlap: 0, semantic: false });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(maxChars);
    }
  });

  it("uses semantic chunking by default", () => {
    const content = `# Title

Some paragraph.

## Section

More content.`;
    const chunks = chunkMarkdown(content, { tokens: 400, overlap: 0 });
    // Should include header context
    expect(chunks.some((c) => c.text.includes("# Title"))).toBe(true);
  });

  it("uses legacy chunking when semantic is false", () => {
    const content = `# Title

Some paragraph.`;
    const legacyChunks = chunkMarkdown(content, { tokens: 400, overlap: 0, semantic: false });
    const semanticChunks = chunkMarkdown(content, { tokens: 400, overlap: 0, semantic: true });
    // Legacy should not add header context prefix to paragraphs
    expect(legacyChunks).not.toEqual(semanticChunks);
  });
});

describe("parseMarkdownBlocks", () => {
  it("parses headers correctly", () => {
    const content = `# H1
## H2
### H3`;
    const blocks = parseMarkdownBlocks(content);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]?.type).toBe("header");
    expect(blocks[0]?.headerLevel).toBe(1);
    expect(blocks[0]?.headerText).toBe("H1");
    expect(blocks[1]?.headerLevel).toBe(2);
    expect(blocks[2]?.headerLevel).toBe(3);
  });

  it("parses code blocks and keeps them intact", () => {
    const content = `Some text

\`\`\`javascript
function foo() {
  return 42;
}
\`\`\`

More text`;
    const blocks = parseMarkdownBlocks(content);
    const codeBlock = blocks.find((b) => b.type === "code");
    expect(codeBlock).toBeDefined();
    expect(codeBlock?.content).toContain("function foo()");
    expect(codeBlock?.content).toContain("return 42");
  });

  it("parses unordered lists", () => {
    const content = `- Item 1
- Item 2
- Item 3`;
    const blocks = parseMarkdownBlocks(content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("list");
    expect(blocks[0]?.content).toContain("Item 1");
    expect(blocks[0]?.content).toContain("Item 3");
  });

  it("parses ordered lists", () => {
    const content = `1. First
2. Second
3. Third`;
    const blocks = parseMarkdownBlocks(content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("list");
  });

  it("parses paragraphs", () => {
    const content = `This is a paragraph
that spans multiple lines.

This is another paragraph.`;
    const blocks = parseMarkdownBlocks(content);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.type).toBe("paragraph");
    expect(blocks[1]?.type).toBe("paragraph");
  });

  it("handles mixed content", () => {
    const content = `# Title

Introduction paragraph.

## Code Example

\`\`\`python
print("hello")
\`\`\`

## List of Items

- Item A
- Item B

Conclusion.`;
    const blocks = parseMarkdownBlocks(content);
    const types = blocks.map((b) => b.type);
    expect(types).toContain("header");
    expect(types).toContain("paragraph");
    expect(types).toContain("code");
    expect(types).toContain("list");
  });
});

describe("chunkMarkdownSemantic", () => {
  it("preserves code blocks intact even when large", () => {
    const longCode = "x".repeat(2000);
    const content = `# Setup

\`\`\`
${longCode}
\`\`\``;
    const chunks = chunkMarkdownSemantic(content, { tokens: 100, overlap: 0 });
    // Code block should be in a single chunk despite being large
    const codeChunk = chunks.find((c) => c.text.includes(longCode));
    expect(codeChunk).toBeDefined();
  });

  it("adds header context to chunks", () => {
    const content = `# Project

## API

### Authentication

Use OAuth2 for authentication.

### Endpoints

GET /users returns all users.`;
    const chunks = chunkMarkdownSemantic(content, { tokens: 400, overlap: 0 });
    // Chunks should include header context
    const authChunk = chunks.find((c) => c.text.includes("OAuth2"));
    expect(authChunk?.text).toContain("# Project");
    expect(authChunk?.text).toContain("## API");
    expect(authChunk?.text).toContain("### Authentication");
  });

  it("updates header context when moving to sibling sections", () => {
    const content = `# Root

## Section A

Content A.

## Section B

Content B.`;
    const chunks = chunkMarkdownSemantic(content, { tokens: 400, overlap: 0 });
    const chunkB = chunks.find((c) => c.text.includes("Content B"));
    // Should have Section B context, not Section A
    expect(chunkB?.text).toContain("## Section B");
    expect(chunkB?.text).not.toContain("## Section A");
  });

  it("keeps small blocks together", () => {
    const content = `# Doc

Small para 1.

Small para 2.

Small para 3.`;
    const chunks = chunkMarkdownSemantic(content, { tokens: 400, overlap: 0 });
    // Small paragraphs should be merged into fewer chunks
    expect(chunks.length).toBeLessThanOrEqual(2);
  });

  it("splits large paragraphs by sentences", () => {
    const longPara = Array(20).fill("This is a sentence.").join(" ");
    const content = `# Title

${longPara}`;
    const chunks = chunkMarkdownSemantic(content, { tokens: 50, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should have header context
    for (const chunk of chunks) {
      expect(chunk.text).toContain("# Title");
    }
  });

  it("handles empty content", () => {
    const chunks = chunkMarkdownSemantic("", { tokens: 400, overlap: 0 });
    expect(chunks).toHaveLength(0);
  });

  it("handles content with only headers", () => {
    const content = `# H1
## H2
### H3`;
    const chunks = chunkMarkdownSemantic(content, { tokens: 400, overlap: 0 });
    // Headers alone don't create chunks
    expect(chunks).toHaveLength(0);
  });

  it("preserves line numbers accurately", () => {
    const content = `# Title

Paragraph on line 3.`;
    const chunks = chunkMarkdownSemantic(content, { tokens: 400, overlap: 0 });
    expect(chunks[0]?.startLine).toBe(3);
    expect(chunks[0]?.endLine).toBe(3);
  });
});

describe("chunkMarkdownLegacy", () => {
  it("splits by character count", () => {
    const chunkTokens = 50;
    const maxChars = chunkTokens * 4;
    const content = "word ".repeat(100);
    const chunks = chunkMarkdownLegacy(content, { tokens: chunkTokens, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(maxChars);
    }
  });

  it("handles overlap", () => {
    const content = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5";
    const chunksNoOverlap = chunkMarkdownLegacy(content, { tokens: 10, overlap: 0 });
    const chunksWithOverlap = chunkMarkdownLegacy(content, { tokens: 10, overlap: 5 });
    // With overlap, there may be more or equal chunks due to repeated content
    expect(chunksNoOverlap.length).toBeLessThanOrEqual(chunksWithOverlap.length);
  });
});
