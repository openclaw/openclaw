import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  buildBootstrapInjectionStats,
  analyzeBootstrapBudget,
} from "../../agents/bootstrap-budget.js";
import { resolveBootstrapContextForRun } from "../../agents/bootstrap-files.js";
import {
  resolveBootstrapMaxChars,
  resolveBootstrapTotalMaxChars,
} from "../../agents/pi-embedded-helpers.js";
import {
  DEFAULT_MEMORY_ALT_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_USER_FILENAME,
} from "../../agents/workspace.js";
import { logVerbose } from "../../globals.js";
import { parseSlashCommandActionArgs } from "./commands-slash-parse.js";
import type { CommandHandler } from "./commands-types.js";

type LeanSeverity = "critical" | "warn" | "info";
type LeanFindingKind =
  | "missing-core"
  | "bootstrap-budget"
  | "duplicate-doctrine"
  | "mushy-rule"
  | "doctrine-conflict"
  | "memory-placement"
  | "stale-bootstrap"
  | "safe-fix"
  | "file-overload"
  | "drift-signal"
  | "learning-pressure"
  | "patch-pressure";

type LeanFinding = {
  kind: LeanFindingKind;
  severity: LeanSeverity;
  title: string;
  detail: string;
  files?: string[];
  recommendation?: string;
};

type LeanFixStats = {
  bomRemoved: boolean;
  trailingWhitespaceLines: number;
  blankRunReductions: number;
  leadingBlankLinesRemoved: number;
  finalNewlineAdded: boolean;
};

type LeanFixChange = {
  path: string;
  beforeChars: number;
  afterChars: number;
  stats: LeanFixStats;
};

type LeanSemanticFixKind = "dedupe-consecutive-line" | "remove-bootstrap-stub";

type LeanSemanticFixChange = {
  kind: LeanSemanticFixKind;
  path: string;
  beforeChars: number;
  afterChars: number;
  detail: string;
};

type LeanScannedFile = {
  absolutePath: string;
  relativePath: string;
  bucket: "core" | "memory";
  content: string;
};

type DoctrineSegment = {
  file: string;
  line: number;
  text: string;
  tokens: string[];
  tokenSet: Set<string>;
  normalized: string;
};

type DuplicateCluster = {
  kind: "exact" | "near";
  similarity: number;
  segments: DoctrineSegment[];
};

type ConflictTopic = {
  name: string;
  keywords: RegExp;
  pushRegex: RegExp;
  cautionRegex: RegExp;
};

type LeanProposalAction = "rewrite" | "merge" | "relocate" | "delete";
type LeanProposalConfidence = "high" | "medium";

type LeanProposal = {
  action: LeanProposalAction;
  confidence: LeanProposalConfidence;
  title: string;
  rationale: string;
  files: string[];
  suggestion?: string;
};

type LeanScorecard = {
  overall: number;
  density: number;
  budget: number;
  drift: number;
  placement: number;
  learning: number;
  safety: number;
};

type LeanReport = {
  workspaceDir: string;
  scannedFiles: LeanScannedFile[];
  memoryMarkdownFiles: string[];
  bootstrap: ReturnType<typeof analyzeBootstrapBudget>;
  findings: LeanFinding[];
  proposals: LeanProposal[];
  safeFixCandidates: string[];
  safeFixesApplied: LeanFixChange[];
  semanticFixCandidates: string[];
  semanticFixesApplied: LeanSemanticFixChange[];
  totalChars: number;
  scorecard: LeanScorecard;
};

const CORE_DOCS = [
  "AGENTS.md",
  "BOOTSTRAP.md",
  "SOUL.md",
  "IDENTITY.md",
  "TOOLS.md",
  "MEMORY.md",
  "memory.md",
  DEFAULT_USER_FILENAME,
  "PATCHES.md",
] as const;

const REQUIRED_CORE_DOCS = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "TOOLS.md"] as const;
const DAILY_MEMORY_FILE_REGEX = /^\d{4}-\d{2}-\d{2}\.md$/;
const DUPLICATE_TEXT_MIN_CHARS = 34;
const DOCTRINE_SEGMENT_LIMIT = 260;
const EXACT_DUPLICATE_SIMILARITY = 1;
const NEAR_DUPLICATE_SIMILARITY = 0.72;
const MAX_FINDINGS = 18;
const MAX_PROPOSALS = 8;
const HIGH_CONFIDENCE_BOOTSTRAP_STUB_MAX_CHARS = 180;
const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "agent",
  "always",
  "and",
  "are",
  "because",
  "before",
  "being",
  "both",
  "but",
  "can",
  "chat",
  "concrete",
  "could",
  "direct",
  "does",
  "dont",
  "each",
  "from",
  "group",
  "have",
  "into",
  "just",
  "keep",
  "like",
  "make",
  "more",
  "need",
  "only",
  "over",
  "prompt",
  "reply",
  "rule",
  "says",
  "should",
  "that",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "tool",
  "tools",
  "use",
  "user",
  "very",
  "when",
  "with",
  "without",
  "your",
]);

