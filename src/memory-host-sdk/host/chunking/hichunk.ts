import { CHARS_PER_TOKEN_ESTIMATE, estimateStringChars } from "../../../utils/cjk-chars.js";
import { buildTextEmbeddingInput } from "../embedding-inputs.js";
import { hashText } from "./hash.js";
import { splitIntoSentences } from "./sentence.js";
import type { MemoryChunk } from "./types.js";
import type { ChunkingStrategy, LlmCompletionFn, ChunkingConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Default configuration constants
// ---------------------------------------------------------------------------

/** Default window size in estimated tokens for each LLM inference round. */
export const DEFAULT_WINDOW_SIZE = 16384;

/** Default max character length per sentence for LLM input (truncated version). */
export const DEFAULT_LINE_MAX_LEN = 100;

/** Default maximum number of hierarchical levels. */
export const DEFAULT_MAX_LEVEL = 10;

/** Default recurrent type (0=no residual, 1=discard last L1 segment, 2=with residual context). */
export const DEFAULT_RECURRENT_TYPE = 1;

// ---------------------------------------------------------------------------
// Level name mapping (matches Python level_dict_en)
// ---------------------------------------------------------------------------

const LEVEL_NAMES: Record<number, string> = {
  0: "Level One",
  1: "Level Two",
  2: "Level Three",
  3: "Level Four",
  4: "Level Five",
  5: "Level Six",
  6: "Level Seven",
  7: "Level Eight",
  8: "Level Nine",
  9: "Level Ten",
};

/** Reverse lookup: level name → 0-based index. */
const LEVEL_NAME_TO_INDEX: Record<string, number> = {};
for (const [k, v] of Object.entries(LEVEL_NAMES)) {
  LEVEL_NAME_TO_INDEX[v] = Number(k);
}

// ---------------------------------------------------------------------------
// LLM prompt
// ---------------------------------------------------------------------------

const HICHUNK_PROMPT =
  "You are an assistant good at reading and formatting documents, and you are also skilled at distinguishing " +
  "the semantic and logical relationships of sentences between document context. The following is a text that " +
  'has already been divided into sentences. Each line is formatted as: "{line number} @ {sentence content}". ' +
  "You need to segment this text based on semantics and format. There are multiple levels of granularity for " +
  "segmentation, the higher level number means the finer granularity of the segmentation. Please ensure that " +
  "each Level One segment is semantically complete after segmentation. A Level One segment may contain " +
  "multiple Level Two segments, and so on. Please incrementally output the starting line numbers of each level " +
  "of segments, and determine the level of the segment, as well as whether the content of the sentence at the " +
  "starting line number can be used as the title of the segment. Finally, output a list format result, " +
  'where each element is in the format of: "{line number}, {segment level}, {be a title?}".' +
  "\n\n>>> Input text:\n";

// ---------------------------------------------------------------------------
// Multi-level chunk point type
// ---------------------------------------------------------------------------

/** globalChunkPoints[levelIndex] = array of 0-based sentence indices. */
type MultiLevelChunkPoints = number[][];

// ---------------------------------------------------------------------------
// Sentence entry type (extended from sentence.ts SentenceEntry)
// ---------------------------------------------------------------------------

type HiSentenceEntry = {
  text: string;
  startLine: number; // 1-indexed original doc line
  endLine: number; // 1-indexed original doc line
  headingLevel: number; // number of leading '#' characters (0 = non-heading)
};

// ---------------------------------------------------------------------------
// Heading marker helpers (matches Python replace_jinhao / count_jinhao)
// ---------------------------------------------------------------------------

/** Regex matching leading `#` markers with optional spaces, e.g. `## `, `# `, `###`. */
const HEADING_PREFIX_RE = /^(\s*#+)\s*/;

/** Count the number of '#' characters at the start of a line. */
export function countHeadingLevel(line: string): number {
  const match = HEADING_PREFIX_RE.exec(line);
  if (!match?.[1]) {
    return 0;
  }
  return (match[1].match(/#/g) ?? []).length;
}

/**
 * Replace the heading `#` prefix of a line.
 * - `replacement === null | undefined` → return line unchanged
 * - `replacement === ""` → strip the heading prefix entirely
 * - `replacement === "# "` → normalize to single `# ` prefix
 * - `replacement === "## "` → replace with given heading prefix
 */
export function replaceHeadingMarkers(
  line: string,
  replacement: string | null | undefined,
): string {
  if (replacement == null) {
    return line;
  }
  const match = HEADING_PREFIX_RE.exec(line);
  if (!match?.[1] || match[1].trim() === "") {
    return line;
  }
  return line.replace(HEADING_PREFIX_RE, replacement);
}

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

/** Returns true if the string contains no CJK characters (treat as English). */
export function isEnglish(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x4e00 && code <= 0x9fa5) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Sentence truncation (matches Python sentence_truncation)
// ---------------------------------------------------------------------------

/**
 * Truncate a sentence by keeping head and tail portions.
 * For English text, the length factor is 10 (characters per "unit");
 * for CJK text, the factor is 1.
 *
 * @param line - The sentence text.
 * @param headLimit - Number of units to keep from the start (default 15).
 * @param tailLimit - Number of units to keep from the end (default 15).
 */
export function truncateSentence(line: string, headLimit = 15, tailLimit = 15): string {
  const totalLimit = headLimit + tailLimit;
  const lenFactor = isEnglish(line) ? 10 : 1;
  const threshold = totalLimit * lenFactor;

  if (threshold > 0 && threshold < line.length) {
    const headChars = headLimit * lenFactor;
    const tailStart = line.length - tailLimit * lenFactor;
    return line.slice(0, headChars) + line.slice(tailStart);
  }
  return line;
}

// ---------------------------------------------------------------------------
// Sentence splitting (HiChunk-specific, wraps existing splitIntoSentences)
// ---------------------------------------------------------------------------

/**
 * Split document into sentences for HiChunk processing.
 *
 * Two arrays are produced:
 * - `inputSentences`: heading markers stripped + truncated (for LLM input)
 * - `originSentences`: heading markers preserved, no truncation (for final output)
 *
 * This mirrors Python's `pre_process` which calls `text2sentence` twice.
 */
function preProcess(
  document: string,
  lineMaxLen: number,
): { inputSentences: HiSentenceEntry[]; originSentences: HiSentenceEntry[] } {
  // Step 1: split into non-empty lines (matches Python pre_process)
  // const rawLines = document
  // 	.split("\n")
  // 	.map((l) => l.trim())
  // 	.filter((l) => l.length > 0);

  // Step 2: split each line into sentences using existing sentence splitter
  // We reconstruct a single string to pass through splitIntoSentences, preserving line tracking.
  // const rejoined = rawLines.join("\n");
  const baseSentences = splitIntoSentences(document);

  // Step 3: build both sentence arrays
  const originSentences: HiSentenceEntry[] = [];
  const inputSentences: HiSentenceEntry[] = [];

  for (const s of baseSentences) {
    const headingLevel = countHeadingLevel(s.text);

    // Origin sentence: heading markers preserved, no truncation
    originSentences.push({
      text: s.text + "\n",
      startLine: s.startLine,
      endLine: s.endLine,
      headingLevel,
    });

    // Input sentence: for LLM input
    // 1. Normalize heading to single "# " for truncation processing
    let inputText = replaceHeadingMarkers(s.text, "# ") ?? s.text;
    // 2. Truncate to lineMaxLen
    inputText = truncateSentence(inputText, lineMaxLen, 0);
    // 3. Restore original heading level
    if (headingLevel > 0) {
      inputText = replaceHeadingMarkers(inputText, "#".repeat(headingLevel) + " ") ?? inputText;
    }
    // 4. Strip heading markers for LLM input (replacement = "")
    inputText = replaceHeadingMarkers(inputText, "") ?? inputText;

    inputSentences.push({
      text: inputText + "\n",
      startLine: s.startLine,
      endLine: s.endLine,
      headingLevel,
    });
  }

  return { inputSentences, originSentences };
}

// ---------------------------------------------------------------------------
// Index format helper (matches Python index_format)
// ---------------------------------------------------------------------------

function indexFormat(idx: number, line: string): string {
  return `${idx} @ ${line}`;
}

// ---------------------------------------------------------------------------
// Token estimation helper (replaces Python's HTTP-based count_length)
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
  return Math.max(1, Math.round(estimateStringChars(text) / CHARS_PER_TOKEN_ESTIMATE));
}

// ---------------------------------------------------------------------------
// Points to clips (matches Python points2clip)
// ---------------------------------------------------------------------------

/**
 * Convert a sorted array of split points into [start, end) intervals.
 * Given points [a, b, c, d] with startIdx=x, endIdx=y:
 * Returns [[x,a], [a,b], [b,c], [c,d], [d,y]]
 */
function pointsToClips(
  points: number[],
  startIdx: number,
  endIdx: number,
): Array<[number, number]> {
  const clips: Array<[number, number]> = [];
  let prev = startIdx;
  for (const p of points) {
    if (p === startIdx || p >= endIdx) {
      continue;
    }
    clips.push([prev, p]);
    prev = p;
  }
  clips.push([prev, endIdx]);
  return clips;
}

// ---------------------------------------------------------------------------
// Parse LLM answer to multi-level chunk points
// ---------------------------------------------------------------------------

/**
 * Parse the LLM answer string into multi-level chunk points.
 * Each line is expected as: "{line_number}, {segment_level}, {is_title}"
 *
 * Returns an array of arrays, one per level, containing 0-based sentence indices.
 * Duplicate or non-monotonic points within a level are removed.
 */
export function parseAnswerChunkingPoints(answer: string, maxLevel: number): MultiLevelChunkPoints {
  const result: MultiLevelChunkPoints = Array.from({ length: maxLevel }, () => []);

  for (const line of answer.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const parts = trimmed.split(",").map((p) => p.trim());
    if (parts.length < 3) {
      continue;
    }

    const point = Number.parseInt(parts[0], 10);
    const levelName = parts[1];

    if (Number.isNaN(point)) {
      continue;
    }

    const levelIdx = LEVEL_NAME_TO_INDEX[levelName];
    if (levelIdx == null || levelIdx >= maxLevel) {
      continue;
    }

    result[levelIdx].push(point);
  }

  // Remove non-monotonic duplicates within each level (keep strictly increasing)
  for (let i = 0; i < result.length; i++) {
    const arr = result[i];
    if (arr.length === 0) {
      continue;
    }
    const filtered = [arr[0]];
    for (let j = 1; j < arr.length; j++) {
      if (arr[j] > filtered[filtered.length - 1]) {
        filtered.push(arr[j]);
      }
    }
    result[i] = filtered;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Check answer points validity (matches Python check_answer_point)
// ---------------------------------------------------------------------------

/**
 * Validate that first-level chunk points are within bounds and strictly increasing.
 */
export function checkAnswerPoints(
  firstLevelPoints: number[],
  startIdx: number,
  endIdx: number,
): boolean {
  if (firstLevelPoints.length > 0 && firstLevelPoints[0] < startIdx) {
    return false;
  }
  for (let i = 1; i < firstLevelPoints.length; i++) {
    const p = firstLevelPoints[i];
    if (p <= firstLevelPoints[i - 1] || p > endIdx) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Build residual lines for recurrentType=2 (matches Python build_residual_lines)
// ---------------------------------------------------------------------------

/**
 * Build residual context lines from previously processed segments.
 * Used when recurrentType=2 to provide context from the last L1 segment.
 *
 * Strategy: keep up to 5 L2 clips (first 2 + last 3), each ≤ 20 lines.
 * If total exceeds half the window, progressively reduce counts.
 */
function buildResidualLines(
  sentences: HiSentenceEntry[],
  globalChunkPoints: MultiLevelChunkPoints,
  startIdx: number,
  windowSize: number,
  recurrentType: number,
): HiSentenceEntry[] {
  if (recurrentType === 0 || recurrentType === 1) {
    return [];
  }
  if (recurrentType !== 2) {
    return [];
  }

  // Last Level One point
  let lastFirstPoint = 0;
  const firstLevelPoints = globalChunkPoints[0];
  if (firstLevelPoints && firstLevelPoints.length > 0) {
    lastFirstPoint = firstLevelPoints[firstLevelPoints.length - 1];
  }

  // Level Two points in the current L1 segment
  const secondLevelPoints = (globalChunkPoints[1] ?? []).filter((p) => p >= lastFirstPoint);
  const allSecondClips = pointsToClips(secondLevelPoints, lastFirstPoint, startIdx);

  let preSegNum = 2;
  let postSegNum = 3;
  let lineNum = 20;

  while (true) {
    let selectedClips = allSecondClips;
    if (allSecondClips.length > preSegNum + postSegNum) {
      selectedClips = [
        ...allSecondClips.slice(0, preSegNum),
        ...allSecondClips.slice(allSecondClips.length - postSegNum),
      ];
    }

    const residualLines: HiSentenceEntry[] = [];
    for (const [clipStart, clipEnd] of selectedClips) {
      const clampedEnd = Math.min(clipEnd, clipStart + lineNum);
      residualLines.push(...sentences.slice(clipStart, clampedEnd));
    }

    // Check if residual fits within half the window
    const residualText = residualLines.map((s) => s.text).join("\n");
    const residualChars = estimateStringChars(residualText);
    const halfWindowChars = (windowSize * CHARS_PER_TOKEN_ESTIMATE) / 2;
    if (residualChars < halfWindowChars) {
      return residualLines;
    }

    // Reduce: front -1, back -1, lines per clip -5
    preSegNum--;
    postSegNum--;
    lineNum -= 5;

    if (preSegNum * postSegNum * lineNum <= 0) {
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Union chunk points (matches Python union_chunk_points)
// ---------------------------------------------------------------------------

/** Merge local chunk points into global, filtering by maxIdx. */
function unionChunkPoints(
  local: MultiLevelChunkPoints,
  global: MultiLevelChunkPoints,
  maxIdx: number,
): MultiLevelChunkPoints {
  for (let i = 0; i < global.length; i++) {
    const localLevel = local[i];
    if (localLevel) {
      global[i].push(...localLevel.filter((p) => p < maxIdx));
    }
  }
  return global;
}

// ---------------------------------------------------------------------------
// Initialize empty chunk points
// ---------------------------------------------------------------------------

function initChunkPoints(maxLevel: number): MultiLevelChunkPoints {
  return Array.from({ length: maxLevel }, () => []);
}

// ---------------------------------------------------------------------------
// Build input instruction (matches Python build_input_instruction)
// ---------------------------------------------------------------------------

/**
 * Build the LLM input for a single inference round.
 * Concatenates: prompt + residual lines + window sentences, all in "{idx} @ {text}" format.
 * Stops when the estimated token count exceeds windowSize.
 *
 * @returns [inputText, isEnd, sentenceCount] where sentenceCount is how many
 *          sentences from the global array were included (excluding residual).
 */
function buildInputInstruction(
  prompt: string,
  globalStartIdx: number,
  sentences: HiSentenceEntry[],
  windowSize: number,
  residualLines: HiSentenceEntry[] | null,
): { inputText: string; isEnd: boolean; sentenceCount: number } {
  let text = prompt;

  // Append residual lines
  let residualIndex = 0;
  if (residualLines) {
    for (const rl of residualLines) {
      text += indexFormat(residualIndex, rl.text);
      residualIndex++;
    }
  }

  const residualCount = residualIndex;
  let localIdx = 0;
  let curTokens = estimateTokens(text);
  let isEnd = false;
  let gIdx = globalStartIdx;

  while (gIdx < sentences.length) {
    const lineText = indexFormat(localIdx + residualCount, sentences[gIdx].text);
    const lineTokens = estimateTokens(lineText);
    if (curTokens + lineTokens > windowSize) {
      break;
    }
    curTokens += lineTokens;
    text += lineText;
    localIdx++;
    gIdx++;
  }

  if (gIdx >= sentences.length) {
    isEnd = true;
  }

  return { inputText: text, isEnd, sentenceCount: localIdx };
}

// ---------------------------------------------------------------------------
// Post-process: convert chunk points to MemoryChunk array
// ---------------------------------------------------------------------------

/**
 * Convert origin sentences + multi-level chunk points into MemoryChunk[].
 *
 * Mirrors Python's post_process:
 * 1. Strip heading markers from origin sentences
 * 2. Sort all points across levels with their level number
 * 3. Split sentences at those points into chunks
 */
function postProcess(
  originSentences: HiSentenceEntry[],
  globalChunkPoints: MultiLevelChunkPoints,
): MemoryChunk[] {
  // Strip heading markers from origin sentences
  const cleanTexts = originSentences.map((s) => replaceHeadingMarkers(s.text, "") ?? s.text);

  // Collect all points with their level (1-based level)
  const allPoints: Array<{ point: number; level: number }> = [];
  for (let levelIdx = 0; levelIdx < globalChunkPoints.length; levelIdx++) {
    for (const p of globalChunkPoints[levelIdx]) {
      allPoints.push({ point: p, level: levelIdx + 1 });
    }
  }
  allPoints.sort((a, b) => a.point - b.point);

  // Build segments
  const chunks: MemoryChunk[] = [];
  let prevPoint = 0;

  for (const { point } of allPoints) {
    if (point === 0) {
      continue;
    }
    const segmentTexts = cleanTexts.slice(prevPoint, point);
    if (segmentTexts.length > 0) {
      const text = segmentTexts.join("").trim();
      if (text.length > 0) {
        const firstSent = originSentences[prevPoint];
        const lastSent = originSentences[Math.min(point - 1, originSentences.length - 1)];
        chunks.push({
          startLine: firstSent.startLine,
          endLine: lastSent.endLine,
          text,
          hash: hashText(text),
          embeddingInput: buildTextEmbeddingInput(text),
        });
      }
    }
    prevPoint = point;
  }

  // Final segment
  if (prevPoint < originSentences.length) {
    const segmentTexts = cleanTexts.slice(prevPoint);
    const text = segmentTexts.join("").trim();
    if (text.length > 0) {
      const firstSent = originSentences[prevPoint];
      const lastSent = originSentences[originSentences.length - 1];
      chunks.push({
        startLine: firstSent.startLine,
        endLine: lastSent.endLine,
        text,
        hash: hashText(text),
        embeddingInput: buildTextEmbeddingInput(text),
      });
    }
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// HiChunkStrategy class
// ---------------------------------------------------------------------------

/**
 * HiChunk — Hierarchical LLM-driven semantic document chunking strategy.
 *
 * Uses iterative sliding-window LLM inference to identify multi-level semantic
 * boundaries in a document. Each inference round processes a window of sentences,
 * asking the LLM to identify segment boundaries at multiple granularity levels
 * (Level One through Level N).
 *
 * Based on the Python HiChunkInferenceEngine implementation.
 *
 * Three recurrent modes control how the sliding window advances:
 * - 0: No residual context, simple forward advancement
 * - 1: When multiple L1 segments found, discard last L1 and restart from there
 * - 2: Like mode 1, but also includes residual context lines from previous segments
 */
export class HiChunkStrategy implements ChunkingStrategy {
  readonly name = "hichunk" as const;
  private readonly config: ChunkingConfig;
  private readonly windowSize: number;
  private readonly lineMaxLen: number;
  private readonly maxLevel: number;
  private readonly recurrentType: number;
  private readonly completionFn: LlmCompletionFn;

  constructor(config: ChunkingConfig, completionFn: LlmCompletionFn) {
    this.config = config;
    this.windowSize = config.windowSize ?? DEFAULT_WINDOW_SIZE;
    this.lineMaxLen = config.lineMaxLen ?? DEFAULT_LINE_MAX_LEN;
    this.maxLevel = config.maxLevel ?? DEFAULT_MAX_LEVEL;
    this.recurrentType = config.recurrentType ?? DEFAULT_RECURRENT_TYPE;
    this.completionFn = completionFn;
  }

  async chunk(content: string, _cfg: ChunkingConfig): Promise<MemoryChunk[]> {
    const { inputSentences, originSentences } = preProcess(content, this.lineMaxLen);
    if (inputSentences.length === 0) {
      return [];
    }

    // Short-circuit: very short documents
    if (inputSentences.length === 1) {
      const text = (
        replaceHeadingMarkers(originSentences[0].text, "") ?? originSentences[0].text
      ).trim();
      if (text.length === 0) {
        return [];
      }
      return [
        {
          startLine: originSentences[0].startLine,
          endLine: originSentences[0].endLine,
          text,
          hash: hashText(text),
          embeddingInput: buildTextEmbeddingInput(text),
        },
      ];
    }

    const globalChunkPoints = await this.iterativeInference(inputSentences);
    return postProcess(originSentences, globalChunkPoints);
  }

  /**
   * Iterative LLM inference loop.
   * Processes the document in sliding windows, accumulating multi-level chunk points.
   */
  private async iterativeInference(sentences: HiSentenceEntry[]): Promise<MultiLevelChunkPoints> {
    let startIdx = 0;
    let residualLines: HiSentenceEntry[] = [];
    const globalChunkPoints = initChunkPoints(this.maxLevel);

    while (startIdx < sentences.length) {
      const residualSentNum = residualLines.length;

      const { inputText, isEnd, sentenceCount } = buildInputInstruction(
        HICHUNK_PROMPT,
        startIdx,
        sentences,
        this.windowSize,
        residualLines.length > 0 ? residualLines : null,
      );

      let localChunkPoints: MultiLevelChunkPoints;

      try {
        const answer = await this.completionFn(inputText);
        localChunkPoints = parseAnswerChunkingPoints(answer, this.maxLevel);

        // Validate first-level points
        if (!checkAnswerPoints(localChunkPoints[0], 0, sentenceCount + residualSentNum - 1)) {
          // Check error: fallback to inserting a L1 point at startIdx
          localChunkPoints = initChunkPoints(this.maxLevel);
          localChunkPoints[0].push(startIdx);
        } else {
          // Map local indices to global indices
          for (let lvl = 0; lvl < localChunkPoints.length; lvl++) {
            const points = localChunkPoints[lvl];
            localChunkPoints[lvl] = points
              .filter((p) => p >= residualSentNum)
              .map((p) => p - residualSentNum + startIdx);
          }
        }
      } catch {
        // Parse or LLM error: fallback
        localChunkPoints = initChunkPoints(this.maxLevel);
        localChunkPoints[0].push(startIdx);
      }

      if (isEnd) {
        // Document fully processed
        startIdx += sentenceCount;
        unionChunkPoints(localChunkPoints, globalChunkPoints, startIdx);
        break;
      }

      const firstLevelPoints = localChunkPoints[0];

      if (firstLevelPoints.length > 1 && this.recurrentType >= 1) {
        // Multiple L1 segments: discard the last one, restart from there
        startIdx = firstLevelPoints[firstLevelPoints.length - 1];
        unionChunkPoints(localChunkPoints, globalChunkPoints, startIdx);
        residualLines = [];
      } else {
        // Single L1 segment: advance past the current window
        startIdx += sentenceCount;
        unionChunkPoints(localChunkPoints, globalChunkPoints, startIdx);
        residualLines = buildResidualLines(
          sentences,
          globalChunkPoints,
          startIdx,
          this.windowSize,
          this.recurrentType,
        );
      }
    }

    return globalChunkPoints;
  }
}
