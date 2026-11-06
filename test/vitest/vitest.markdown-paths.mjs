// Pure Markdown tests use the Node-only owner; stateful tests retain their existing lanes.
export const markdownTestFiles = [
  "packages/markdown-core/src/chunk-text.test.ts",
  "packages/markdown-core/src/code-spans.test.ts",
  "packages/markdown-core/src/construct-fallbacks.test.ts",
  "packages/markdown-core/src/fences.test.ts",
  "packages/markdown-core/src/frontmatter.test.ts",
  "packages/markdown-core/src/html-tags.test.ts",
  "packages/markdown-core/src/image-spans.test.ts",
  "packages/markdown-core/src/ir.test.ts",
  "packages/markdown-core/src/markdown-code-regions.test.ts",
  "packages/markdown-core/src/render-aware-chunking.test.ts",
];
