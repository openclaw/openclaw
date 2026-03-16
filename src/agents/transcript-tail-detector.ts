export type TranscriptTailEntry = {
  id?: string;
  role?: string;
  kind?: string;
  text?: string;
  toolName?: string;
  toolStatus?: string;
  errorText?: string;
  isError?: boolean;
};

export type TranscriptTailSignal = {
  repeatedToolFailures: Array<{
    signature: string;
    count: number;
    lastSeenEntryId?: string;
  }>;
  duplicateAssistantClusters: number;
  staleSystemRecurrences: number;
  noGroundedReplyTurns: number;
};

const STALE_SYSTEM_EXEMPT_PREFIXES = [
  "[Post-compaction context refresh]",
  "Session was just compacted.",
  "Critical rules from AGENTS.md:",
  "Injected sections from AGENTS.md",
] as const;

const DIRECTIVE_TEXT_PATTERN =
  /\b(always|avoid|critical|directive|do not|don't|follow|important|instruction|must|never|note|remember|reminder|required|rule|should)\b/;

export function detectTranscriptTailSignals(
  entries: readonly TranscriptTailEntry[],
): TranscriptTailSignal {
  return {
    repeatedToolFailures: collectRepeatedToolFailures(entries),
    duplicateAssistantClusters: countDuplicateAssistantClusters(entries),
    staleSystemRecurrences: countStaleSystemRecurrences(entries),
    noGroundedReplyTurns: countTrailingUserTurnsWithoutReply(entries),
  };
}

function collectRepeatedToolFailures(
  entries: readonly TranscriptTailEntry[],
): TranscriptTailSignal["repeatedToolFailures"] {
  const groupedFailures = new Map<
    string,
    { signature: string; count: number; lastSeenEntryId?: string }
  >();

  for (const entry of entries) {
    const signature = getToolFailureSignature(entry);

    if (!signature) {
      continue;
    }

    const current = groupedFailures.get(signature);

    if (current) {
      current.count += 1;
      current.lastSeenEntryId = entry.id ?? current.lastSeenEntryId;
      continue;
    }

    groupedFailures.set(signature, {
      signature,
      count: 1,
      lastSeenEntryId: entry.id,
    });
  }

  return [...groupedFailures.values()].filter(({ count }) => count > 1);
}

function getToolFailureSignature(entry: TranscriptTailEntry): string | undefined {
  if (!isToolFailureEntry(entry)) {
    return undefined;
  }

  const toolName = normalizeComparableText(entry.toolName) || "unknown-tool";
  const rawErrorText = entry.errorText ?? entry.text ?? "error";
  const errorSignature = normalizeFailureSignature(rawErrorText) || "error";

  return `${toolName}: ${errorSignature}`;
}

function isToolFailureEntry(entry: TranscriptTailEntry): boolean {
  const normalizedRole = normalizeToken(entry.role);
  const normalizedKind = normalizeToken(entry.kind);
  const hasToolIdentity =
    hasNonEmptyText(entry.toolName) ||
    normalizedRole === "toolresult" ||
    normalizedKind.includes("tool");

  if (!hasToolIdentity) {
    return false;
  }

  return (
    entry.isError === true ||
    normalizeToken(entry.toolStatus) === "error" ||
    hasNonEmptyText(entry.errorText)
  );
}

function countDuplicateAssistantClusters(entries: readonly TranscriptTailEntry[]): number {
  const seenAssistantReplies = new Map<string, number>();
  let duplicateClusters = 0;

  for (const entry of entries) {
    if (normalizeToken(entry.role) !== "assistant") {
      continue;
    }

    const normalizedText = normalizeComparableText(entry.text);

    if (!normalizedText) {
      continue;
    }

    const previousCount = seenAssistantReplies.get(normalizedText) ?? 0;

    if (previousCount >= 1) {
      duplicateClusters += 1;
    }

    seenAssistantReplies.set(normalizedText, previousCount + 1);
  }

  return duplicateClusters;
}

function countStaleSystemRecurrences(entries: readonly TranscriptTailEntry[]): number {
  const seenSystemTexts = new Map<string, number>();
  let staleRecurrences = 0;

  for (const entry of entries) {
    if (!isSystemLikeEntry(entry)) {
      continue;
    }

    const text = entry.text?.trim();

    if (!text || isLegitimateReinjectionText(text)) {
      continue;
    }

    if (!isDirectiveLikeSystemText(text, entry.kind)) {
      continue;
    }

    const normalizedText = normalizeComparableText(text);
    const previousCount = seenSystemTexts.get(normalizedText) ?? 0;

    if (previousCount >= 1) {
      staleRecurrences += 1;
    }

    seenSystemTexts.set(normalizedText, previousCount + 1);
  }

  return staleRecurrences;
}

function isSystemLikeEntry(entry: TranscriptTailEntry): boolean {
  const normalizedRole = normalizeToken(entry.role);
  const normalizedKind = normalizeToken(entry.kind);

  return (
    normalizedRole === "system" ||
    normalizedKind.includes("system") ||
    normalizedKind.includes("reminder")
  );
}

function isLegitimateReinjectionText(text: string): boolean {
  const trimmed = text.trimStart();

  if (STALE_SYSTEM_EXEMPT_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
    return true;
  }

  return trimmed.split(/\r?\n/u).some((line) => line.trimStart().startsWith("Current time:"));
}

function isDirectiveLikeSystemText(text: string, kind?: string): boolean {
  const normalizedKind = normalizeToken(kind);

  if (normalizedKind.includes("reminder") || normalizedKind.includes("directive")) {
    return true;
  }

  return DIRECTIVE_TEXT_PATTERN.test(text.toLowerCase());
}

function countTrailingUserTurnsWithoutReply(entries: readonly TranscriptTailEntry[]): number {
  let trailingUserTurns = 0;

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const normalizedRole = normalizeToken(entry.role);

    if (normalizedRole === "assistant" && hasNonEmptyText(entry.text)) {
      break;
    }

    if (normalizedRole === "user" && hasNonEmptyText(entry.text)) {
      trailingUserTurns += 1;
    }
  }

  return trailingUserTurns;
}

function normalizeFailureSignature(text: string): string {
  return normalizeComparableText(
    text
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu, "<id>")
      .replace(/\b0x[0-9a-f]+\b/giu, "<hex>")
      .replace(/\b[a-f0-9]{12,}\b/giu, "<id>")
      .replace(/\b\d{2,}\b/gu, "<num>"),
  );
}

function normalizeComparableText(value?: string): string {
  return normalizeToken(value).replace(/\s+/gu, " ").trim();
}

function normalizeToken(value?: string): string {
  return value?.toLowerCase().trim() ?? "";
}

function hasNonEmptyText(value?: string): boolean {
  return normalizeComparableText(value).length > 0;
}
