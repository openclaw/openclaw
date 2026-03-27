import fs from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";
import { withFileLock, type FileLockOptions } from "../plugin-sdk/file-lock.js";
import { parseQueue, type ParsedQueue, type QueueEntry } from "./queue-parser.js";

/** Lock options tuned for queue operations: 3 retries with exponential backoff, 60s stale. */
export const QUEUE_LOCK_OPTIONS: FileLockOptions = {
  retries: {
    retries: 3,
    factor: 2,
    minTimeout: 50,
    maxTimeout: 200,
    randomize: true,
  },
  stale: 60_000,
};

export class QueueLockError extends Error {
  constructor(projectDir: string) {
    super(`Queue lock timeout for ${projectDir}`);
    this.name = "QueueLockError";
  }
}

export class QueueValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueValidationError";
  }
}

export type QueueSection = "available" | "claimed" | "done" | "blocked";

const SECTION_HEADINGS: Record<QueueSection, string> = {
  available: "Available",
  claimed: "Claimed",
  done: "Done",
  blocked: "Blocked",
};

/** Serialize a ParsedQueue back to markdown, round-tripping with parseQueue. */
export function serializeQueue(parsed: ParsedQueue): string {
  let out = "";

  // Frontmatter
  if (parsed.frontmatter) {
    const yamlStr = yaml.stringify(parsed.frontmatter, { schema: "core" });
    out += `---\n${yamlStr}---\n`;
  }

  // Sections in canonical order
  const sections: QueueSection[] = ["available", "claimed", "done", "blocked"];
  for (const section of sections) {
    out += `\n## ${SECTION_HEADINGS[section]}\n`;
    const entries: QueueEntry[] = parsed[section];
    if (entries.length > 0) {
      out += "\n";
      for (const entry of entries) {
        out += serializeEntry(entry);
      }
    }
  }

  return out;
}

/** Format a single queue entry as a markdown list item. */
function serializeEntry(entry: QueueEntry): string {
  const keys = Object.keys(entry.metadata);
  if (keys.length === 0) {
    return `- ${entry.taskId}\n`;
  }
  const pairs = keys.map((k) => `${k}: ${entry.metadata[k]}`).join(", ");
  return `- ${entry.taskId} [${pairs}]\n`;
}

/**
 * Find and remove a task from a section, returning the entry.
 * Throws QueueValidationError if the task is not found.
 */
function takeEntry(
  entries: QueueEntry[],
  taskId: string,
  sectionName: string,
): { entry: QueueEntry; remaining: QueueEntry[] } {
  const idx = entries.findIndex((e) => e.taskId === taskId);
  if (idx === -1) {
    throw new QueueValidationError(
      `Task ${taskId} not found in ${sectionName} section`,
    );
  }
  const entry = entries[idx];
  const remaining = [...entries.slice(0, idx), ...entries.slice(idx + 1)];
  return { entry, remaining };
}

/**
 * Manages concurrent access to a project's queue.md file.
 * All mutating methods hold a file lock for the entire read-modify-write cycle
 * and validate persistence by re-reading after write.
 */
export class QueueManager {
  private readonly queuePath: string;

  constructor(private readonly projectDir: string) {
    this.queuePath = path.join(projectDir, "queue.md");
  }

  /** Read and parse queue.md without acquiring a lock. */
  async readQueue(): Promise<ParsedQueue> {
    const content = await fs.readFile(this.queuePath, "utf8");
    return parseQueue(content, this.queuePath);
  }

  /**
   * Lock-protected read-modify-write with post-write validation.
   * Catches file-lock timeout errors and wraps them as QueueLockError.
   */
  private async lockedWriteOp(
    op: (parsed: ParsedQueue) => ParsedQueue,
    validationCheck: (result: ParsedQueue) => void,
  ): Promise<void> {
    try {
      await withFileLock(this.queuePath, QUEUE_LOCK_OPTIONS, async () => {
        // Read
        const content = await fs.readFile(this.queuePath, "utf8");
        const parsed = parseQueue(content, this.queuePath);

        // Modify
        const updated = op(parsed);

        // Update frontmatter timestamp
        if (updated.frontmatter) {
          updated.frontmatter.updated = new Date().toISOString().split("T")[0];
        }

        // Write
        const serialized = serializeQueue(updated);
        await fs.writeFile(this.queuePath, serialized, "utf8");

        // Re-read and validate persistence
        const reReadContent = await fs.readFile(this.queuePath, "utf8");
        const reRead = parseQueue(reReadContent, this.queuePath);
        validationCheck(reRead);
      });
    } catch (err) {
      // Rethrow known error types as-is
      if (err instanceof QueueValidationError || err instanceof QueueLockError) {
        throw err;
      }
      // Wrap file-lock timeout errors
      if (err instanceof Error && err.message.includes("file lock timeout")) {
        throw new QueueLockError(this.projectDir);
      }
      throw err;
    }
  }

  /** Move a task from Available to Claimed with agent metadata. */
  async claimTask(taskId: string, agentId: string): Promise<void> {
    await this.lockedWriteOp(
      (parsed) => {
        const { entry, remaining } = takeEntry(parsed.available, taskId, "Available");
        return {
          ...parsed,
          available: remaining,
          claimed: [
            ...parsed.claimed,
            {
              taskId: entry.taskId,
              metadata: {
                ...entry.metadata,
                agent: agentId,
                claimed: new Date().toISOString(),
              },
            },
          ],
        };
      },
      (reRead) => {
        if (!reRead.claimed.some((e) => e.taskId === taskId)) {
          throw new QueueValidationError(
            `Post-write validation failed: ${taskId} not found in Claimed`,
          );
        }
      },
    );
  }

  /** Move a task from Claimed back to Available, stripping agent metadata. */
  async releaseTask(taskId: string): Promise<void> {
    await this.lockedWriteOp(
      (parsed) => {
        const { entry, remaining } = takeEntry(parsed.claimed, taskId, "Claimed");
        // Strip agent and claimed keys from metadata
        const { agent: _a, claimed: _c, ...cleanMeta } = entry.metadata;
        return {
          ...parsed,
          claimed: remaining,
          available: [
            ...parsed.available,
            { taskId: entry.taskId, metadata: cleanMeta },
          ],
        };
      },
      (reRead) => {
        if (!reRead.available.some((e) => e.taskId === taskId)) {
          throw new QueueValidationError(
            `Post-write validation failed: ${taskId} not found in Available`,
          );
        }
      },
    );
  }

  /** Move a task between arbitrary sections. */
  async moveTask(
    taskId: string,
    fromSection: QueueSection,
    toSection: QueueSection,
  ): Promise<void> {
    await this.lockedWriteOp(
      (parsed) => {
        const { entry, remaining } = takeEntry(
          parsed[fromSection],
          taskId,
          SECTION_HEADINGS[fromSection],
        );
        return {
          ...parsed,
          [fromSection]: remaining,
          [toSection]: [...parsed[toSection], entry],
        };
      },
      (reRead) => {
        if (!reRead[toSection].some((e) => e.taskId === taskId)) {
          throw new QueueValidationError(
            `Post-write validation failed: ${taskId} not found in ${SECTION_HEADINGS[toSection]}`,
          );
        }
      },
    );
  }
}