const MUSHY_RULE_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  {
    label: "hedged directive",
    regex: /\b(try to|aim to|as needed|whenever possible|if appropriate|where possible)\b/i,
  },
  {
    label: "vague confidence",
    regex: /\b(maybe|perhaps|probably|generally|usually|often|sometimes|kind of|sort of)\b/i,
  },
  {
    label: "filler politeness",
    regex:
      /\b(great question|excellent question|certainly!?|absolutely!?|i(?:'d| would) be happy to help)\b/i,
  },
  { label: "stiff disclaimer", regex: /\b(as an ai|as a language model|i cannot browse)\b/i },
  { label: "corporate sludge", regex: /\b(delve into|leverage synergies|please note that)\b/i },
];

const ENVIRONMENT_DETAIL_REGEX =
  /\b(ssh|camera|speaker|homepod|voice|tts|hostname|tailscale|wifi|ssid|192\.168\.|10\.\d+\.|\.local\b|gateway|mac mini|launchd)\b/i;

const MEMORY_SIGNAL_REGEX =
  /\b(prefers|likes|dislikes|hates|values|tends to|often asks|always wants|never wants|friend|partner|family|timezone|schedule|routine)\b/i;

const LEARNING_SIGNAL_REGEX =
  /\b(learned|lesson|never again|watch for|root cause|broke because|fixed by|next time|scar|regression|failure mode)\b/i;

const PATCH_SIGNAL_REGEX = /\b(patch|fix|regression|rollback|follow-up|postmortem|lesson)\b/i;

const BOOTSTRAP_STUB_REGEX = /\b(still here|placeholder|stub|todo|tbd|bootstrap|seed(ed)?|temp)\b/i;

const CONFLICT_TOPICS: ConflictTopic[] = [
  {
    name: "external actions",
    keywords: /\b(email|tweet|post|publish|send|external|public)\b/i,
    pushRegex: /\b(without asking|don't ask permission|just do it|send directly|freely)\b/i,
    cautionRegex:
      /\b(ask first|confirm first|approval|don't act externally|do not act externally)\b/i,
  },
  {
    name: "destructive changes",
    keywords: /\b(delete|destructive|trash|rm|remove)\b/i,
    pushRegex: /\b(without asking|remove automatically|delete directly)\b/i,
    cautionRegex:
      /\b(ask first|trash > rm|don't run destructive commands without asking|do not run destructive commands without asking)\b/i,
  },
  {
    name: "startup autonomy",
    keywords: /\b(startup|before doing anything|session startup|boot|on startup)\b/i,
    pushRegex: /\b(before doing anything|just do it|don't ask permission)\b/i,
    cautionRegex: /\b(wait for permission|ask first|ask before reading)\b/i,
  },
  {
    name: "privacy boundary",
    keywords: /\b(private|secret|leak|share|personal spillover|group chat)\b/i,
    pushRegex: /\b(share freely|broadcast it|post it)\b/i,
    cautionRegex: /\b(private things stay private|don't leak|do not leak|don't share)\b/i,
  },
];

function formatInt(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatSignedInt(value: number): string {
  if (value > 0) {
    return `+${formatInt(value)}`;
  }
  return `${value}`;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function relativeDisplay(workspaceDir: string, absolutePath: string): string {
  const rel = path.relative(workspaceDir, absolutePath).replace(/\\/g, "/");
  return rel || path.basename(absolutePath);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function collectMarkdownFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(currentDir: string): Promise<void> {
    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(currentDir, { encoding: "utf8", withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        found.push(fullPath);
      }
    }
  }
  await walk(dir);
  return found.toSorted((a, b) => a.localeCompare(b));
}

async function loadLeanScannedFiles(workspaceDir: string): Promise<{
  files: LeanScannedFile[];
  memoryMarkdownFiles: string[];
}> {
  const files: LeanScannedFile[] = [];
  const seen = new Set<string>();

  for (const name of CORE_DOCS) {
    const absolutePath = path.join(workspaceDir, name);
    if (!(await exists(absolutePath))) {
      continue;
    }
    const content = await fs.readFile(absolutePath, "utf8");
    files.push({
      absolutePath,
      relativePath: relativeDisplay(workspaceDir, absolutePath),
      bucket: "core",
      content,
    });
    seen.add(absolutePath);
  }

  const memoryDir = path.join(workspaceDir, "memory");
  const memoryMarkdownFiles = await collectMarkdownFiles(memoryDir);
  for (const absolutePath of memoryMarkdownFiles) {
    if (seen.has(absolutePath)) {
      continue;
    }
    const content = await fs.readFile(absolutePath, "utf8");
    files.push({
      absolutePath,
      relativePath: relativeDisplay(workspaceDir, absolutePath),
      bucket: "memory",
      content,
    });
  }

  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return {
    files,
    memoryMarkdownFiles: memoryMarkdownFiles.map((file) => relativeDisplay(workspaceDir, file)),
  };
}

function normalizeComparableText(text: string): string {
  return text
    .replace(/^[-*+0-9.\s)]+/, "")
    .replace(/`+/g, "")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function tokenizeDoctrine(text: string): string[] {
  return Array.from(
    new Set(
      normalizeComparableText(text)
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3 && !STOP_WORDS.has(token)),
    ),
  );
}

function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) {
      intersection += 1;
    }
  }
  const union = left.size + right.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function shouldTrackDoctrineLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("```")) {
    return false;
  }
  if (trimmed.length < DUPLICATE_TEXT_MIN_CHARS) {
    return false;
  }
  return /[a-zA-Z]/.test(trimmed);
}

function extractDoctrineSegments(files: LeanScannedFile[]): DoctrineSegment[] {
  const segments: DoctrineSegment[] = [];
  for (const file of files.filter((entry) => entry.bucket === "core")) {
    const lines = file.content.split(/\r?\n/u);
    lines.forEach((line, index) => {
      if (!shouldTrackDoctrineLine(line)) {
        return;
      }
      const text = line.trim();
      const tokens = tokenizeDoctrine(text);
      if (tokens.length < 4) {
        return;
      }
      const normalized = normalizeComparableText(text);
      segments.push({
        file: file.relativePath,
        line: index + 1,
        text,
        tokens,
        tokenSet: new Set(tokens),
        normalized,
      });
    });
  }
  return segments.slice(0, DOCTRINE_SEGMENT_LIMIT);
}

function pickCanonicalHome(files: string[]): string {
  const priority = [
    "AGENTS.md",
    "SOUL.md",
    "IDENTITY.md",
    "TOOLS.md",
    DEFAULT_USER_FILENAME,
    DEFAULT_MEMORY_FILENAME,
    DEFAULT_MEMORY_ALT_FILENAME,
    "PATCHES.md",
  ];
  return [...files].toSorted((left, right) => {
    const leftRank = priority.indexOf(left);
    const rightRank = priority.indexOf(right);
    if (leftRank !== -1 || rightRank !== -1) {
      return (leftRank === -1 ? 999 : leftRank) - (rightRank === -1 ? 999 : rightRank);
    }
    return left.localeCompare(right);
  })[0];
}

function collectDuplicateClusters(files: LeanScannedFile[]): DuplicateCluster[] {
  const segments = extractDoctrineSegments(files);
  const clusters: DuplicateCluster[] = [];
  const exactOccurrences = new Map<string, DoctrineSegment[]>();

  for (const segment of segments) {
    const existing = exactOccurrences.get(segment.normalized) ?? [];
    existing.push(segment);
    exactOccurrences.set(segment.normalized, existing);
  }

  for (const items of exactOccurrences.values()) {
    const uniqueFiles = new Set(items.map((item) => item.file));
    if (uniqueFiles.size <= 1) {
      continue;
    }
    clusters.push({
      kind: "exact",
      similarity: EXACT_DUPLICATE_SIMILARITY,
      segments: items,
    });
  }

  const seenNearKeys = new Set<string>();
  for (let i = 0; i < segments.length; i += 1) {
    for (let j = i + 1; j < segments.length; j += 1) {
      const left = segments[i];
      const right = segments[j];
      if (left.file === right.file || left.normalized === right.normalized) {
        continue;
      }
      const similarity = jaccardSimilarity(left.tokenSet, right.tokenSet);
      if (similarity < NEAR_DUPLICATE_SIMILARITY) {
        continue;
      }
      const key = [
        left.file,
        right.file,
        left.normalized.slice(0, 24),
        right.normalized.slice(0, 24),
      ]
        .toSorted()
        .join("|");
      if (seenNearKeys.has(key)) {
        continue;
      }
      seenNearKeys.add(key);
      clusters.push({
        kind: "near",
        similarity,
        segments: [left, right],
      });
    }
  }

  return clusters.toSorted((a, b) => {
    if (b.similarity !== a.similarity) {
      return b.similarity - a.similarity;
    }
    return b.segments.length - a.segments.length;
  });
}

function scanDuplicateDoctrine(clusters: DuplicateCluster[]): LeanFinding[] {
  const findings: LeanFinding[] = [];
  const exactClusters = clusters.filter((cluster) => cluster.kind === "exact").slice(0, 3);
  for (const cluster of exactClusters) {
    findings.push({
      kind: "duplicate-doctrine",
      severity: "warn",
      title: "Same rule copied across files",
      detail: `“${cluster.segments[0]?.text ?? ""}” appears in ${cluster.segments.length} places.`,
      files: cluster.segments.map((segment) => `${segment.file}:${segment.line}`),
      recommendation:
        "Keep one strongest home, then rewrite the neighbors so they reinforce it instead of cloning it.",
    });
  }

  const nearClusters = clusters.filter((cluster) => cluster.kind === "near").slice(0, 3);
  for (const cluster of nearClusters) {
    findings.push({
      kind: "duplicate-doctrine",
      severity: "info",
      title: "Closely overlapping doctrine detected",
      detail: `Two files are carrying nearly the same instruction with ${Math.round(cluster.similarity * 100)}% overlap.`,
      files: cluster.segments.map((segment) => `${segment.file}:${segment.line}`),
      recommendation:
        "Merge toward the sharper line. Leave one rule owner, not two cousins that drift apart.",
    });
  }

  return findings;
}

function scanMushyRules(files: LeanScannedFile[]): LeanFinding[] {
  const findings: LeanFinding[] = [];
  for (const file of files.filter((entry) => entry.bucket === "core")) {
    const lines = file.content.split(/\r?\n/u);
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        return;
      }
      const hits = MUSHY_RULE_PATTERNS.filter((pattern) => pattern.regex.test(trimmed));
      if (hits.length === 0) {
        return;
      }
      findings.push({
        kind: "mushy-rule",
        severity: hits.length >= 2 ? "warn" : "info",
        title: hits.length >= 2 ? "Rule is mushy enough to drift" : "Rule could be sharper",
        detail: `${file.relativePath}:${index + 1} carries ${hits.map((hit) => hit.label).join(", ")}.`,
        files: [`${file.relativePath}:${index + 1}`],
        recommendation: "Turn it into one concrete default with trigger, action, and boundary.",
      });
    });
  }
  return findings.slice(0, 6);
}

function scanDoctrineConflicts(files: LeanScannedFile[]): LeanFinding[] {
  const findings: LeanFinding[] = [];
  for (const topic of CONFLICT_TOPICS) {
    const pushHits: Array<{ file: string; line: number; text: string }> = [];
    const cautionHits: Array<{ file: string; line: number; text: string }> = [];
    for (const file of files.filter((entry) => entry.bucket === "core")) {
      const lines = file.content.split(/\r?\n/u);
      lines.forEach((line, index) => {
        const trimmed = line.trim();
        if (!trimmed || !topic.keywords.test(trimmed)) {
          return;
        }
        if (topic.pushRegex.test(trimmed)) {
          pushHits.push({ file: file.relativePath, line: index + 1, text: trimmed });
        }
        if (topic.cautionRegex.test(trimmed)) {
          cautionHits.push({ file: file.relativePath, line: index + 1, text: trimmed });
        }
      });
    }
    if (pushHits.length === 0 || cautionHits.length === 0) {
      continue;
    }
    const left = pushHits[0];
    const right = cautionHits[0];
    findings.push({
      kind: "doctrine-conflict",
      severity: "warn",
      title: `Conflict cluster around ${topic.name}`,
      detail: `Found both push and caution language. Example tension: “${left.text}” versus “${right.text}”.`,
      files: [`${left.file}:${left.line}`, `${right.file}:${right.line}`],
      recommendation:
        "Write one scoped rule that names the default, the exception, and the approval boundary.",
    });
  }
  return findings;
}

function scanMemoryPlacement(
  files: LeanScannedFile[],
  memoryMarkdownFiles: string[],
): LeanFinding[] {
  const findings: LeanFinding[] = [];
  const recurringMemoryLines = new Map<
    string,
    Array<{ file: string; line: number; text: string }>
  >();

  for (const file of files) {
    const lines = file.content.split(/\r?\n/u);
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        return;
      }
      if (
        file.bucket === "core" &&
        file.relativePath !== "TOOLS.md" &&
        ENVIRONMENT_DETAIL_REGEX.test(trimmed)
      ) {
        findings.push({
          kind: "memory-placement",
          severity: "warn",
          title: "Environment detail is living in doctrine",
          detail: `${file.relativePath}:${index + 1} looks like setup truth, not timeless instruction.`,
          files: [`${file.relativePath}:${index + 1}`],
          recommendation:
            "Relocate the machine detail to TOOLS.md and keep only the behavioral consequence here.",
        });
      }
      if (
        file.bucket === "memory" &&
        DAILY_MEMORY_FILE_REGEX.test(path.basename(file.relativePath))
      ) {
        const normalized = normalizeComparableText(trimmed);
        if (normalized.length < 28) {
          return;
        }
        const existing = recurringMemoryLines.get(normalized) ?? [];
        existing.push({ file: file.relativePath, line: index + 1, text: trimmed });
        recurringMemoryLines.set(normalized, existing);
      }
      if (
        file.bucket === "core" &&
        file.relativePath !== DEFAULT_MEMORY_FILENAME &&
        file.relativePath !== DEFAULT_MEMORY_ALT_FILENAME &&
        MEMORY_SIGNAL_REGEX.test(trimmed)
      ) {
        findings.push({
          kind: "memory-placement",
          severity: "info",
          title: "Possible durable preference outside MEMORY.md",
          detail: `${file.relativePath}:${index + 1} looks like stable human context that may belong in MEMORY.md.`,
          files: [`${file.relativePath}:${index + 1}`],
          recommendation:
            "If this is durable human truth, distill it into MEMORY.md and keep only the policy wrapper here.",
        });
      }
    });
  }

  const recurringMemory = Array.from(recurringMemoryLines.values())
    .filter((items) => new Set(items.map((item) => item.file)).size >= 2)
    .toSorted((a, b) => b.length - a.length)
    .slice(0, 3);

  for (const items of recurringMemory) {
    findings.push({
      kind: "memory-placement",
      severity: "info",
      title: "Recurring daily lesson wants distillation",
      detail: `A similar memory line shows up across ${items.length} daily notes: “${items[0]?.text ?? ""}”.`,
      files: items.map((item) => `${item.file}:${item.line}`),
      recommendation:
        "Promote the durable lesson into MEMORY.md so daily notes stop carrying the same weight over and over.",
    });
  }

  const memoryFile = files.find(
    (file) =>
      file.relativePath === DEFAULT_MEMORY_FILENAME ||
      file.relativePath === DEFAULT_MEMORY_ALT_FILENAME,
  );
  const dailyFiles = memoryMarkdownFiles.filter((file) =>
    DAILY_MEMORY_FILE_REGEX.test(path.basename(file)),
  );
  if (!memoryFile && dailyFiles.length >= 5) {
    findings.push({
      kind: "memory-placement",
      severity: "warn",
      title: "Daily notes exist without distilled memory",
      detail: `${dailyFiles.length} daily memory files exist, but there is no ${DEFAULT_MEMORY_FILENAME}.`,
      recommendation: `Create ${DEFAULT_MEMORY_FILENAME} and promote stable lessons, preferences, and active facts into it.`,
    });
  } else if (memoryFile && dailyFiles.length >= 8 && memoryFile.content.trim().length < 200) {
    findings.push({
      kind: "memory-placement",
      severity: "info",
      title: "Long-term memory looks thin",
      detail: `${dailyFiles.length} daily notes exist, but ${memoryFile.relativePath} is still sparse.`,
      recommendation:
        "Distill recurring facts and lessons into MEMORY.md so recall stays crisp as daily notes grow.",
    });
  }

  return findings.slice(0, 8);
}

