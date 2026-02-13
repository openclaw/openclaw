/**
 * Git History Service for AgentHQ
 * Parses git history for workspace directories to track agent evolution.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitCommitFile = {
  name: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
};

export type GitCommitEntry = {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  authorEmail: string;
  timestamp: number;
  files: GitCommitFile[];
};

export type GitHistoryOptions = {
  workspacePath: string;
  fileFilter?: string[];
  limit?: number;
  offset?: number;
  since?: string;
  until?: string;
};

export type GitHistoryResult = {
  commits: GitCommitEntry[];
  hasMore: boolean;
  totalCount: number;
};

export type GitDiffHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: Array<{ type: "context" | "add" | "remove"; content: string }>;
};

export type GitDiffResult = {
  sha: string;
  fileName: string;
  before: string | null;
  after: string | null;
  hunks: GitDiffHunk[];
};

export type GitActivityDay = {
  date: string;
  count: number;
  magnitude: number;
  files: string[];
};

export type GitStatsResult = {
  totalCommits: number;
  filesChanged: Record<string, number>;
  activityByDay: GitActivityDay[];
  lastChangeAt: number | null;
  firstChangeAt: number | null;
};

/**
 * Check if a directory is a git repository
 */
export async function isGitRepository(dirPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", dirPath, "rev-parse", "--git-dir"], {
      timeout: 5000,
    });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Get the git root directory for a path
 */
export async function getGitRoot(dirPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", dirPath, "rev-parse", "--show-toplevel"], {
      timeout: 5000,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Parse git log output with numstat
 */
function parseGitLogOutput(output: string): GitCommitEntry[] {
  const commits: GitCommitEntry[] = [];
  const lines = output.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line || !line.startsWith("commit:")) {
      i++;
      continue;
    }

    // Parse commit header: commit:sha|timestamp|author|email|message
    const parts = line.substring(7).split("|");
    if (parts.length < 5) {
      i++;
      continue;
    }

    const [sha, timestampStr, author, authorEmail, ...messageParts] = parts;
    const message = messageParts.join("|");
    const timestamp = parseInt(timestampStr, 10) * 1000;

    const entry: GitCommitEntry = {
      sha,
      shortSha: sha.substring(0, 7),
      message: message.trim(),
      author,
      authorEmail,
      timestamp,
      files: [],
    };

    // Parse numstat lines (additions\tdeletions\tfilename)
    i++;
    while (i < lines.length && lines[i] && !lines[i].startsWith("commit:")) {
      const numstatLine = lines[i].trim();
      if (numstatLine) {
        const match = numstatLine.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
        if (match) {
          const additions = match[1] === "-" ? 0 : parseInt(match[1], 10);
          const deletions = match[2] === "-" ? 0 : parseInt(match[2], 10);
          const fileName = match[3];

          let status: GitCommitFile["status"] = "modified";
          if (additions > 0 && deletions === 0) {
            status = "added";
          } else if (additions === 0 && deletions > 0) {
            status = "deleted";
          }

          entry.files.push({
            name: path.basename(fileName),
            status,
            additions,
            deletions,
          });
        }
      }
      i++;
    }

    if (entry.files.length > 0) {
      commits.push(entry);
    }
  }

  return commits;
}

/**
 * Get git history for a workspace directory
 */
export async function getGitHistory(options: GitHistoryOptions): Promise<GitHistoryResult> {
  const { workspacePath, fileFilter, limit = 100, offset = 0, since, until } = options;

  const gitRoot = await getGitRoot(workspacePath);
  if (!gitRoot) {
    return { commits: [], hasMore: false, totalCount: 0 };
  }

  // Build the relative path from git root
  const relativePath = path.relative(gitRoot, workspacePath);

  // Build git log command
  const args = [
    "-C",
    gitRoot,
    "log",
    `--format=commit:%H|%at|%an|%ae|%s`,
    "--numstat",
    `-n`,
    String(limit + 1), // Get one extra to check if there are more
  ];
  if (offset > 0) {
    args.push(`--skip=${offset}`);
  }

  if (since) {
    args.push(`--since=${since}`);
  }
  if (until) {
    args.push(`--until=${until}`);
  }

  // Add path filter
  args.push("--");
  if (fileFilter && fileFilter.length > 0) {
    for (const filter of fileFilter) {
      args.push(path.join(relativePath, filter));
    }
  } else {
    args.push(relativePath);
  }

  try {
    const { stdout } = await execFileAsync("git", args, {
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    });

    const commits = parseGitLogOutput(stdout);
    const hasMore = commits.length > limit;
    const resultCommits = hasMore ? commits.slice(0, limit) : commits;

    return {
      commits: resultCommits,
      hasMore,
      totalCount: resultCommits.length,
    };
  } catch (error) {
    console.error("Git history error:", error);
    return { commits: [], hasMore: false, totalCount: 0 };
  }
}

/**
 * Get diff for a specific commit and file
 */
