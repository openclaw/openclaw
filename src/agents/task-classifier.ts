/**
 * Task classifier for dynamic model selection.
 * Analyzes prompts to determine the type of task and select appropriate models.
 */

export type TaskType = "coding" | "tools" | "vision" | "reasoning" | "general";

export type TaskComplexity = "trivial" | "moderate" | "complex";

/**
 * Keywords that indicate a coding-related task.
 */
const CODING_KEYWORDS = [
  // Actions
  "code",
  "implement",
  "write",
  "create",
  "build",
  "develop",
  "program",
  "script",
  // Code structures
  "function",
  "class",
  "method",
  "module",
  "component",
  "interface",
  "type",
  "enum",
  "struct",
  "variable",
  "const",
  "let",
  "var",
  // Operations
  "debug",
  "fix",
  "refactor",
  "optimize",
  "review",
  "test",
  "lint",
  "format",
  "compile",
  "transpile",
  // Languages
  "typescript",
  "javascript",
  "python",
  "rust",
  "go",
  "java",
  "kotlin",
  "swift",
  "c++",
  "c#",
  "ruby",
  "php",
  "scala",
  "elixir",
  "haskell",
  // Frameworks/Tools
  "react",
  "vue",
  "angular",
  "svelte",
  "node",
  "express",
  "fastapi",
  "django",
  "flask",
  "rails",
  "spring",
  "nextjs",
  "nuxt",
  "remix",
  "astro",
  // Development tools
  "git",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "docker",
  "kubernetes",
  "terraform",
  "ansible",
  // Data/API
  "api",
  "rest",
  "graphql",
  "database",
  "sql",
  "nosql",
  "mongodb",
  "postgres",
  "mysql",
  "redis",
  // Patterns
  "bug",
  "error",
  "exception",
  "issue",
  "pull request",
  "pr",
  "commit",
  "merge",
  "branch",
  "repository",
  "repo",
  // File types
  ".ts",
  ".js",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".swift",
  ".cpp",
  ".c",
  ".rb",
  ".php",
];

/**
 * Keywords that indicate a reasoning-heavy task.
 */
const REASONING_KEYWORDS = [
  "analyze",
  "explain",
  "think",
  "reason",
  "consider",
  "evaluate",
  "compare",
  "contrast",
  "plan",
  "design",
  "architect",
  "strategy",
  "decision",
  "tradeoff",
  "trade-off",
  "pros and cons",
  "advantages",
  "disadvantages",
  "implications",
  "consequences",
  "step by step",
  "step-by-step",
  "break down",
  "breakdown",
  "logical",
  "logic",
  "deduce",
  "infer",
  "conclude",
  "hypothesis",
  "theory",
  "proof",
  "prove",
  "derive",
  "derivation",
];

/**
 * Keywords that indicate vision/image-related tasks.
 */
const VISION_KEYWORDS = [
  "image",
  "picture",
  "photo",
  "screenshot",
  "diagram",
  "chart",
  "graph",
  "visual",
  "ui",
  "user interface",
  "design",
  "mockup",
  "wireframe",
  "layout",
  "look at",
  "see",
  "show",
  "display",
  "render",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
];

/**
 * Keywords that indicate a tool/system-operations task (use tools, run commands, inspect logs/status).
 *
 * This is intentionally conservative: "coding" still takes priority when strong coding signals exist.
 */
const TOOLS_KEYWORDS = [
  // Explicit tool intent
  "use tools",
  "use the tools",
  "use openclaw tools",
  "run tool",
  "call tool",
  "tool call",
  // OpenClaw / gateway operations
  "openclaw",
  "gateway",
  "channels status",
  "models status",
  "system.info",
  "status --deep",
  "probe",
  "logs",
  "tail",
  "restart",
  "start",
  "stop",
  "install",
  // Shell/ops verbs and commands
  "execute",
  "run command",
  "shell",
  "terminal",
  "lsof",
  "ps",
  "kill",
  "curl",
  "rg",
  "ripgrep",
  "grep",
  "sed",
  // Homebrew + local services
  "brew",
  "homebrew",
  "brew services",
  "postgres",
  "psql",
  "redis",
  "redis-cli",
  // Filesystem ops
  "read file",
  "edit file",
  "write file",
  "apply patch",
];