function scanMissingCore(files: LeanScannedFile[]): LeanFinding[] {
  const present = new Set(files.map((file) => file.relativePath));
  const missing = REQUIRED_CORE_DOCS.filter((name) => !present.has(name));
  if (missing.length === 0) {
    return [];
  }
  return [
    {
      kind: "missing-core",
      severity: "critical",
      title: "Core prompt files are missing",
      detail: `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} absent from the workspace root.`,
      recommendation: "Restore the missing root files before rewriting anything else.",
    },
  ];
}

function scanStaleBootstrap(
  files: LeanScannedFile[],
  memoryMarkdownFiles: string[],
): LeanFinding[] {
  const bootstrapFile = files.find((file) => file.relativePath === "BOOTSTRAP.md");
  if (!bootstrapFile) {
    return [];
  }
  const signals = [
    "IDENTITY.md",
    "SOUL.md",
    DEFAULT_USER_FILENAME,
    DEFAULT_MEMORY_FILENAME,
    DEFAULT_MEMORY_ALT_FILENAME,
  ].filter((name) => files.some((file) => file.relativePath === name));
  if (signals.length === 0 && memoryMarkdownFiles.length === 0) {
    return [];
  }
  const trimmed = bootstrapFile.content.trim();
  const stubSignals = trimmed
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const likelyStub =
    trimmed.length <= HIGH_CONFIDENCE_BOOTSTRAP_STUB_MAX_CHARS &&
    stubSignals.length <= 3 &&
    stubSignals.length > 0 &&
    stubSignals.every((line) => BOOTSTRAP_STUB_REGEX.test(line));
  return [
    {
      kind: "stale-bootstrap",
      severity: likelyStub ? "warn" : "info",
      title: likelyStub ? "BOOTSTRAP.md looks like an old stub" : "BOOTSTRAP.md may be stale",
      detail: `BOOTSTRAP.md still exists even though the workspace already has ${[
        ...signals,
        memoryMarkdownFiles[0] ? "memory/..." : null,
      ]
        .filter(Boolean)
        .join(", ")}.`,
      files: ["BOOTSTRAP.md"],
      recommendation: likelyStub
        ? "This is a good delete candidate if it no longer teaches anything the mature stack needs."
        : "Retire or rewrite BOOTSTRAP.md so onboarding ritual does not keep leaking into mature context.",
    },
  ];
}

