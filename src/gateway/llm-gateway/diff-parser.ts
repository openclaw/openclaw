/**
 * Diff-Only Response System
 *
 * Parses unified diff format, validates patches, and calculates risk scores
 */

// Type definitions
export interface DiffLine {
  type: "add" | "remove" | "context";
  content: string;
  lineNumber: number;
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface ParsedDiff {
  hunks: DiffHunk[];
  files: string[];
  additions: number;
  deletions: number;
  riskScore: number;
}

// Unified diff regex patterns
const HUNK_HEADER_REGEX = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const FILE_HEADER_REGEX = /^--- (a\/)?(.+)$/;
const NEW_FILE_HEADER_REGEX = /^\+\+\+ (b\/)?(.+)$/;

/**
 * Parse unified diff format into structured data
 */
export function parseDiff(diffText: string): ParsedDiff {
  const lines = diffText.split("\n");
  const hunks: DiffHunk[] = [];
  const files: string[] = [];
  let additions = 0;
  let deletions = 0;
  let _currentHunk: unknown = null;
  let currentFile: string | null = null;
  let lineNumber = 0;

  for (const line of lines) {
    // File header (old)
    const fileMatch = line.match(FILE_HEADER_REGEX);
    if (fileMatch) {
      const fileName = fileMatch[2];
      if (!currentFile || currentFile !== fileName) {
        currentFile = fileName;
        files.push(fileName);
      }
      continue;
    }

    // File header (new)
    const newFileMatch = line.match(NEW_FILE_HEADER_REGEX);
    if (newFileMatch) {
      const fileName = newFileMatch[2];
      if (!currentFile || currentFile !== fileName) {
        currentFile = fileName;
        if (!files.includes(fileName)) {
          files.push(fileName);
        }
      }
      continue;
    }

    // Hunk header
    const hunkMatch = line.match(HUNK_HEADER_REGEX);
    if (hunkMatch) {
      if (currentHunk) {
        hunks.push(currentHunk);
      }
      currentHunk = {
        header: line,
        lines: [],
        oldStart: parseInt(hunkMatch[1], 10),
        oldCount: hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 1,
        newStart: parseInt(hunkMatch[3], 10),
        newCount: hunkMatch[4] ? parseInt(hunkMatch[4], 10) : 1,
      };
      lineNumber = currentHunk.newStart;
      continue;
    }

    // Skip if no active hunk
    if (!currentHunk) {
      continue;
    }

    // Diff line types
    if (line.startsWith("+") && !line.startsWith("+++")) {
      currentHunk.lines.push({
        type: "add",
        content: line.slice(1),
        lineNumber: lineNumber++,
      });
      additions++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      currentHunk.lines.push({
        type: "remove",
        content: line.slice(1),
      });
      deletions++;
    } else if (line.startsWith(" ") || line === "") {
      currentHunk.lines.push({
        type: "context",
        content: line.startsWith(" ") ? line.slice(1) : "",
        lineNumber: lineNumber++,
      });
    }
  }

  // Add last hunk
  if (currentHunk) {
    hunks.push(currentHunk);
  }

  const riskScore = calculateRiskScore(hunks, additions, deletions);

  return {
    hunks,
    files,
    additions,
    deletions,
    riskScore,
  };
}

/**
 * Calculate risk score for a diff (0-1)
 */
export function calculateRiskScore(
  hunks: DiffHunk[],
  additions: number,
  deletions: number,
): number {
  let risk = 0;

  // Size-based risk
  const totalChanges = additions + deletions;
  if (totalChanges > 100) {
    risk += 0.3;
  } else if (totalChanges > 50) {
    risk += 0.2;
  } else if (totalChanges > 20) {
    risk += 0.1;
  }

  // Deletion ratio (higher deletions = higher risk)
  if (totalChanges > 0) {
    const deletionRatio = deletions / totalChanges;
    risk += deletionRatio * 0.2;
  }

  // Hunk count (scattered changes are riskier)
  if (hunks.length > 5) {
    risk += 0.2;
  } else if (hunks.length > 3) {
    risk += 0.1;
  }

  // Pattern-based risk detection
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      const content = line.content.toLowerCase();

      // Dangerous patterns
      if (content.includes("delete") || content.includes("drop ") || content.includes("truncate")) {
        risk += 0.1;
      }

      // Security-sensitive patterns
      if (
        content.includes("password") ||
        content.includes("secret") ||
        content.includes("api_key") ||
        content.includes("token")
      ) {
        risk += 0.15;
      }

      // Database/IO operations
      if (
        content.includes("fs.write") ||
        content.includes("database") ||
        content.includes("exec(")
      ) {
        risk += 0.1;
      }
    }
  }

  return Math.min(risk, 1);
}

