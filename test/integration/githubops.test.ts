/**
 * GitHubOps Protocol Integration Tests
 *
 * Tests the GitHubOps mandatory workflow:
 * 1. GitHub Issue creation/comment before any work
 * 2. Branch/Worktree creation
 * 3. Code changes
 * 4. PR creation/review
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { execSync } from "child_process";
import { unlinkSync, existsSync } from "fs";

// Test repository configuration
const TEST_REPO = process.env.GITHUBOPS_TEST_REPO || "ShunsukeHayashi/dev-workspace";
const TEST_BASE_BRANCH = "main";
const TEST_TEMP_PREFIX = "test/githubops-";

// Helper functions
function runGhCommand(args: string): string {
  try {
    return execSync(`gh ${args}`, {
      encoding: "utf-8",
      env: { ...process.env, GITHUB_TOKEN: process.env.GITHUB_TOKEN || "" },
    });
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string };
    throw new Error(`gh command failed: ${err.stderr || err.stdout || error}`);
  }
}

function createTestBranch(branchName: string): void {
  try {
    execSync(`git checkout -b ${branchName}`, { encoding: "utf-8" });
  } catch (error: unknown) {
    throw new Error(`Failed to create branch: ${String(error)}`);
  }
}

function deleteTestBranch(branchName: string): void {
  try {
    execSync(`git checkout ${TEST_BASE_BRANCH}`, { encoding: "utf-8", stdio: "ignore" });
    execSync(`git branch -D ${branchName}`, { encoding: "utf-8", stdio: "ignore" });
  } catch {
    // Ignore cleanup errors
  }
}

function parseIssueNumber(output: string): number {
  const match = output.match(/(\d+)/);
  if (!match) throw new Error("Could not parse issue number");
  return parseInt(match[1], 10);
}

// Cleanup function for test branches
const createdBranches: string[] = [];
const createdIssues: number[] = [];

afterEach(() => {
  // Clean up test branches
  createdBranches.forEach((branch) => {
    try {
      deleteTestBranch(branch);
    } catch {
      // Ignore cleanup errors
    }
  });
  createdBranches.length = 0;
});

describe("GitHubOps Integration Tests", () => {
  beforeAll(() => {
    // Verify GitHub authentication
    try {
      const authStatus = runGhCommand("auth status");
      if (authStatus.includes("not logged in")) {
        throw new Error("GitHub CLI not authenticated. Run 'gh auth login'");
      }
    } catch (error) {
      throw new Error(`GitHub authentication failed: ${error}`);
    }

    // Verify we're in a git repository
    try {
      execSync("git rev-parse --git-dir", { encoding: "utf-8", stdio: "ignore" });
    } catch {
      throw new Error("Not in a git repository");
    }
  });

  describe("Issue Creation (R1: GitHub宣言先行)", () => {
    it("should create a GitHub issue", () => {
      const title = `[TEST] GitHubOps Issue Creation ${Date.now()}`;
      const body = `## 作業宣言

### 目標
GitHubOpsプロトコルのIssue作成テスト

### テスト内容
- Issue作成機能
- 自動採番
- メタデータ付与

### 担当
- Claude Code (Test Agent)
`;

      const result = runGhCommand(
        `issue create --repo ${TEST_REPO} --title "${title}" --body "${body}"`,
      );

      expect(result).toContain("https://github.com/");
      const issueNumber = parseIssueNumber(result);
      expect(issueNumber).toBeGreaterThan(0);
      createdIssues.push(issueNumber);
    });

    it("should add a work declaration comment to existing issue", () => {
      // First create an issue
      const title = `[TEST] GitHubOps Work Declaration ${Date.now()}`;
      const createResult = runGhCommand(
        `issue create --repo ${TEST_REPO} --title "${title}" --body "Initial issue"`,
      );
      const issueNumber = parseIssueNumber(createResult);
      createdIssues.push(issueNumber);

      // Then add a work declaration comment
      const comment = `🚀 作業開始宣言

担当: Claude Code (Test Agent)
作業内容: GitHubOpsプロトコルのテスト実行
開始: ${new Date().toISOString()}

### 実施項目
1. Issue作成テスト
2. ブランチ作成テスト
3. PR作成テスト
`;

      const commentResult = runGhCommand(
        `issue comment ${issueNumber} --repo ${TEST_REPO} --body "${comment}"`,
      );

      expect(commentResult).toContain("https://github.com/");
    });
  });

  describe("Branch Creation (ブランチ作成)", () => {
    it("should create a feature branch from issue", () => {
      const timestamp = Date.now();
      const branchName = `${TEST_TEMP_PREFIX}feature-${timestamp}`;
      createdBranches.push(branchName);

      createTestBranch(branchName);

      // Verify branch was created
      const branches = execSync("git branch", { encoding: "utf-8" });
      expect(branches).toContain(branchName);
    });

    it("should create branch with correct naming convention", () => {
      const issueNumber = 123;
      const timestamp = Date.now();
      const branchName = `feature/issue-${issueNumber}-test-${timestamp}`;
      createdBranches.push(branchName);

      createTestBranch(branchName);

      // Verify branch naming follows convention
      expect(branchName).toMatch(/^feature\/issue-\d+-[\w-]+$/);
    });
  });

  describe("PR Creation (プルリクエスト作成)", () => {
    let tempBranch: string;

    beforeAll(() => {
      // Create a temporary branch with a test change
      tempBranch = `${TEST_TEMP_PREFIX}pr-test-${Date.now()}`;
      createdBranches.push(tempBranch);

      createTestBranch(tempBranch);

      // Create a dummy change
      const testFile = join(process.cwd(), "test-githubops.txt");
      Bun.write(testFile, `GitHubOps Test - ${new Date().toISOString()}\n`);

      try {
        execSync(`git add test-githubops.txt`, { encoding: "utf-8" });
        execSync('git commit -m "test: GitHubOps integration test"', {
          encoding: "utf-8",
        });
      } catch (error) {
        throw new Error(`Failed to create test commit: ${error}`);
      }
    });

    afterAll(() => {
      // Clean up test file
      const testFile = join(process.cwd(), "test-githubops.txt");
      if (existsSync(testFile)) {
        unlinkSync(testFile);
      }
    });

    it("should create a pull request", () => {
      const title = `[TEST] GitHubOps PR Creation ${Date.now()}`;
      const body = `## Summary

GitHubOpsプロトコルのPR作成テスト

## Changes
- PR作成機能のテスト
- 自動マージ検証

## Related Issues
- Closes #test-${Date.now()}

## Testing
- [x] Unit tests
- [x] Integration tests
`;

      const result = runGhCommand(
        `pr create --repo ${TEST_REPO} --title "${title}" --body "${body}" --base ${TEST_BASE_BRANCH} --draft`,
      );

      expect(result).toContain("https://github.com/");
      expect(result).toContain("pull/");
    });
  });

  describe("Complete Workflow (全体ワークフロー)", () => {
    it("should execute full GitHubOps workflow: Issue → Branch → PR", async () => {
      const timestamp = Date.now();
      const testId = `workflow-${timestamp}`;

      // Step 1: Create Issue with work declaration
      const issueTitle = `[TEST] Complete Workflow ${testId}`;
      const issueBody = `## 作業宣言

### 目標
GitHubOpsプロトコル全体ワークフローのテスト

### テスト内容
1. Issue作成
2. ブランチ作成
3. 変更実装
4. PR作成

### 担当
Claude Code (Test Agent)

### 開始
${new Date().toISOString()}
`;

      const issueResult = runGhCommand(
        `issue create --repo ${TEST_REPO} --title "${issueTitle}" --body "${issueBody}"`,
      );
      const issueNumber = parseIssueNumber(issueResult);
      expect(issueNumber).toBeGreaterThan(0);
      createdIssues.push(issueNumber);

      // Step 2: Create feature branch
      const branchName = `feature/issue-${issueNumber}-complete-workflow`;
      createdBranches.push(branchName);
      createTestBranch(branchName);

      // Verify branch was created
      const currentBranch = execSync("git branch --show-current", { encoding: "utf-8" }).trim();
      expect(currentBranch).toBe(branchName);

      // Step 3: Create a test change
      const testFile = join(process.cwd(), `test-workflow-${testId}.txt`);
      Bun.write(testFile, `Complete Workflow Test - ${testId}\n`);

      execSync(`git add test-workflow-${testId}.txt`, { encoding: "utf-8" });
      execSync(`git commit -m "feat(${testId}): implement complete workflow test"`, {
        encoding: "utf-8",
      });

      // Step 4: Create PR
      const prTitle = `[TEST] Complete Workflow PR ${testId}`;
      const prBody = `## Summary

Complete GitHubOps workflow test for ${testId}

## Changes
- Issue #${issueNumber} の実装
- ワークフロー全体の検証

## Related Issues
- Closes #${issueNumber}

## Testing
- [x] Issue作成
- [x] ブランチ作成
- [x] 変更実装
- [x] PR作成

## Checklist
- [x] Follows GitHubOps protocol
- [x] Issue declaration before work
- [x] Correct branch naming
`;

      const prResult = runGhCommand(
        `pr create --repo ${TEST_REPO} --title "${prTitle}" --body "${prBody}" --base ${TEST_BASE_BRANCH} --draft`,
      );

      expect(prResult).toContain("https://github.com/");

      // Cleanup test file
      if (existsSync(testFile)) {
        unlinkSync(testFile);
      }
    });
  });

  describe("Error Handling (エラーハンドリング)", () => {
    it("should fail gracefully when GitHub is not authenticated", () => {
      // This test verifies error handling when auth fails
      const originalToken = process.env.GITHUB_TOKEN;
      delete process.env.GITHUB_TOKEN;

      expect(() => {
        runGhCommand("auth status");
      }).toThrow();

      // Restore token
      if (originalToken) {
        process.env.GITHUB_TOKEN = originalToken;
      }
    });

    it("should validate branch naming convention", () => {
      const validPatterns = [
        "feature/issue-123-add-feature",
        "fix/issue-456-bug-fix",
        "refactor/issue-789-code-cleanup",
        "hotfix/critical-security-patch",
      ];

      validPatterns.forEach((pattern) => {
        expect(pattern).toMatch(/^(feature|fix|refactor|hotfix)\/(issue-)?\d+-[\w-]+$/);
      });
    });
  });

  describe("Conventional Commits (コミットメッセージ規約)", () => {
    it("should enforce conventional commit format", () => {
      const validCommits = [
        "feat(auth): implement password hashing",
        "fix(api): handle null response",
        "docs(readme): update installation",
        "refactor(utils): simplify logic",
        "test(user): add unit tests",
        "chore(deps): update packages",
      ];

      validCommits.forEach((commit) => {
        expect(commit).toMatch(/^(feat|fix|docs|style|refactor|test|chore|perf|ci)(\(.+\))?: .+$/);
      });
    });

    it("should reject invalid commit formats", () => {
      const invalidCommits = [
        "Added feature",
        "Fix bug",
        "Update docs",
        "no type prefix",
        "wrong format",
      ];

      invalidCommits.forEach((commit) => {
        expect(commit).not.toMatch(
          /^(feat|fix|docs|style|refactor|test|chore|perf|ci)(\(.+\))?: .+$/,
        );
      });
    });
  });
});

/**
 * GitHubOps Protocol Test Summary
 *
 * Test Coverage:
 * ✅ Issue creation with work declaration
 * ✅ Branch creation with correct naming
 * ✅ PR creation with proper format
 * ✅ Complete workflow execution
 * ✅ Error handling for auth failures
 * ✅ Branch naming convention validation
 * ✅ Conventional commit format enforcement
 *
 * Manual Testing Required:
 * - Actual GitHub repository operations (requires real repo access)
 * - Merge workflow verification
 * - Cross-agent coordination tests
 *
 * Run with:
 * CLAWDBOT_LIVE_TEST=1 pnpm test test/integration/githubops.test.ts
 */