function summarizeBootstrapBudget(
  report: ReturnType<typeof analyzeBootstrapBudget>,
): LeanFinding[] {
  if (report.hasTruncation) {
    return [
      {
        kind: "bootstrap-budget",
        severity: "critical",
        title: "Bootstrap context is being truncated",
        detail: `${report.truncatedFiles.length} file(s) are over budget, ${formatInt(report.totals.rawChars)} raw chars into ${formatInt(report.totals.injectedChars)} injected chars.`,
        files: report.truncatedFiles.slice(0, 5).map((file) => file.path),
        recommendation: "Rewrite the fattest files first. Keep the doctrine, compress the prose.",
      },
    ];
  }
  const nearLimitFiles = report.nearLimitFiles.filter((file) => !file.missing).slice(0, 5);
  if (nearLimitFiles.length === 0 && !report.totalNearLimit) {
    return [];
  }
  return [
    {
      kind: "bootstrap-budget",
      severity: "warn",
      title: "Bootstrap context is near budget",
      detail: `${nearLimitFiles.length} file(s) are near the per-file cap and total injected chars are ${formatInt(report.totals.injectedChars)} of ${formatInt(report.totals.bootstrapTotalMaxChars)}.`,
      files: nearLimitFiles.map((file) => file.path),
      recommendation:
        "Tighten high-volume files now while the stack is still coherent enough to rewrite cleanly.",
    },
  ];
}

function scanFileOverload(files: LeanScannedFile[]): LeanFinding[] {
  const findings: LeanFinding[] = [];
  for (const file of files.filter((entry) => entry.bucket === "core")) {
    const chars = file.content.trim().length;
    const lines = file.content.split(/\r?\n/u).length;
    if (chars >= 18_000 || lines >= 320) {
      findings.push({
        kind: "file-overload",
        severity: chars >= 24_000 ? "critical" : "warn",
        title: "Core file is overloaded",
        detail: `${file.relativePath} is carrying ${formatInt(chars)} chars across ${formatInt(lines)} lines.`,
        files: [file.relativePath],
        recommendation:
          "Rewrite into tighter doctrine, move machine details to TOOLS or MEMORY, and collapse repeated rules.",
      });
    }
  }
  return findings.slice(0, 4);
}