export async function getGitDiff(
  workspacePath: string,
  sha: string,
  fileName: string,
): Promise<GitDiffResult | null> {
  const gitRoot = await getGitRoot(workspacePath);
  if (!gitRoot) {
    return null;
  }

  const relativePath = path.relative(gitRoot, workspacePath);
  const filePath = path.join(relativePath, fileName);

  try {
    // Get the file content before and after
    let before: string | null = null;
    let after: string | null = null;

    // Get content before (parent commit)
    try {
      const { stdout: beforeContent } = await execFileAsync(
        "git",
        ["-C", gitRoot, "show", `${sha}^:${filePath}`],
        { timeout: 10000 },
      );
      before = beforeContent;
    } catch {
      // File didn't exist before
    }

    // Get content after
    try {
      const { stdout: afterContent } = await execFileAsync(
        "git",
        ["-C", gitRoot, "show", `${sha}:${filePath}`],
        { timeout: 10000 },
      );
      after = afterContent;
    } catch {
      // File was deleted
    }

    // Get the diff
    const { stdout: diffOutput } = await execFileAsync(
      "git",
      ["-C", gitRoot, "diff", `${sha}^..${sha}`, "--", filePath],
      { timeout: 10000 },
    );

    const hunks = parseDiffOutput(diffOutput);

    return {
      sha,
      fileName,
      before,
      after,
      hunks,
    };
  } catch (error) {
    console.error("Git diff error:", error);
    return null;
  }
}

/**
 * Parse diff output into hunks
 */
function parseDiffOutput(diffOutput: string): GitDiffHunk[] {
  const hunks: GitDiffHunk[] = [];
  const lines = diffOutput.split("\n");
  let currentHunk: GitDiffHunk | null = null;

  for (const line of lines) {
    // Match hunk header: @@ -oldStart,oldLines +newStart,newLines @@
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      if (currentHunk) {
        hunks.push(currentHunk);
      }
      currentHunk = {
        oldStart: parseInt(hunkMatch[1], 10),
        oldLines: parseInt(hunkMatch[2] ?? "1", 10),
        newStart: parseInt(hunkMatch[3], 10),
        newLines: parseInt(hunkMatch[4] ?? "1", 10),
        lines: [],
      };
      continue;
    }

    if (currentHunk) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        currentHunk.lines.push({ type: "add", content: line.substring(1) });
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        currentHunk.lines.push({ type: "remove", content: line.substring(1) });
      } else if (line.startsWith(" ")) {
        currentHunk.lines.push({ type: "context", content: line.substring(1) });
      }
    }
  }

  if (currentHunk) {
    hunks.push(currentHunk);
  }

  return hunks;
}

/**
 * Get statistics for git history
 */
export async function getGitStats(options: GitHistoryOptions): Promise<GitStatsResult> {
  const history = await getGitHistory({ ...options, limit: 1000 });

  const filesChanged: Record<string, number> = {};
  const activityMap = new Map<string, GitActivityDay>();
  let lastChangeAt: number | null = null;
  let firstChangeAt: number | null = null;

  for (const commit of history.commits) {
    // Track first and last changes
    if (lastChangeAt === null || commit.timestamp > lastChangeAt) {
      lastChangeAt = commit.timestamp;
    }
    if (firstChangeAt === null || commit.timestamp < firstChangeAt) {
      firstChangeAt = commit.timestamp;
    }

    // Track files changed
    for (const file of commit.files) {
      filesChanged[file.name] = (filesChanged[file.name] ?? 0) + 1;
    }

    // Track activity by day
    const date = new Date(commit.timestamp).toISOString().split("T")[0];
    const existing = activityMap.get(date);
    const magnitude = commit.files.reduce((sum, f) => sum + f.additions + f.deletions, 0);
    const fileNames = commit.files.map((f) => f.name);

    if (existing) {
      existing.count += 1;
      existing.magnitude += magnitude;
      for (const name of fileNames) {
        if (!existing.files.includes(name)) {
          existing.files.push(name);
        }
      }
    } else {
      activityMap.set(date, {
        date,
        count: 1,
        magnitude,
        files: fileNames,
      });
    }
  }

  // Sort activity by date
  const activityByDay = Array.from(activityMap.values()).toSorted((a, b) =>
    a.date.localeCompare(b.date),
  );

  return {
    totalCommits: history.commits.length,
    filesChanged,
    activityByDay,
    lastChangeAt,
    firstChangeAt,
  };
}

/**
 * Get file content at a specific commit
 */
export async function getFileAtCommit(
  workspacePath: string,
  sha: string,
  fileName: string,
): Promise<string | null> {
  const gitRoot = await getGitRoot(workspacePath);
  if (!gitRoot) {
    return null;
  }

  const relativePath = path.relative(gitRoot, workspacePath);
  const filePath = path.join(relativePath, fileName);

  try {
    const { stdout } = await execFileAsync("git", ["-C", gitRoot, "show", `${sha}:${filePath}`], {
      timeout: 10000,
    });
    return stdout;
  } catch {
    return null;
  }
}
