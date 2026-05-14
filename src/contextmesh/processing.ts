import { estimateTokens } from "./chunking.js";
import type { ContextMeshTaskResult, ContextMeshTaskType } from "./types.js";

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

function topWords(text: string, count: number): string[] {
  const stop = new Set(["the", "and", "for", "that", "with", "this", "from", "into", "about"]);
  const scores = new Map<string, number>();
  for (const word of text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? []) {
    if (stop.has(word)) {
      continue;
    }
    scores.set(word, (scores.get(word) ?? 0) + 1);
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, count)
    .map(([word]) => word);
}

function simpleSummary(text: string, maxSentences = 3): string {
  const parts = sentences(text);
  return parts.slice(0, maxSentences).join(" ");
}

function simpleEntities(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/g) ?? []) {
    found.add(match);
    if (found.size >= 12) {
      break;
    }
  }
  return [...found];
}

function simpleRelevance(text: string, query: string): number {
  const haystack = text.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return 0;
  }
  const hits = terms.filter((term) => haystack.includes(term)).length;
  return hits / terms.length;
}

export function processTask(params: {
  taskType: ContextMeshTaskType;
  text?: string;
  query?: string;
  chunks?: string[];
}): ContextMeshTaskResult {
  const text = params.text ?? "";
  switch (params.taskType) {
    case "token_count":
      return { tokenCount: estimateTokens(text) };
    case "summarize_chunk":
      return { summary: simpleSummary(text) };
    case "map_reduce_summary":
      return { summary: simpleSummary((params.chunks ?? []).join(" "), 5) };
    case "extract_keywords":
      return { keywords: topWords(text, 12) };
    case "extract_entities":
      return { entities: simpleEntities(text) };
    case "relevance_score":
      return { relevance: simpleRelevance(text, params.query ?? "") };
    case "semantic_search":
      return {
        matches: (params.chunks ?? []).map((chunk, index) => ({
          chunkId: `chunk-${index + 1}`,
          score: simpleRelevance(chunk, params.query ?? ""),
          excerpt: chunk.slice(0, 180),
        })),
      };
    case "context_compression":
      return { compressed: simpleSummary(text, 4) };
    case "question_answer_over_chunks":
      return { answer: simpleSummary(text, 2) };
    case "duplicate_chunk_detection":
      return { duplicates: [] };
    case "chunk_text":
      return { tokenCount: estimateTokens(text) };
  }
}