/**
 * Validate diff format
 */
export function validateDiff(diffText: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const lines = diffText.split("\n");

  let hasFileHeader = false;
  let hasHunkHeader = false;
  let ___currentHunkLineCount = 0;
  let ___expectedHunkLines = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check file headers
    if (line.startsWith("--- ")) {
      hasFileHeader = true;
      if (!lines[i + 1]?.startsWith("+++ ")) {
        errors.push(`Missing +++ header after --- at line ${i + 1}`);
      }
    }

    // Check hunk headers
    const hunkMatch = line.match(HUNK_HEADER_REGEX);
    if (hunkMatch) {
      hasHunkHeader = true;
      // Reset line count for new hunk
      __currentHunkLineCount = 0;
      __expectedHunkLines = (parseInt(hunkMatch[4]) || 1) + (parseInt(hunkMatch[2]) || 1);
    }

    // Count lines in hunk
    if (hasHunkHeader && (line.startsWith("+") || line.startsWith("-") || line.startsWith(" "))) {
      __currentHunkLineCount++;
    }
  }

  if (!hasFileHeader && diffText.trim() !== "No changes required") {
    errors.push("Missing file header (--- a/file)");
  }

  if (!hasHunkHeader && diffText.trim() !== "No changes required") {
    errors.push("Missing hunk header (@@ ... @@)");
  }

  return {
    valid: errors.length === 0 || diffText.trim() === "No changes required",
    errors,
  };
}

/**
 * Generate unified diff from original and modified content
 */
