import { readCompletedFileMutationDelta } from "../agents/file-mutation-args.js";
import { resolveFileMutationToolName } from "../agents/tool-mutation-names.js";
import type { ChannelProgressDraftLocale } from "../config/types.base.js";

export type { ChannelProgressDraftLocale } from "../config/types.base.js";

const MAX_TRACKED_MUTATION_FILES = 256;
const MAX_PENDING_MUTATION_DIFFS = 64;

type PendingMutationDelta = NonNullable<ReturnType<typeof readCompletedFileMutationDelta>>;

export type ChannelProgressDraftDiffStat = Readonly<{
  files: number;
  added: number;
  removed: number;
}>;

function formatRussianCount(
  count: number,
  forms: readonly [one: string, few: string, many: string],
): string {
  const absolute = Math.abs(count);
  const lastTwo = absolute % 100;
  const last = absolute % 10;
  const form =
    lastTwo >= 11 && lastTwo <= 14
      ? forms[2]
      : last === 1
        ? forms[0]
        : last >= 2 && last <= 4
          ? forms[1]
          : forms[2];
  return `${count} ${form}`;
}

export function formatChannelProgressDraftDiffStat(
  diffStat: ChannelProgressDraftDiffStat | undefined,
  locale?: ChannelProgressDraftLocale,
): string | undefined {
  if (!diffStat || (diffStat.files === 0 && diffStat.added === 0 && diffStat.removed === 0)) {
    return undefined;
  }
  if (locale === "ru") {
    const files = formatRussianCount(diffStat.files, ["файл", "файла", "файлов"]);
    const added = formatRussianCount(diffStat.added, ["строка", "строки", "строк"]);
    const removed = formatRussianCount(diffStat.removed, ["строка", "строки", "строк"]);
    return `📝 Изменено ${files}: добавлено ${added}, удалено ${removed}`;
  }
  return [
    `📝 ${diffStat.files} files`,
    ...(diffStat.added > 0 ? [`+${diffStat.added}`] : []),
    ...(diffStat.removed > 0 ? [`−${diffStat.removed}`] : []),
  ].join(" ");
}

export function createProgressDraftDiffStatTracker(params: { canStage: () => boolean }) {
  let hasCommittedDiff = false;
  let mutationFiles = new Set<string>();
  let mutationOverflowFiles = 0;
  let mutationAdded = 0;
  let mutationRemoved = 0;
  let pendingMutationDiffs = new Map<string, PendingMutationDelta>();

  const reset = () => {
    hasCommittedDiff = false;
    mutationFiles = new Set();
    mutationOverflowFiles = 0;
    mutationAdded = 0;
    mutationRemoved = 0;
    pendingMutationDiffs = new Map();
  };

  const stageToolEvent = (payload: {
    toolCallId?: string;
    name?: string;
    phase?: string;
    args?: Record<string, unknown>;
  }) => {
    if (!params.canStage()) {
      return;
    }
    const toolCallId = payload.toolCallId?.trim();
    if (payload.phase !== "start" || !toolCallId || !payload.name || !payload.args) {
      return;
    }
    const kind = resolveFileMutationToolName(payload.name);
    const delta = kind ? readCompletedFileMutationDelta(kind, payload.args) : undefined;
    if (!delta) {
      return;
    }
    if (
      !pendingMutationDiffs.has(toolCallId) &&
      pendingMutationDiffs.size >= MAX_PENDING_MUTATION_DIFFS
    ) {
      return;
    }
    pendingMutationDiffs.set(toolCallId, delta);
  };

  const commitItemEvent = (payload: { toolCallId?: string; phase?: string; status?: string }) => {
    const toolCallId = payload.toolCallId?.trim();
    if (!toolCallId || payload.phase !== "end") {
      return;
    }
    const delta = pendingMutationDiffs.get(toolCallId);
    if (!delta) {
      return;
    }
    pendingMutationDiffs.delete(toolCallId);
    const status = payload.status?.trim().toLowerCase();
    if (status !== "completed") {
      return;
    }
    hasCommittedDiff = true;
    mutationAdded += delta.added;
    mutationRemoved += delta.removed;
    for (const file of delta.files) {
      if (mutationFiles.has(file)) {
        continue;
      }
      if (mutationFiles.size < MAX_TRACKED_MUTATION_FILES) {
        mutationFiles.add(file);
        continue;
      }
      // Overflow keeps file-count memory bounded. Repeated paths beyond the
      // tracked window may count again, while line totals remain authoritative.
      mutationOverflowFiles += 1;
    }
  };

  const resolve = (): ChannelProgressDraftDiffStat | undefined =>
    hasCommittedDiff
      ? {
          files: mutationFiles.size + mutationOverflowFiles,
          added: mutationAdded,
          removed: mutationRemoved,
        }
      : undefined;

  return {
    stageToolEvent,
    commitItemEvent,
    resolve,
    reset,
  };
}