function scanDriftSignals(files: LeanScannedFile[], clusters: DuplicateCluster[]): LeanFinding[] {
  const findings: LeanFinding[] = [];
  const pairCounts = new Map<string, number>();
  for (const cluster of clusters) {
    const uniqueFiles = Array.from(
      new Set(cluster.segments.map((segment) => segment.file)),
    ).toSorted();
    if (uniqueFiles.length !== 2) {
      continue;
    }
    const key = `${uniqueFiles[0]}|${uniqueFiles[1]}`;
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
  }
  for (const [pair, count] of pairCounts) {
    if (count < 3) {
      continue;
    }
    const [left, right] = pair.split("|");
    findings.push({
      kind: "drift-signal",
      severity: count >= 5 ? "warn" : "info",
      title: "Prompt drift pressure between files",
      detail: `${left} and ${right} overlap on ${count} doctrine segments. They are starting to do the same job.`,
      files: [left, right],
      recommendation:
        "Split responsibilities cleanly. One file should own the rule, the other should own tone, identity, or reference context.",
    });
  }

  const coreFiles = files.filter((file) => file.bucket === "core");
  for (const file of coreFiles) {
    const mushyHits = file.content
      .split(/\r?\n/u)
      .filter((line) => MUSHY_RULE_PATTERNS.some((pattern) => pattern.regex.test(line))).length;
    const envHits = file.content
      .split(/\r?\n/u)
      .filter((line) => ENVIRONMENT_DETAIL_REGEX.test(line)).length;
    if (mushyHits >= 3 && envHits >= 1) {
      findings.push({
        kind: "drift-signal",
        severity: "warn",
        title: "File mixes vibe, doctrine, and machine detail",
        detail: `${file.relativePath} contains both mushy guidance and environment-specific lines.`,
        files: [file.relativePath],
        recommendation:
          "Separate the enduring rule from the local setup detail, then sharpen the wording.",
      });
    }
  }

  return findings.slice(0, 5);
}

function scanLearningPressure(files: LeanScannedFile[]): LeanFinding[] {
  const findings: LeanFinding[] = [];
  const learningHits: Array<{ file: string; line: number; text: string }> = [];
  const patchFiles = new Set<string>();

  for (const file of files) {
    const lines = file.content.split(/\r?\n/u);
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        return;
      }
      if (LEARNING_SIGNAL_REGEX.test(trimmed)) {
        learningHits.push({ file: file.relativePath, line: index + 1, text: trimmed });
      }
      if (file.relativePath === "PATCHES.md" && PATCH_SIGNAL_REGEX.test(trimmed)) {
        patchFiles.add(file.relativePath);
      }
    });
  }

  const recentMemoryHits = learningHits.filter((hit) => hit.file.startsWith("memory/"));
  const patchHits = learningHits.filter((hit) => hit.file === "PATCHES.md");
  const memoryFile = files.find(
    (file) =>
      file.relativePath === DEFAULT_MEMORY_FILENAME ||
      file.relativePath === DEFAULT_MEMORY_ALT_FILENAME,
  );

  if (recentMemoryHits.length >= 3 && (!memoryFile || memoryFile.content.trim().length < 250)) {
    findings.push({
      kind: "learning-pressure",
      severity: "warn",
      title: "Recent learnings are not being distilled fast enough",
      detail: `${recentMemoryHits.length} lesson-like lines are sitting in daily memory, but durable memory is still thin.`,
      files: recentMemoryHits.slice(0, 4).map((hit) => `${hit.file}:${hit.line}`),
      recommendation:
        "Promote the repeated lessons into MEMORY.md or the relevant doctrine file so the machine learns once, not five times.",
    });
  }

  if (patchHits.length >= 2) {
    findings.push({
      kind: "patch-pressure",
      severity: patchHits.length >= 4 ? "warn" : "info",
      title: "Patch history is carrying live doctrine pressure",
      detail: `${patchHits.length} patch or lesson lines are sitting in PATCHES.md.`,
      files: patchHits.slice(0, 4).map((hit) => `${hit.file}:${hit.line}`),
      recommendation:
        "Distill recurring scars into AGENTS, TOOLS, or MEMORY. PATCHES should record history, not remain the only teacher.",
    });
  } else if (patchFiles.size > 0) {
    findings.push({
      kind: "patch-pressure",
      severity: "info",
      title: "Patch history exists but may not be feeding doctrine",
      detail:
        "PATCHES.md is present. Check whether its repeated fixes have already been distilled into stable rules.",
      files: ["PATCHES.md"],
      recommendation:
        "Promote repeat scars into the right home before the same class of fix repeats again.",
    });
  }

  return findings.slice(0, 4);
}

function buildSafeFixedContent(original: string): { content: string; stats: LeanFixStats } {
  const stats: LeanFixStats = {
    bomRemoved: original.startsWith("\uFEFF"),
    trailingWhitespaceLines: 0,
    blankRunReductions: 0,
    leadingBlankLinesRemoved: 0,
    finalNewlineAdded: false,
  };

  const withoutBom = original.replace(/^\uFEFF/, "");
  const lines = withoutBom.split(/\r?\n/u);
  const trimmedLines = lines.map((line) => {
    const trimmed = line.replace(/[ \t]+$/g, "");
    if (trimmed !== line) {
      stats.trailingWhitespaceLines += 1;
    }
    return trimmed;
  });

  while (trimmedLines.length > 0 && trimmedLines[0] === "") {
    trimmedLines.shift();
    stats.leadingBlankLinesRemoved += 1;
  }

  const collapsed: string[] = [];
  let blankStreak = 0;
  for (const line of trimmedLines) {
    if (line === "") {
      blankStreak += 1;
      if (blankStreak <= 1) {
        collapsed.push(line);
      } else {
        stats.blankRunReductions += 1;
      }
      continue;
    }
    blankStreak = 0;
    collapsed.push(line);
  }

  let content = collapsed.join("\n").replace(/\s*$/u, "");
  if (!content.endsWith("\n")) {
    stats.finalNewlineAdded = true;
    content = `${content}\n`;
  }
  return { content, stats };
}

async function applySafeFixes(files: LeanScannedFile[]): Promise<LeanFixChange[]> {
  const changes: LeanFixChange[] = [];
  for (const file of files) {
    const fixed = buildSafeFixedContent(file.content);
    if (fixed.content === file.content) {
      continue;
    }
    await fs.writeFile(file.absolutePath, fixed.content, "utf8");
    changes.push({
      path: file.relativePath,
      beforeChars: file.content.length,
      afterChars: fixed.content.length,
      stats: fixed.stats,
    });
  }
  return changes;
}

function buildSemanticFixedContent(original: string): {
  content: string;
  duplicateLinesRemoved: number;
} {
  const lines = original.split(/\r?\n/u);
  const kept: string[] = [];
  let inCodeFence = false;
  let duplicateLinesRemoved = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inCodeFence = !inCodeFence;
      kept.push(line);
      continue;
    }
    if (
      !inCodeFence &&
      trimmed &&
      !trimmed.startsWith("#") &&
      kept.length > 0 &&
      normalizeComparableText(kept[kept.length - 1] ?? "") === normalizeComparableText(line)
    ) {
      duplicateLinesRemoved += 1;
      continue;
    }
    kept.push(line);
  }

  const content = `${kept.join("\n").replace(/\s*$/u, "")}\n`;
  return { content, duplicateLinesRemoved };
}

