/** Publicly stable limits for private per-job scratch content. */
export const CRON_JOB_SCRATCH_MAX_BYTES = 256 * 1024;

type CronJobScratch = {
  content: string;
  revision: number;
  sourceSha256?: string;
  updatedAtMs: number;
};

/** An unset retains its revision tombstone so stale writers cannot resurrect content. */
export type CronJobScratchState = {
  currentRevision: number;
  scratch?: CronJobScratch;
};

export type CronScratchReadCommand = {
  type: "cron.scratch";
  storeKey: string;
  selector: { kind: "job"; jobId: string; createdAtMsFallback: number };
};

export type CronScratchSnapshot = {
  jobId: string;
  state: CronJobScratchState;
  configRevision?: string;
};

export type CronJobScratchWriteResult =
  | { ok: true; currentRevision: number; scratch?: CronJobScratch }
  | { ok: false; reason: "revision-conflict"; currentRevision: number };

export type CronJobScratchWriteInput = {
  storeKey: string;
  jobId: string;
  content: string | null;
  expectedRevision?: number;
  sourceSha256?: string;
  nowMs: number;
};

export type CronJobScratchWriteOutcome = {
  result: CronJobScratchWriteResult;
  written: boolean;
};

function stripLeadingHtmlCommentScaffolding(
  line: string,
  state: { inHtmlComment: boolean },
): string {
  let remaining = line;
  while (state.inHtmlComment || remaining.trimStart().startsWith("<!--")) {
    const searchText = state.inHtmlComment ? remaining : remaining.trimStart();
    const commentEnd = searchText.indexOf("-->");
    if (commentEnd === -1) {
      state.inHtmlComment = true;
      return "";
    }

    state.inHtmlComment = false;
    if (searchText === remaining) {
      remaining = remaining.slice(commentEnd + 3);
    } else {
      const leadingWidth = remaining.length - searchText.length;
      remaining = remaining.slice(0, leadingWidth) + searchText.slice(commentEnd + 3);
    }
  }
  return remaining;
}

/** Missing scratch runs; an explicitly empty checklist does not. */
export function isCronScratchEffectivelyEmpty(content: string | undefined | null): boolean {
  if (typeof content !== "string") {
    return false;
  }

  const state = { inHtmlComment: false };
  for (const line of content.split("\n")) {
    const trimmed = stripLeadingHtmlCommentScaffolding(line, state).trim();
    if (
      !trimmed ||
      /^#+(\s|$)/.test(trimmed) ||
      /^[-*+]\s*(\[[\sXx]?\]\s*)?$/.test(trimmed) ||
      /^```[A-Za-z0-9_-]*$/.test(trimmed)
    ) {
      continue;
    }
    return false;
  }
  return true;
}

export function assertCronJobScratchContent(content: string): void {
  const sizeBytes = Buffer.byteLength(content, "utf8");
  if (sizeBytes > CRON_JOB_SCRATCH_MAX_BYTES) {
    throw new Error(
      `cron scratch exceeds ${CRON_JOB_SCRATCH_MAX_BYTES} bytes (${sizeBytes} bytes provided)`,
    );
  }
}