/**
 * Score a prompt against a set of keywords.
 */
function scoreKeywords(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();
  let score = 0;
  for (const keyword of keywords) {
    if (lower.includes(keyword.toLowerCase())) {
      // Longer keywords get slightly higher weight
      score += 1 + keyword.length / 20;
    }
  }
  return score;
}

/**
 * Classify a task based on the prompt content.
 * Returns the most likely task type based on keyword analysis.
 */
export function classifyTask(prompt: string): TaskType {
  if (!prompt?.trim()) {
    return "general";
  }

  const lower = prompt.toLowerCase();

  // Check for explicit image/vision indicators first
  // These are strong signals that override other classifications
  const hasImageAttachment =
    lower.includes("[image]") ||
    lower.includes("attached image") ||
    lower.includes("this image") ||
    lower.includes("the image") ||
    /\.(png|jpg|jpeg|gif|webp|svg)\b/i.test(prompt);

  if (hasImageAttachment) {
    return "vision";
  }

  // Tool/system-ops commands are a strong signal and should route to tool models.
  // Keep this early and conservative to avoid stealing real coding prompts.
  const hasToolCommandSignal =
    /\b(openclaw|gateway)\b/.test(lower) ||
    /\b(brew\s+services|lsof|psql|redis-cli|curl|rg|ripgrep|grep|tail)\b/.test(lower);
  if (hasToolCommandSignal) {
    return "tools";
  }

  // Score each category
  const codingScore = scoreKeywords(prompt, CODING_KEYWORDS);
  const toolsScore = scoreKeywords(prompt, TOOLS_KEYWORDS);
  const reasoningScore = scoreKeywords(prompt, REASONING_KEYWORDS);
  const visionScore = scoreKeywords(prompt, VISION_KEYWORDS);

  // Determine thresholds
  const CODING_THRESHOLD = 2.5; // Need multiple coding indicators
  const TOOLS_THRESHOLD = 2.2; // Tooling signals can be shorter/more specific
  const REASONING_THRESHOLD = 2.0; // Reasoning needs slightly less
  const VISION_THRESHOLD = 1.5; // Vision keywords are more specific

  // Check vision first (it's the most specific)
  if (
    visionScore >= VISION_THRESHOLD &&
    visionScore > codingScore &&
    visionScore > toolsScore &&
    visionScore > reasoningScore
  ) {
    return "vision";
  }

  // Tooling tasks: prefer when there is clear ops/tool intent (even if DB keywords are present).
  if (toolsScore >= TOOLS_THRESHOLD && toolsScore >= codingScore && toolsScore >= reasoningScore) {
    return "tools";
  }

  // Coding tasks take priority if score is high enough
  if (codingScore >= CODING_THRESHOLD && codingScore >= reasoningScore) {
    return "coding";
  }

  // Reasoning tasks
  if (reasoningScore >= REASONING_THRESHOLD && reasoningScore > codingScore) {
    return "reasoning";
  }

  // Coding with lower threshold if it's the dominant category
  if (
    codingScore >= 1.5 &&
    codingScore > reasoningScore &&
    codingScore > visionScore &&
    codingScore > toolsScore
  ) {
    return "coding";
  }

  // Tooling with lower threshold if it's the dominant category
  if (
    toolsScore >= 1.5 &&
    toolsScore > reasoningScore &&
    toolsScore > visionScore &&
    toolsScore > codingScore
  ) {
    return "tools";
  }

  return "general";
}

/**
 * Classify a task with confidence scores for each category.
 * Useful for debugging or advanced selection logic.
 */
export function classifyTaskWithScores(prompt: string): {
  type: TaskType;
  scores: {
    coding: number;
    tools: number;
    reasoning: number;
    vision: number;
    general: number;
  };
} {
  const codingScore = scoreKeywords(prompt, CODING_KEYWORDS);
  const toolsScore = scoreKeywords(prompt, TOOLS_KEYWORDS);
  const reasoningScore = scoreKeywords(prompt, REASONING_KEYWORDS);
  const visionScore = scoreKeywords(prompt, VISION_KEYWORDS);

  // General score is inverse of specificity
  const maxScore = Math.max(codingScore, toolsScore, reasoningScore, visionScore, 1);
  const generalScore = 1 / (1 + maxScore * 0.3);

  return {
    type: classifyTask(prompt),
    scores: {
      coding: codingScore,
      tools: toolsScore,
      reasoning: reasoningScore,
      vision: visionScore,
      general: generalScore,
    },
  };
}