function isBootstrapStub(file: LeanScannedFile, files: LeanScannedFile[]): boolean {
  if (file.relativePath !== "BOOTSTRAP.md") {
    return false;
  }
  const matureFiles = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "TOOLS.md"].filter((name) =>
    files.some((entry) => entry.relativePath === name),
  );
  if (matureFiles.length < 4) {
    return false;
  }
  const lines = file.content
    .trim()
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (
    file.content.trim().length > HIGH_CONFIDENCE_BOOTSTRAP_STUB_MAX_CHARS ||
    lines.length === 0 ||
    lines.length > 3
  ) {
    return false;
  }
  return lines.every((line) => BOOTSTRAP_STUB_REGEX.test(line));
}

function listSemanticFixCandidates(files: LeanScannedFile[]): string[] {
  const candidates: string[] = [];
  for (const file of files) {
    if (buildSemanticFixedContent(file.content).duplicateLinesRemoved > 0) {
      candidates.push(`${file.relativePath} (duplicate-line cleanup)`);
    }
    if (isBootstrapStub(file, files)) {
      candidates.push(`${file.relativePath} (bootstrap stub removal)`);
    }
  }
  return candidates;
}

async function applySemanticFixes(files: LeanScannedFile[]): Promise<LeanSemanticFixChange[]> {
  const changes: LeanSemanticFixChange[] = [];
  for (const file of files) {
    const deduped = buildSemanticFixedContent(file.content);
    if (deduped.duplicateLinesRemoved > 0 && deduped.content !== file.content) {
      await fs.writeFile(file.absolutePath, deduped.content, "utf8");
      changes.push({
        kind: "dedupe-consecutive-line",
        path: file.relativePath,
        beforeChars: file.content.length,
        afterChars: deduped.content.length,
        detail: `${deduped.duplicateLinesRemoved} consecutive duplicate line(s) removed`,
      });
      file.content = deduped.content;
    }
  }

  for (const file of files) {
    if (!isBootstrapStub(file, files)) {
      continue;
    }
    await fs.rm(file.absolutePath, { force: true });
    changes.push({
      kind: "remove-bootstrap-stub",
      path: file.relativePath,
      beforeChars: file.content.length,
      afterChars: 0,
      detail: "obsolete bootstrap stub removed",
    });
  }

  return changes;
}

function dedupeFindings(findings: LeanFinding[]): LeanFinding[] {
  const seen = new Set<string>();
  const result: LeanFinding[] = [];
  for (const finding of findings) {
    const key = [finding.kind, finding.title, finding.detail, (finding.files ?? []).join("|")].join(
      "::",
    );
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(finding);
  }
  return result;
}

function sharpenRuleText(text: string): string {
  let next = text.trim();
  next = next.replace(/\b(great question|excellent question|please note that)\b[:,]?\s*/gi, "");
  next = next.replace(/\b(try to|aim to)\b\s*/gi, "");
  next = next.replace(/\b(if appropriate|whenever possible|where possible|as needed)\b/gi, "");
  next = next.replace(/\s+/g, " ").trim();
  if (!next) {
    return text.trim();
  }
  return next.charAt(0).toUpperCase() + next.slice(1);
}

function buildLeanProposals(params: {
  findings: LeanFinding[];
  duplicateClusters: DuplicateCluster[];
  files: LeanScannedFile[];
}): LeanProposal[] {
  const proposals: LeanProposal[] = [];

  for (const cluster of params.duplicateClusters
    .filter((entry) => entry.kind === "exact")
    .slice(0, 3)) {
    const homes = Array.from(new Set(cluster.segments.map((segment) => segment.file)));
    const canonicalHome = pickCanonicalHome(homes);
    proposals.push({
      action: "merge",
      confidence: "high",
      title: "Consolidate exact duplicate doctrine",
      rationale: `The same rule is cloned across ${homes.length} files.`,
      files: cluster.segments.map((segment) => `${segment.file}:${segment.line}`),
      suggestion: `Keep the strongest wording in ${canonicalHome}, then rewrite the other files so they reference or complement it instead of repeating it verbatim.`,
    });
  }

  for (const cluster of params.duplicateClusters
    .filter((entry) => entry.kind === "near")
    .slice(0, 2)) {
    proposals.push({
      action: "merge",
      confidence: "medium",
      title: "Merge overlapping doctrine before it drifts",
      rationale: `These two lines already overlap by ${Math.round(cluster.similarity * 100)}%.`,
      files: cluster.segments.map((segment) => `${segment.file}:${segment.line}`),
      suggestion: `Merge toward one sharper owner line. Candidate source: “${cluster.segments[0]?.text ?? ""}”.`,
    });
  }

  for (const finding of params.findings) {
    if (finding.kind === "memory-placement" && finding.files?.length) {
      const target = finding.detail.includes("setup truth") ? "TOOLS.md" : DEFAULT_MEMORY_FILENAME;
      proposals.push({
        action: "relocate",
        confidence: finding.severity === "warn" ? "high" : "medium",
        title: finding.title,
        rationale: finding.detail,
        files: finding.files,
        suggestion: `Move the durable fact into ${target}, then leave only the behavioral implication in the current file.`,
      });
    }
    if (finding.kind === "mushy-rule" && finding.files?.length) {
      const sourceFile = finding.files[0]?.split(":")[0] ?? "the source file";
      const sourceLine = finding.files[0];
      const source = params.files.find((file) => file.relativePath === sourceFile);
      const lineNumber = Number(sourceLine?.split(":")[1] ?? "0");
      const line = source?.content.split(/\r?\n/u)[lineNumber - 1]?.trim() ?? "";
      proposals.push({
        action: "rewrite",
        confidence: "medium",
        title: "Sharpen a drift-prone rule",
        rationale: finding.detail,
        files: finding.files,
        suggestion: line
          ? `Rewrite toward: “${sharpenRuleText(line)}”.`
          : "Rewrite it into one crisp default with scope and boundary.",
      });
    }
    if (finding.kind === "doctrine-conflict") {
      proposals.push({
        action: "rewrite",
        confidence: "high",
        title: finding.title,
        rationale: finding.detail,
        files: finding.files ?? [],
        suggestion:
          "Write one scoped rule that states default behavior, approval requirement, and exception path in one place.",
      });
    }
    if (finding.kind === "stale-bootstrap") {
      proposals.push({
        action: "delete",
        confidence: finding.title.includes("stub") ? "high" : "medium",
        title: finding.title,
        rationale: finding.detail,
        files: finding.files ?? ["BOOTSTRAP.md"],
        suggestion: finding.title.includes("stub")
          ? "Delete BOOTSTRAP.md if it no longer teaches unique startup truth."
          : "Either rewrite BOOTSTRAP.md into a real startup brief or retire it.",
      });
    }
    if (finding.kind === "file-overload") {
      proposals.push({
        action: "rewrite",
        confidence: "high",
        title: "Rewrite an overloaded file down to doctrine density",
        rationale: finding.detail,
        files: finding.files ?? [],
        suggestion:
          "Prefer rewrite over trim. Collapse repeated rules, move setup facts out, and keep scar tissue only if it still changes behavior.",
      });
    }
    if (finding.kind === "learning-pressure" || finding.kind === "patch-pressure") {
      proposals.push({
        action: "relocate",
        confidence: finding.severity === "warn" ? "high" : "medium",
        title: finding.title,
        rationale: finding.detail,
        files: finding.files ?? [],
        suggestion:
          "Promote the repeated scar into AGENTS, TOOLS, or MEMORY so history becomes doctrine instead of backlog.",
      });
    }
  }

  const deduped = new Map<string, LeanProposal>();
  for (const proposal of proposals) {
    const key = [
      proposal.action,
      proposal.title,
      proposal.rationale,
      proposal.files.join("|"),
    ].join("::");
    if (!deduped.has(key)) {
      deduped.set(key, proposal);
    }
  }

  const priority = { high: 0, medium: 1 } as const;
  return Array.from(deduped.values())
    .toSorted((left, right) => {
      if (priority[left.confidence] !== priority[right.confidence]) {
        return priority[left.confidence] - priority[right.confidence];
      }
      return left.title.localeCompare(right.title);
    })
    .slice(0, MAX_PROPOSALS);
}

