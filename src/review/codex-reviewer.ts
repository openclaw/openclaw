/**
 * Codexレビュアー統合
 *
 * tmux経由でCodexを実行し、コードレビューを自動化する
 */

import { exec } from "child_process";
import { promisify } from "util";
import { mkdtempSync, writeFileSync, unlinkSync, rmSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import type {
  CodexReview,
  ReviewRequest,
  ReviewResult,
  ReviewOptions,
  TmuxResult,
  CodexExecutionOptions,
  ReviewScore,
  ReviewIssue,
  ReviewSuggestion,
} from "./types.js";

const execAsync = promisify(exec);

/** デフォルトスコア閾値 */
const DEFAULT_THRESHOLD = 0.8;

/** デフォルトタイムアウト (5分) */
const DEFAULT_TIMEOUT = 5 * 60 * 1000;

/** デフォルトtmuxターゲット (MacBook用) */
const DEFAULT_TMUX_TARGET = "%2"; // カエデ (CodeGen) のペイン

/** P1-7修正: 一時ファイルの最大サイズ (4000文字) */
const MAX_COMMAND_LENGTH = 4000;

/** P1-10修正: 終了マーカー */
const END_MARKER = "CODEX_REVIEW_COMPLETE";

/**
 * シェルコマンド用に文字列をエスケープ
 * tmux send-keys に安全に渡すためのエスケープ処理
 *
 * @param str - エスケープする文字列
 * @returns エスケープされた文字列
 */
function escapeShellString(str: string): string {
  // シェル特殊文字をエスケープ
  return str
    .replace(/\\/g, "\\\\") // バックスラッシュ
    .replace(/"/g, '\\"') // ダブルクォート
    .replace(/\$/g, "\\$") // ドル記号
    .replace(/`/g, "\\`") // バッククォート
    .replace(/\n/g, "\\n") // 改行
    .replace(/\r/g, "\\r"); // キャリッジリターン
}

/**
 * P1-9修正: センチネル間の出力を抽出
 *
 * @param output - キャプチャされた出力全体
 * @param startMarker - 開始マーカー
 * @param endMarker - 終了マーカー
 * @returns センチネル間の出力
 */
function extractBetweenSentinels(output: string, startMarker: string, endMarker: string): string {
  const startIndex = output.indexOf(startMarker);
  if (startIndex === -1) {
    console.warn("[CodexReviewer] Start sentinel not found");
    return output; // フォールバック: 全出力を返す
  }

  const afterStart = output.slice(startIndex + startMarker.length);
  const endIndex = afterStart.indexOf(endMarker);

  if (endIndex === -1) {
    console.warn("[CodexReviewer] End sentinel not found");
    return afterStart.trim(); // フォールバック: 開始マーカー後を返す
  }

  return afterStart.slice(0, endIndex).trim();
}

/**
 * P1-10修正: 終了マーカー検出まで待機
 *
 * @param target - tmuxターゲット
 * @param marker - 検出するマーカー
 * @param timeout - タイムアウト（ミリ秒）
 * @param interval - ポーリング間隔（ミリ秒）
 */
async function waitForMarker(
  target: string,
  marker: string,
  timeout: number,
  interval: number = 500,
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      // capture-paneで現在のペイン内容を取得
      const captureCommand = `tmux capture-pane -t ${target} -p -S -`;
      const { stdout: captured } = await execAsync(captureCommand, {
        timeout: 5000,
      });

      // マーカーが含まれているか確認
      if (captured.includes(marker)) {
        return true;
      }

      // マーカーがない場合は待機して再試行
      await sleep(interval);
    } catch {
      // キャプチャエラー時は待機して再試行
      await sleep(interval);
    }
  }

  // タイムアウト
  console.warn(`[CodexReviewer] Timeout waiting for marker: ${marker}`);
  return false;
}

/**
 * tmuxコマンドを実行
 *
 * P1-9修正: センチネルマーカーで出力を区切る
 * P1-10修正: 終了マーカー検出まで待機
 *
 * @param command - 実行するコマンド
 * @param target - tmuxターゲット (ペインID)
 * @param options - オプション
 * @returns 実行結果
 */
async function execTmux(
  command: string,
  target: string = DEFAULT_TMUX_TARGET,
  options: CodexExecutionOptions = {},
): Promise<TmuxResult> {
  const { timeout = DEFAULT_TIMEOUT, env = {} } = options;

  try {
    // P1-9修正: ユニークなセンチネルマーカーを生成
    const timestamp = Date.now();
    const sentinelStart = `__CODEX_START_${timestamp}__`;
    const sentinelEnd = `__CODEX_END_${timestamp}__`;

    // コマンド実行後に終了マーカーを表示するように変更
    // codex reviewコマンドの後でechoを追加
    const fullCommand = `${command}; echo "${END_MARKER}"`;

    // tmux send-keys でコマンドを送信 (コマンドインジェクション対策)
    const escapedCommand = escapeShellString(fullCommand);

    // P1-9修正: 開始センチネルを送信
    const startCommand = `tmux send-keys -t ${target} "${escapeShellString(`echo "${sentinelStart}"`)}" Enter`;
    await execAsync(startCommand, {
      timeout,
      env: { ...process.env, ...env },
    });

    // メインコマンドを送信
    const sendCommand = `tmux send-keys -t ${target} "${escapedCommand}" Enter`;
    await execAsync(sendCommand, {
      timeout,
      env: { ...process.env, ...env },
    });

    // P1-9修正: 終了センチネルを送信
    const endCommand = `tmux send-keys -t ${target} "${escapeShellString(`echo "${sentinelEnd}"`)}" Enter`;
    await execAsync(endCommand, {
      timeout,
      env: { ...process.env, ...env },
    });

    // P1-10修正: 終了マーカー検出まで待機（固定待機時間ではなく）
    const markerFound = await waitForMarker(target, END_MARKER, timeout);

    // capture-paneでペインの内容を取得
    const captureCommand = `tmux capture-pane -t ${target} -p -S -`;
    const { stdout: captured } = await execAsync(captureCommand, {
      timeout: 5000,
    });

    // P1-9修正: センチネル間の出力を抽出
    const stdout = extractBetweenSentinels(captured, sentinelStart, sentinelEnd);

    return {
      success: markerFound, // マーカー検出の有無を成功判定に使用
      stdout,
      stderr: "",
      exitCode: 0,
    };
  } catch (error: unknown) {
    const err = error as { stdout: string; stderr: string; code: number | null };
    return {
      success: false,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      exitCode: err.code ?? -1,
    };
  }
}

/**
 * 指定ミリ秒待機する
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Codexでコードレビューを実行
 *
 * P1-7修正: 一時ファイルのクリーンアップ処理を追加
 *
 * @param content - レビュー対象コード
 * @param options - オプション
 * @returns レビュー結果
 */
export async function runCodexReview(
  content: string,
  options: ReviewOptions = {},
): Promise<ReviewResult> {
  const startTime = Date.now();

  // P1-7修正: buildCodexCommandはcleanup関数を返す場合がある
  const { command, cleanup } = buildCodexCommand(content, options);

  try {
    // tmux経由でCodexを実行
    const result = await execTmux(command, options.tmuxTarget, {
      timeout: options.timeout ?? DEFAULT_TIMEOUT,
    });

    const duration = Date.now() - startTime;

    if (!result.success) {
      return {
        success: false,
        error: result.stderr || "Codex execution failed",
        duration,
      };
    }

    // 結果をパース
    const review = parseCodexOutput(result.stdout);

    return {
      success: true,
      review,
      duration,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      duration,
    };
  } finally {
    // P1-7修正: 一時ファイルをクリーンアップ
    cleanup?.();
  }
}

/**
 * Codexコマンドを構築
 *
 * P1-7修正: 長い入力は一時ファイル経由で処理
 *
 * @param content - レビュー対象コード
 * @param options - オプション
 * @returns コマンド文字列とクリーンアップ関数
 */
function buildCodexCommand(
  content: string,
  options: ReviewOptions,
): { command: string; cleanup?: () => void } {
  // P1-7修正: 長いコードは一時ファイルに書き出し
  if (content.length > MAX_COMMAND_LENGTH) {
    // 一時ディレクトリを作成
    const tempDir = mkdtempSync("/tmp/codex-review-");
    const tempFile = join(tempDir, "code.txt");

    try {
      // コンテンツをファイルに書き出し
      writeFileSync(tempFile, content, "utf-8");

      // オプションを付与
      const opts: string[] = [];
      if (options.threshold) {
        opts.push(`--threshold ${options.threshold}`);
      }
      if (options.issuesOnly) {
        opts.push("--issues-only");
      }
      if (options.suggestionsOnly) {
        opts.push("--suggestions-only");
      }
      if (options.verbose) {
        opts.push("--verbose");
      }

      const cmd = `codex review ${opts.join(" ")} -f ${escapeShellString(tempFile)}`;

      // クリーンアップ関数を返す
      return {
        command: cmd,
        cleanup: () => {
          try {
            unlinkSync(tempFile);
          } catch {
            // クリーンアップエラーは無視
          }
          try {
            // P2-1修正: importしたrmdirSyncを使用
            rmdirSync(tempDir);
          } catch {
            // ディレクトリが空でない場合は無視
          }
        },
      };
    } catch {
      // ファイル書き込みエラー時はフォールバック
      console.warn("[CodexReviewer] Failed to write temp file, using inline content");
    }
  }

  // 短いコンテンツは引数渡し
  // オプションを付与
  const opts: string[] = [];
  if (options.threshold) {
    opts.push(`--threshold ${options.threshold}`);
  }
  if (options.issuesOnly) {
    opts.push("--issues-only");
  }
  if (options.suggestionsOnly) {
    opts.push("--suggestions-only");
  }
  if (options.verbose) {
    opts.push("--verbose");
  }

  // コマンドインジェクション対策: contentをエスケープしてクォート
  const escapedContent = escapeShellString(content);
  const cmd = `codex review ${opts.join(" ")} "${escapedContent}"`;
  return { command: cmd };
}

/**
 * Codex出力をパース
 *
 * @param output - Codex出力
 * @returns レビューデタデータ
 */
export function parseCodexOutput(output: string): CodexReview {
  const lines = output.split("\n");
  const issues: ReviewIssue[] = [];
  const suggestions: ReviewSuggestion[] = [];

  let currentSection: "summary" | "issues" | "suggestions" | "score" = "summary";
  let summary = "";
  const score: ReviewScore = {
    overall: 0,
    accuracy: 0,
    completeness: 0,
    style: 0,
    security: 0,
  };

  for (const line of lines) {
    const trimmed = line.trim();

    // セクション判定
    if (trimmed.startsWith("## Summary")) {
      currentSection = "summary";
      continue;
    } else if (trimmed.startsWith("## Issues")) {
      currentSection = "issues";
      continue;
    } else if (trimmed.startsWith("## Suggestions")) {
      currentSection = "suggestions";
      continue;
    } else if (trimmed.startsWith("## Score")) {
      currentSection = "score";
      continue;
    }

    // パース処理
    if (currentSection === "summary" && trimmed) {
      summary += trimmed + "\n";
    } else if (currentSection === "issues") {
      const issue = parseIssueLine(trimmed);
      if (issue) issues.push(issue);
    } else if (currentSection === "suggestions") {
      const suggestion = parseSuggestionLine(trimmed);
      if (suggestion) suggestions.push(suggestion);
    } else if (currentSection === "score") {
      parseScoreLine(trimmed, score);
    }
  }

  // 承認判定 (閾値チェック)
  const approved = score.overall >= DEFAULT_THRESHOLD;

  return {
    id: `review-${Date.now()}`,
    target: "code-snippet",
    score,
    issues,
    suggestions,
    summary: summary.trim(),
    approved,
    timestamp: Date.now(),
    duration: 0, // 呼び出し元で設定
  };
}

/**
 * 問題行をパース
 */
function parseIssueLine(line: string): ReviewIssue | null {
  // 形式: [SEVERITY] file.ts:123: message
  const match = line.match(/^\[(critical|major|minor|nitpick)\]\s+(.+)$/);
  if (!match) return null;

  const severity = match[1] as "critical" | "major" | "minor" | "nitpick";
  const rest = match[2];

  // ファイルと行番号を抽出
  const fileMatch = rest.match(/^([^:]+):(\d+):\s*(.+)$/);
  if (fileMatch) {
    return {
      id: `issue-${Math.random().toString(36).slice(2, 11)}`,
      severity,
      category: "general",
      message: fileMatch[3],
      file: fileMatch[1],
      line: parseInt(fileMatch[2], 10),
    };
  }

  return {
    id: `issue-${Math.random().toString(36).slice(2, 11)}`,
    severity,
    category: "general",
    message: rest,
  };
}

/**
 * 提案行をパース
 */
function parseSuggestionLine(line: string): ReviewSuggestion | null {
  // 形式: [PRIORITY] category: description
  const match = line.match(/^\[(low|medium|high)\]\s+(.+):(.+)$/);
  if (!match) return null;

  const priority = match[1] as "low" | "medium" | "high";
  const category = match[2].trim();
  const description = match[3].trim();

  return {
    id: `suggestion-${Math.random().toString(36).slice(2, 11)}`,
    priority,
    category,
    description,
  };
}

/**
 * スコア行をパース
 */
function parseScoreLine(line: string, score: ReviewScore): void {
  // 形式: overall: 0.85, accuracy: 0.9, ...
  const parts = line.split(",");
  for (const part of parts) {
    const [key, value] = part.split(":").map((s) => s.trim());
    const numValue = parseFloat(value);
    if (!isNaN(numValue)) {
      switch (key) {
        case "overall":
          score.overall = numValue;
          break;
        case "accuracy":
          score.accuracy = numValue;
          break;
        case "completeness":
          score.completeness = numValue;
          break;
        case "style":
          score.style = numValue;
          break;
        case "security":
          score.security = numValue;
          break;
      }
    }
  }
}

/**
 * レビューリクエストを作成
 *
 * @param code - レビュー対象コード
 * @param options - オプション
 * @returns リクエスト
 */
export function createReviewRequest(code: string, options: ReviewOptions = {}): ReviewRequest {
  return {
    id: `review-req-${Date.now()}`,
    code,
    language: detectLanguage(code),
    options,
  };
}

/**
 * プログラミング言語を検出
 */
function detectLanguage(code: string): string {
  // 簡易的な実装
  if (code.includes("interface ") || code.includes("type ") || code.includes(": ")) {
    return "typescript";
  }
  if (code.includes("def ") || code.includes("import ")) {
    return "python";
  }
  if (code.includes("fn ") || code.includes("pub ")) {
    return "rust";
  }
  return "javascript";
}

/**
 * レビュー結果を判定
 *
 * @param result - レビュー結果
 * @param threshold - 閾値
 * @returns 判定結果
 */
export function evaluateReview(
  result: ReviewResult,
  threshold: number = DEFAULT_THRESHOLD,
): {
  approved: boolean;
  reason: string;
} {
  if (!result.success || !result.review) {
    return {
      approved: false,
      reason: result.error || "Review failed",
    };
  }

  const { review } = result;

  if (!review.approved) {
    return {
      approved: false,
      reason: `Score ${review.score.overall} below threshold ${threshold}`,
    };
  }

  // Critical issuesがある場合は拒否
  const criticalIssues = review.issues.filter((i) => i.severity === "critical");
  if (criticalIssues.length > 0) {
    return {
      approved: false,
      reason: `${criticalIssues.length} critical issue(s) found`,
    };
  }

  return {
    approved: true,
    reason: "Review passed",
  };
}

/**
 * レビューフォーマット
 */
export interface ReviewFormatter {
  /** マークダウン形式に変換 */
  toMarkdown(): string;
  /** JSON形式に変換 */
  toJSON(): string;
}

/**
 * レビュー結果をフォーマット
 */
export function formatReview(review: CodexReview): ReviewFormatter {
  return {
    toMarkdown() {
      const lines: string[] = [];

      lines.push("## Codex Review Report");
      lines.push("");
      lines.push(`**Score**: ${review.score.overall.toFixed(2)}`);
      lines.push(
        `Detail: accuracy=${review.score.accuracy.toFixed(2)}, ` +
          `completeness=${review.score.completeness.toFixed(2)}, ` +
          `style=${review.score.style.toFixed(2)}, ` +
          `security=${review.score.security.toFixed(2)}`,
      );
      lines.push("");

      if (review.issues.length > 0) {
        lines.push("### Issues");
        lines.push("");
        for (const issue of review.issues) {
          const severityEmoji = {
            critical: "🔴",
            major: "🟠",
            minor: "🟡",
            nitpick: "🟢",
          };
          const location = issue.file ? `${issue.file}:${issue.line}` : "";
          lines.push(
            `${severityEmoji[issue.severity]} [${issue.category}] ${location}: ${issue.message}`,
          );
        }
        lines.push("");
      }

      if (review.suggestions.length > 0) {
        lines.push("### Suggestions");
        lines.push("");
        for (const suggestion of review.suggestions) {
          const priorityEmoji = {
            high: "⬆️",
            medium: "➡️",
            low: "⬇️",
          };
          lines.push(
            `${priorityEmoji[suggestion.priority]} [${suggestion.category}] ${suggestion.description}`,
          );
        }
        lines.push("");
      }

      lines.push(`**Approved**: ${review.approved ? "✅" : "❌"}`);
      lines.push("");
      lines.push(review.summary);

      return lines.join("\n");
    },

    toJSON() {
      return JSON.stringify(review, null, 2);
    },
  };
}