/**
 * Check if a prompt appears to be a coding task.
 */
export function isCodingTask(prompt: string): boolean {
  return classifyTask(prompt) === "coding";
}

/**
 * Check if a prompt appears to need vision capabilities.
 */
export function isVisionTask(prompt: string): boolean {
  return classifyTask(prompt) === "vision";
}

/**
 * Check if a prompt appears to need extended reasoning.
 */
export function isReasoningTask(prompt: string): boolean {
  return classifyTask(prompt) === "reasoning";
}

function countMatches(textLower: string, patterns: RegExp[]): number {
  let count = 0;
  for (const pattern of patterns) {
    if (pattern.test(textLower)) {
      count += 1;
    }
  }
  return count;
}

/**
 * Classify task complexity (trivial/moderate/complex) for model routing.
 *
 * Heuristics are intentionally simple and deterministic:
 * - trivial: short prompt with a single intent and few constraints
 * - complex: long prompt, multi-step, or many constraints/requirements
 * - moderate: everything else
 */
export function classifyComplexity(prompt: string): TaskComplexity {
  const raw = prompt?.trim() ?? "";
  if (!raw) {
    return "trivial";
  }

  const lower = raw.toLowerCase();
  const len = raw.length;

  const workSignals = countMatches(lower, [
    /\b(improve|rewrite|revise|edit|polish)\b/,
    /\b(explain)\b/,
    /\b(draft|email|proposal|report|document)\b/,
    /\b(algorithm|memoization|memoize|recursion|recursive|dynamic programming)\b/,
    /\b(calculate|compute|parse|transform|convert)\b/,
  ]);

  // Strong signals of multi-step/constraint-heavy requests.
  const complexSignals = countMatches(lower, [
    /\b(step[- ]by[- ]step|steps|plan|roadmap)\b/,
    /\b(architecture|architect|design)\b/,
    /\b(migrate|migration|refactor|rewrite)\b/,
    /\b(performance|latency|throughput|scale|scalability)\b/,
    /\b(security|threat|vulnerability|auth|oauth)\b/,
    /\b(backward compatibility|back-compat|compatibility)\b/,
    /\b(do not break|without breaking|must not)\b/,
    /\b(tradeoff|trade-off|pros and cons)\b/,
    /\b(test plan|add tests|coverage|e2e)\b/,
    /\b(multi[- ]agent|concurrency|race condition|deadlock)\b/,
  ]);

  // Count "constraint-like" words; 3+ tends to mean non-trivial.
  const constraintSignals = countMatches(lower, [
    /\b(must|should|ensure|guarantee|required|constraint|constraints)\b/,
    /\b(only if|unless|except|edge case|corner case)\b/,
    /\b(prefer|avoid|never|always)\b/,
  ]);

  const hasListyStructure =
    /\n\s*[-*]\s+/.test(raw) || /\n\s*\d+\.\s+/.test(raw) || /\b(first|second|third)\b/.test(lower);

  // "Complex" if long, multi-step, or heavily constrained.
  if (
    len >= 900 ||
    complexSignals >= 2 ||
    (hasListyStructure && (len >= 350 || constraintSignals >= 2))
  ) {
    return "complex";
  }
  if (len >= 450 && (complexSignals >= 1 || constraintSignals >= 2)) {
    return "complex";
  }

  // "Trivial" if very short and not constraint heavy.
  if (len <= 140 && complexSignals === 0 && constraintSignals === 0 && workSignals === 0) {
    return "trivial";
  }
  if (
    len <= 220 &&
    complexSignals === 0 &&
    constraintSignals <= 1 &&
    workSignals === 0 &&
    !hasListyStructure
  ) {
    return "trivial";
  }

  return "moderate";
}