function computeScorecard(params: {
  findings: LeanFinding[];
  bootstrap: ReturnType<typeof analyzeBootstrapBudget>;
  files: LeanScannedFile[];
  duplicateClusters: DuplicateCluster[];
  proposals: LeanProposal[];
  semanticFixesApplied: LeanSemanticFixChange[];
}): LeanScorecard {
  const critical = params.findings.filter((finding) => finding.severity === "critical").length;
  const warn = params.findings.filter((finding) => finding.severity === "warn").length;
  const info = params.findings.filter((finding) => finding.severity === "info").length;
  const duplicateCount = params.duplicateClusters.filter(
    (cluster) => cluster.kind === "exact",
  ).length;
  const placementCount = params.findings.filter(
    (finding) => finding.kind === "memory-placement",
  ).length;
  const learningCount = params.findings.filter(
    (finding) => finding.kind === "learning-pressure" || finding.kind === "patch-pressure",
  ).length;
  const driftCount = params.findings.filter((finding) => finding.kind === "drift-signal").length;

  const budget = clampScore(
    100 -
      (params.bootstrap.hasTruncation ? 26 : 0) -
      params.bootstrap.nearLimitFiles.length * 4 -
      (params.bootstrap.totalNearLimit ? 8 : 0),
  );
  const density = clampScore(100 - duplicateCount * 9 - warn * 3 - info);
  const drift = clampScore(
    100 -
      driftCount * 12 -
      params.findings.filter((finding) => finding.kind === "mushy-rule").length * 4,
  );
  const placement = clampScore(
    100 -
      placementCount * 8 -
      params.findings.filter((finding) => finding.kind === "stale-bootstrap").length * 8,
  );
  const learning = clampScore(
    100 -
      learningCount * 13 -
      params.proposals.filter((proposal) => proposal.action === "relocate").length * 2,
  );
  const safety = clampScore(
    100 -
      critical * 15 -
      params.findings.filter((finding) => finding.kind === "doctrine-conflict").length * 10 +
      params.semanticFixesApplied.length * 2,
  );
  const overall = clampScore(
    density * 0.23 +
      budget * 0.19 +
      drift * 0.18 +
      placement * 0.16 +
      learning * 0.12 +
      safety * 0.12,
  );

  return {
    overall,
    density,
    budget,
    drift,
    placement,
    learning,
    safety,
  };
}

export async function analyzeLeanWorkspace(params: {
  workspaceDir: string;
  cfg?: Parameters<typeof resolveBootstrapContextForRun>[0]["config"];
  applySafeFixes?: boolean;
}): Promise<LeanReport> {
  const workspaceDir = path.resolve(params.workspaceDir);
  const { bootstrapFiles, contextFiles } = await resolveBootstrapContextForRun({
    workspaceDir,
    config: params.cfg,
  });
  const bootstrap = analyzeBootstrapBudget({
    files: buildBootstrapInjectionStats({
      bootstrapFiles,
      injectedFiles: contextFiles,
    }),
    bootstrapMaxChars: resolveBootstrapMaxChars(params.cfg),
    bootstrapTotalMaxChars: resolveBootstrapTotalMaxChars(params.cfg),
  });

  let { files, memoryMarkdownFiles } = await loadLeanScannedFiles(workspaceDir);
  const safeFixCandidates = files
    .filter((file) => buildSafeFixedContent(file.content).content !== file.content)
    .map((file) => file.relativePath);
  const semanticFixCandidates = listSemanticFixCandidates(files);

  const safeFixesApplied = params.applySafeFixes ? await applySafeFixes(files) : [];
  if (safeFixesApplied.length > 0) {
    ({ files, memoryMarkdownFiles } = await loadLeanScannedFiles(workspaceDir));
  }

  const semanticFixesApplied = params.applySafeFixes ? await applySemanticFixes(files) : [];
  if (semanticFixesApplied.length > 0) {
    ({ files, memoryMarkdownFiles } = await loadLeanScannedFiles(workspaceDir));
  }

  const duplicateClusters = collectDuplicateClusters(files);
  const findings = dedupeFindings([
    ...scanMissingCore(files),
    ...summarizeBootstrapBudget(bootstrap),
    ...scanStaleBootstrap(files, memoryMarkdownFiles),
    ...scanFileOverload(files),
    ...scanDuplicateDoctrine(duplicateClusters),
    ...scanMushyRules(files),
    ...scanDoctrineConflicts(files),
    ...scanMemoryPlacement(files, memoryMarkdownFiles),
    ...scanLearningPressure(files),
    ...scanDriftSignals(files, duplicateClusters),
  ]);

  if (!params.applySafeFixes && safeFixCandidates.length > 0) {
    findings.push({
      kind: "safe-fix",
      severity: "info",
      title: "High-confidence safe fixes are available",
      detail: `${safeFixCandidates.length} file(s) have formatting noise that can be cleaned automatically.`,
      files: safeFixCandidates.slice(0, 8),
      recommendation:
        "Run /lean. It applies formatting-safe cleanup before reporting semantic upgrades.",
    });
  }
  if (!params.applySafeFixes && semanticFixCandidates.length > 0) {
    findings.push({
      kind: "safe-fix",
      severity: "info",
      title: "High-confidence semantic cleanup is available",
      detail: `${semanticFixCandidates.length} narrowly bounded semantic cleanup candidate(s) were detected.`,
      files: semanticFixCandidates.slice(0, 8),
      recommendation:
        "Run /lean. It can remove bootstrap stubs and obvious duplicate lines when confidence is high.",
    });
  }

  const proposals = buildLeanProposals({ findings, duplicateClusters, files });
  const totalChars = files.reduce((sum, file) => sum + file.content.length, 0);
  const scorecard = computeScorecard({
    findings,
    bootstrap,
    files,
    duplicateClusters,
    proposals,
    semanticFixesApplied,
  });

  const severityRank = { critical: 0, warn: 1, info: 2 } as const;
  const sortedFindings = findings
    .toSorted(
      (a, b) =>
        severityRank[a.severity] - severityRank[b.severity] || a.title.localeCompare(b.title),
    )
    .slice(0, MAX_FINDINGS);

  return {
    workspaceDir,
    scannedFiles: files,
    memoryMarkdownFiles,
    bootstrap,
    findings: sortedFindings,
    proposals,
    safeFixCandidates,
    safeFixesApplied,
    semanticFixCandidates,
    semanticFixesApplied,
    totalChars,
    scorecard,
  };
}