export function generateDiff(
  original: string,
  modified: string,
  filePath: string = "file",
): string {
  const originalLines = original.split("\n");
  const modifiedLines = modified.split("\n");

  // Simple LCS-based diff
  const diff: string[] = [];
  diff.push(`--- a/${filePath}`);
  diff.push(`+++ b/${filePath}`);

  // Find changes using simple comparison
  let _oldLine = 1;
  let _newLine = 1;
  const hunks: Array<{
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    lines: string[];
  }> = [];

  let _currentHunk: (typeof hunks)[0] | null = null;
  const contextSize = 3;

  // Use a simple diff algorithm
  const matrix: number[][] = [];

  // Initialize matrix
  for (let i = 0; i <= originalLines.length; i++) {
    matrix[i] = [];
    for (let j = 0; j <= modifiedLines.length; j++) {
      if (i === 0) {
        matrix[i][j] = j;
      } else if (j === 0) {
        matrix[i][j] = i;
      } else if (originalLines[i - 1] === modifiedLines[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = 1 + Math.min(matrix[i - 1][j], matrix[i][j - 1], matrix[i - 1][j - 1]);
      }
    }
  }

  // Backtrack to generate diff
  const result: Array<{ type: " " | "+" | "-"; line: string }> = [];
  let i = originalLines.length;
  let j = modifiedLines.length;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && originalLines[i - 1] === modifiedLines[j - 1]) {
      result.unshift({ type: " ", line: originalLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || matrix[i][j - 1] <= matrix[i - 1][j])) {
      result.unshift({ type: "+", line: modifiedLines[j - 1] });
      j--;
    } else if (i > 0) {
      result.unshift({ type: "-", line: originalLines[i - 1] });
      i--;
    }
  }

  // Convert to hunks
  let hunkStart = 0;
  let inHunk = false;

  for (let k = 0; k < result.length; k++) {
    const item = result[k];

    if (item.type !== " ") {
      if (!inHunk) {
        hunkStart = Math.max(0, k - contextSize);
        inHunk = true;
      }
    } else if (inHunk) {
      // Check if we should end hunk
      let hasMoreChanges = false;
      for (let m = k + 1; m < Math.min(k + contextSize + 1, result.length); m++) {
        if (result[m].type !== " ") {
          hasMoreChanges = true;
          break;
        }
      }
      if (!hasMoreChanges) {
        // End hunk
        const hunkEnd = Math.min(result.length, k + contextSize + 1);
        const hunkLines = result.slice(hunkStart, hunkEnd);

        let delCount = 0;
        let _addCount = 0;
        for (const l of hunkLines) {
          if (l.type === "-") {
            delCount++;
          }
          if (l.type === "+") {
            __addCount++;
          }
        }

        diff.push(
          `@@ -${1 + oldStart},${oldCount} +${1 + newStart},${newCount} ` +
            `+${1 + hunkStart},${hunkLines.length - delCount} @@`,
        );

        for (const l of hunkLines) {
          diff.push(l.type + l.line);
        }

        inHunk = false;
      }
    }
  }

  // Handle remaining hunk
  if (inHunk) {
    const hunkLines = result.slice(hunkStart);

    let delCount = 0;
    let _addCount = 0;
    for (const l of hunkLines) {
      if (l.type === "-") {
        delCount++;
      }
      if (l.type === "+") {
        __addCount++;
      }
    }

    diff.push(
      `@@ -${1 + oldStart},${oldCount} +${1 + newStart},${newCount} ` +
        `+${1 + hunkStart},${hunkLines.length - delCount} @@`,
    );

    for (const l of hunkLines) {
      diff.push(l.type + l.line);
    }
  }

  return diff.join("\n");
}

/**
 * Apply diff to original content
 */
export function applyDiff(original: string, parsedDiff: ParsedDiff): string {
  const lines = original.split("\n");
  let offset = 0;

  for (const hunk of parsedDiff.hunks) {
    const startLine = hunk.newStart - 1 + offset;
    let lineIndex = startLine;

    for (const line of hunk.lines) {
      switch (line.type) {
        case "add":
          lines.splice(lineIndex, 0, line.content);
          lineIndex++;
          offset++;
          break;
        case "remove":
          lines.splice(lineIndex, 1);
          offset--;
          break;
        case "context":
          lineIndex++;
          break;
      }
    }
  }

  return lines.join("\n");
}

/**
 * Check if response is in diff format
 */
export function isDiffResponse(content: string): boolean {
  // Check for unified diff markers
  const hasFileHeader = content.includes("--- ") && content.includes("+++ ");
  const hasHunkHeader = /@@ -\d+/.test(content);

  return hasFileHeader && hasHunkHeader;
}

/**
 * Get system prompt for diff-only mode
 */
export function getDiffOnlySystemPrompt(): string {
  return `You are a code editing assistant. When making code changes, output ONLY unified diff format.

Rules:
1. Output changes as unified diff (--- a/file, +++ b/file, @@ hunk headers)
2. Include minimal context (3 lines before/after changes)
3. Never output full file content - only the diffs
4. Use standard diff notation: - for removed lines, + for added lines, space for context
5. If no changes needed, output: "No changes required"

Example format:
--- a/src/example.ts
+++ b/src/example.ts
@@ -10,6 +10,7 @@
 function example() {
   const x = 1;
+  const y = 2;
   return x;
 }`;
}
