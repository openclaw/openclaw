// src/agents/task-classifier.ts
// NERO task classifier — auto model routing by cognitive load

export type CognitiveLoad = "cheap" | "mid" | "expensive";

export type PatternId =
  | "strategic"
  | "operational"
  | "build"
  | "debug"
  | "research"
  | "triage"
  | "decide"
  | "review"
  | "delegate"
  | "routine";

export type Classification = {
  load: CognitiveLoad;
  pattern: PatternId;
  altitude: "strategic" | "operational" | "tactical";
  confidence: number; // 0-1
  context: {
    isHeartbeat: boolean;
    isCron: boolean;
    cronName?: string;
    isSubagentResult: boolean;
    isUserMessage: boolean;
    hasCodeContext: boolean;
    hasError: boolean;
    taskCount?: number;
  };
};

export type ClassifyInput = {
  promptText: string;
  isHeartbeat?: boolean;
  cronName?: string;
  isSubagentResult?: boolean;
  failedAttempts?: number;
  promptTokens?: number;
  hasCodeBlocks?: boolean;
  filesRead?: number;
};

export function classify(input: ClassifyInput): Classification {
  const {
    promptText = "",
    isHeartbeat = false,
    cronName,
    isSubagentResult = false,
    failedAttempts = 0,
    promptTokens = 0,
    hasCodeBlocks = false,
    filesRead = 0,
  } = input;

  const text = promptText.toLowerCase();

  // --- Context flags ---
  const isCron = Boolean(cronName);
  const isRoutineCron = Boolean(
    cronName?.match(/evening|upstream|memory|heartbeat|maintenance|night/i),
  );
  const hasError = text.includes("error") || text.includes("failed") || text.includes("conflict");
  const hasCodeContext = hasCodeBlocks || filesRead > 0;

  // --- Pattern detection ---
  let pattern: PatternId = "routine";
  let load: CognitiveLoad = "mid";
  let altitude: Classification["altitude"] = "operational";
  let confidence = 0.7;

  // CHEAP: heartbeat / routine cron / tiny prompts
  if (isHeartbeat || isRoutineCron) {
    load = "cheap";
    pattern = "routine";
    altitude = "tactical";
    confidence = 0.95;
  } else if (promptTokens < 200 && !hasCodeBlocks && !isSubagentResult) {
    load = "cheap";
    pattern = "triage";
    altitude = "tactical";
    confidence = 0.6;
  }

  // EXPENSIVE: strategic / complex signals
  else if (
    text.match(
      /\b(architect|refactor|design|strategy|spec|debug|security|think hard|audit|migration|breaking change)\b/,
    ) ||
    failedAttempts >= 2 ||
    filesRead > 5
  ) {
    load = "expensive";
    confidence = 0.85;

    if (text.match(/\b(architect|strategy|spec|design|migration)\b/)) {
      pattern = "strategic";
      altitude = "strategic";
    } else if (text.match(/\b(debug|error|failed|security|audit)\b/) || failedAttempts >= 2) {
      pattern = "debug";
      altitude = "tactical";
    } else if (text.match(/\b(refactor)\b/) || filesRead > 5) {
      pattern = "build";
      altitude = "tactical";
    } else {
      pattern = "research";
      altitude = "operational";
    }
  }

  // MID: everything else
  else {
    load = "mid";
    altitude = "operational";

    if (text.match(/\b(plan|priorit|task|todo|now\.md|next action)\b/)) {
      pattern = "operational";
    } else if (text.match(/\b(build|implement|create|add feature|write code)\b/)) {
      pattern = "build";
    } else if (text.match(/\b(research|investigate|analyze|compare|find)\b/)) {
      pattern = "research";
    } else if (text.match(/\b(review|check|verify|test|qa)\b/) || isSubagentResult) {
      pattern = "review";
      altitude = "tactical";
    } else if (text.match(/\b(decide|choose|option|trade.?off)\b/)) {
      pattern = "decide";
    } else if (text.match(/\b(delegate|spawn|multi.?task|parallel)\b/)) {
      pattern = "delegate";
    } else {
      pattern = "triage";
      confidence = 0.5;
    }
  }

  return {
    load,
    pattern,
    altitude,
    confidence,
    context: {
      isHeartbeat,
      isCron,
      cronName,
      isSubagentResult,
      isUserMessage: !isHeartbeat && !isCron && !isSubagentResult,
      hasCodeContext,
      hasError,
    },
  };
}

/** Map cognitive load to model tier */
export function loadToModelTier(load: CognitiveLoad): "haiku" | "sonnet" | "opus" {
  switch (load) {
    case "cheap":
      return "haiku";
    case "mid":
      return "sonnet";
    case "expensive":
      return "opus";
  }
}