function formatHealthLabel(score: number): string {
  if (score >= 94) {
    return "dense and sharp";
  }
  if (score >= 84) {
    return "healthy";
  }
  if (score >= 70) {
    return "pressure rising";
  }
  return "needs consolidation";
}

function formatFindingPrefix(severity: LeanSeverity): string {
  if (severity === "critical") {
    return "!!";
  }
  if (severity === "warn") {
    return "!";
  }
  return "i";
}

function summarizeFixes(changes: LeanFixChange[]): string {
  const trailing = changes.reduce((sum, change) => sum + change.stats.trailingWhitespaceLines, 0);
  const blankRuns = changes.reduce((sum, change) => sum + change.stats.blankRunReductions, 0);
  const leadingBlanks = changes.reduce(
    (sum, change) => sum + change.stats.leadingBlankLinesRemoved,
    0,
  );
  const bomRemoved = changes.filter((change) => change.stats.bomRemoved).length;
  const charDelta = changes.reduce(
    (sum, change) => sum + (change.afterChars - change.beforeChars),
    0,
  );
  const parts = [
    `${changes.length} file(s)`,
    `${formatSignedInt(charDelta)} chars net`,
    `${trailing} trailing-space cleanup`,
  ];
  if (blankRuns > 0) {
    parts.push(`${blankRuns} blank-run collapse`);
  }
  if (leadingBlanks > 0) {
    parts.push(`${leadingBlanks} leading blank lines removed`);
  }
  if (bomRemoved > 0) {
    parts.push(`${bomRemoved} BOM removed`);
  }
  return parts.join(", ");
}

function summarizeSemanticFixes(changes: LeanSemanticFixChange[]): string {
  return changes.map((change) => `${change.path}: ${change.detail}`).join("; ");
}

function formatProposalTag(action: LeanProposalAction, confidence: LeanProposalConfidence): string {
  const tag = action.toUpperCase();
  return confidence === "high" ? `[${tag} HIGH]` : `[${tag} MED]`;
}

export function formatLeanReply(report: LeanReport, opts?: { ignoredInput?: string }): string {
  const critical = report.findings.filter((finding) => finding.severity === "critical").length;
  const warn = report.findings.filter((finding) => finding.severity === "warn").length;
  const info = report.findings.filter((finding) => finding.severity === "info").length;
  const lines = [
    "🪶 Lean",
    `Workspace: ${report.workspaceDir}`,
    `Health: ${report.scorecard.overall}/100, ${formatHealthLabel(report.scorecard.overall)}`,
    `Scorecard: density ${report.scorecard.density}, budget ${report.scorecard.budget}, drift ${report.scorecard.drift}, placement ${report.scorecard.placement}, learning ${report.scorecard.learning}, safety ${report.scorecard.safety}`,
    `Scanned: ${report.scannedFiles.length} markdown files, ${formatInt(report.totalChars)} chars`,
    `Pressure: ${critical} critical, ${warn} warnings, ${info} notes`,
    `Bootstrap: ${report.bootstrap.hasTruncation ? "truncated" : report.bootstrap.totalNearLimit || report.bootstrap.nearLimitFiles.length ? "near limit" : "clean"}`,
  ];

  if (opts?.ignoredInput) {
    lines.push(
      `Note: /lean runs the full pass by default. Ignored extra input: ${opts.ignoredInput}`,
    );
  }

  if (report.safeFixesApplied.length > 0) {
    lines.push(`Auto-applied now, formatting: ${summarizeFixes(report.safeFixesApplied)}`);
    lines.push(
      `Formatting files changed: ${report.safeFixesApplied
        .slice(0, 6)
        .map(
          (change) => `${change.path} (${formatSignedInt(change.afterChars - change.beforeChars)})`,
        )
        .join(", ")}`,
    );
  }

  if (report.semanticFixesApplied.length > 0) {
    lines.push(
      `Auto-applied now, semantic-safe: ${summarizeSemanticFixes(report.semanticFixesApplied)}`,
    );
  } else if (report.semanticFixCandidates.length > 0) {
    lines.push(
      `Semantic-safe opportunities: ${report.semanticFixCandidates.slice(0, 4).join(", ")}`,
    );
  }

  lines.push("");
  if (report.findings.length === 0) {
    lines.push(
      "No sharp edges found. Lean cleaned what it safely could, and the stack looks dense without feeling bloated.",
    );
    lines.push(
      "Safety boundary: only formatting-safe and narrowly bounded semantic cleanup was auto-applied.",
    );
    return lines.join("\n");
  }

  lines.push("Hotspots:");
  for (const finding of report.findings.slice(0, 6)) {
    lines.push(`- ${formatFindingPrefix(finding.severity)} ${finding.title}`);
    lines.push(`  ${finding.detail}`);
    if (finding.recommendation) {
      lines.push(`  Next: ${finding.recommendation}`);
    }
  }

  if (report.proposals.length > 0) {
    lines.push("");
    lines.push("Upgrade moves:");
    for (const proposal of report.proposals.slice(0, 5)) {
      lines.push(`- ${formatProposalTag(proposal.action, proposal.confidence)} ${proposal.title}`);
      lines.push(`  ${proposal.rationale}`);
      if (proposal.suggestion) {
        lines.push(`  Move: ${proposal.suggestion}`);
      }
    }
  }

  lines.push("");
  lines.push(
    "Safety boundary: formatting-safe cleanup and narrowly bounded semantic cleanup were auto-applied. Rewrites, merges, relocations, and deletes beyond that are proposed, not silently executed.",
  );
  return lines.join("\n");
}

export const handleLeanCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const parsed = parseSlashCommandActionArgs(params.command.commandBodyNormalized, "/lean");
  if (parsed.kind === "no-match") {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /lean from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const ignoredInput =
    parsed.kind === "parsed" ? [parsed.action, parsed.args].filter(Boolean).join(" ").trim() : "";

  const report = await analyzeLeanWorkspace({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
    applySafeFixes: true,
  });

  return {
    shouldContinue: false,
    reply: {
      text: formatLeanReply(report, { ignoredInput: ignoredInput || undefined }),
    },
  };
};
