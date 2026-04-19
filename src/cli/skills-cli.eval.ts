import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";
import { defaultRuntime } from "../runtime.js";
import { resolveBundledSkillsDir } from "../agents/skills/bundled-dir.js";
import { theme } from "../terminal/theme.js";

export interface TestCase {
  name: string;
  prompt: string;
  expected: string | string[];
  context?: Record<string, string>;
  options?: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
  };
}

export interface TestResult {
  name: string;
  passed: boolean;
  prompt: string;
  expected: string;
  actual: string;
  duration: number;
  tokens?: number;
  error?: string;
}

export interface BenchmarkResult {
  skill: string;
  totalTests: number;
  passed: number;
  failed: number;
  passRate: number;
  totalDuration: number;
  totalTokens: number;
  results: TestResult[];
}

export interface TriggerAnalysis {
  skill: string;
  description: string;
  samplePrompts: string[];
  analysis: {
    relevanceScores: number[];
    falsePositives: string[];
    falseNegatives: string[];
    suggestions: string[];
  };
}

interface TestOptions {
  json?: boolean;
  verbose?: boolean;
}

/**
 * Load test cases from a skill's tests/ directory
 */
function isValidTestCase(obj: unknown, _file: string): obj is TestCase {
  if (typeof obj !== "object" || obj === null) {
    return false;
  }
  const tc = obj as Record<string, unknown>;
  return (
    typeof tc.name === "string" &&
    typeof tc.prompt === "string" &&
    (typeof tc.expected === "string" || Array.isArray(tc.expected))
  );
}

function loadTestCases(skillPath: string): TestCase[] {
  const testsDir = path.join(skillPath, "tests");
  if (!fs.existsSync(testsDir)) {
    return [];
  }

  const testFiles = fs
    .readdirSync(testsDir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  const testCases: TestCase[] = [];

  for (const file of testFiles) {
    const filePath = path.join(testsDir, file);
    const content = fs.readFileSync(filePath, "utf-8");
    let parsed: unknown;
    try {
      parsed = yaml.parse(content);
    } catch (err) {
      throw new Error(`Malformed YAML in ${file}: ${String(err)}`, { cause: err });
    }
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (!isValidTestCase(item, file)) {
          throw new Error(`Invalid test case schema in ${file}: each case must have name (string), prompt (string), and expected (string or string[])`);
        }
        testCases.push(item);
      }
    } else if (parsed !== undefined && parsed !== null) {
      if (!isValidTestCase(parsed, file)) {
        throw new Error(`Invalid test case schema in ${file}: must have name (string), prompt (string), and expected (string or string[])`);
      }
      testCases.push(parsed);
    }
  }

  return testCases;
}

/**
 * Run a single test case
 *
 * NOTE: The `actual` field is a simulated response for demo purposes.
 * In production, this would be replaced with an actual LLM API call.
 * The `passed` check below reflects what real LLM output should match against.
 */
async function runTestCase(testCase: TestCase): Promise<TestResult> {
  const startTime = Date.now();

  if (testCase.context && Object.keys(testCase.context).length > 0 && !opts.json) {
    defaultRuntime.log(theme.warn(`Test "${testCase.name}": context field is not yet applied (LLM integration pending)`));
  }

  // Placeholder: In a real implementation, this would call the LLM
  // For demo purposes, generate a simulated response based on keywords in the prompt
  const actual = `This is a simulated response for: ${testCase.prompt}`;

  const expectedKeywords = Array.isArray(testCase.expected)
    ? testCase.expected
    : [testCase.expected];

  const duration = Date.now() - startTime;

  // Check expected values - each keyword must appear in actual output
  // NOTE: In demo mode (simulated actual), this will always fail unless the
  // simulated response happens to include the expected keywords.
  // Full LLM integration will replace the `actual` computation above.
  const passed = expectedKeywords.every((keyword) =>
    actual.toLowerCase().includes(keyword.toLowerCase()),
  );

  const expectedStr = Array.isArray(testCase.expected)
    ? testCase.expected.join(" | ")
    : testCase.expected;

  return {
    name: testCase.name,
    passed,
    prompt: testCase.prompt,
    expected: expectedStr,
    actual,
    duration,
    tokens: 0, // Placeholder - would be actual token count from LLM
  };
}

/**
 * Resolve skill path - checks workspace first, then bundled skills
 */
function isSafeSkillName(skillName: string): boolean {
  // Reject any path traversal or absolute path attempts
  return (
    !skillName.includes("..") &&
    !skillName.includes("/") &&
    !skillName.includes("\\") &&
    skillName.trim() === skillName
  );
}

function resolveSkillPath(workspaceDir: string, skillName: string): string | null {
  // Reject unsafe skill names to prevent path traversal
  if (!isSafeSkillName(skillName)) {
    return null;
  }

  // Check workspace skills
  const workspacePath = path.join(workspaceDir, "skills", skillName);
  if (fs.existsSync(workspacePath)) {
    return workspacePath;
  }

  // Check bundled skills using the official resolution utility
  const bundledDir = resolveBundledSkillsDir();
  if (bundledDir) {
    const bundledPath = path.join(bundledDir, skillName);
    if (fs.existsSync(bundledPath)) {
      return bundledPath;
    }
  }

  return null;
}

/**
 * Run evaluation tests for a skill
 */
export async function runSkillTest(
  workspaceDir: string,
  skillName: string,
  opts: TestOptions,
): Promise<void> {
  const skillPath = resolveSkillPath(workspaceDir, skillName);

  if (!skillPath) {
    throw new Error(`Skill "${skillName}" not found in workspace or bundled skills`);
  }

  const testCases = loadTestCases(skillPath);

  if (testCases.length === 0) {
    const message = `No test cases found for skill "${skillName}". Create a tests/ directory with YAML test files.`;
    if (opts.json) {
      defaultRuntime.writeJson({ error: message }, 2);
    } else {
      defaultRuntime.log(theme.warn(message));
    }
    return;
  }

  const results: TestResult[] = [];

  for (const testCase of testCases) {
    const result = await runTestCase(testCase);
    results.push(result);

    if (!opts.json) {
      const status = result.passed ? theme.success("✓ PASS") : theme.error("✗ FAIL");
      defaultRuntime.log(`${status} - ${result.name}`);
      if (opts.verbose) {
        defaultRuntime.log(`  Prompt: ${result.prompt.slice(0, 100)}...`);
        defaultRuntime.log(`  Expected: ${result.expected}`);
        defaultRuntime.log(`  Actual: ${result.actual}`);
      }
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;

  if (opts.json) {
    defaultRuntime.writeJson({
      skill: skillName,
      totalTests: results.length,
      passed,
      failed,
      passRate: `${((passed / results.length) * 100).toFixed(1)}%`,
      results,
    });
  } else {
    defaultRuntime.log("");
    defaultRuntime.log(
      `${theme.heading("Results:")} ${passed}/${results.length} passed (${((passed / results.length) * 100).toFixed(1)}%)`,
    );
  }
}

/**
 * Run benchmark mode for a skill
 */
export async function runSkillBench(
  workspaceDir: string,
  skillName: string,
  opts: TestOptions,
): Promise<void> {
  const skillPath = resolveSkillPath(workspaceDir, skillName);

  if (!skillPath) {
    throw new Error(`Skill "${skillName}" not found in workspace or bundled skills`);
  }

  const testCases = loadTestCases(skillPath);

  if (testCases.length === 0) {
    const message = `No test cases found for skill "${skillName}". Create a tests/ directory with YAML test files.`;
    if (opts.json) {
      defaultRuntime.writeJson({ error: message }, 2);
    } else {
      defaultRuntime.log(theme.warn(message));
    }
    return;
  }

  const results: TestResult[] = [];
  let totalDuration = 0;
  let totalTokens = 0;

  // const startTime = Date.now(); // Not used in benchmark

  for (const testCase of testCases) {
    const result = await runTestCase(testCase);
    results.push(result);
    totalDuration += result.duration;
    totalTokens += result.tokens || 0;

    if (!opts.json) {
      const status = result.passed ? theme.success(".") : theme.error("F");
      process.stdout.write(status);
    }
  }

  if (!opts.json) {
    process.stdout.write("\n");
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  const passRate = (passed / results.length) * 100;

  const benchmarkResult: BenchmarkResult = {
    skill: skillName,
    totalTests: results.length,
    passed,
    failed,
    passRate,
    totalDuration,
    totalTokens,
    results,
  };

  if (opts.json) {
    defaultRuntime.writeJson(benchmarkResult, 2);
  } else {
    defaultRuntime.log(theme.heading(`Benchmark Results for "${skillName}"`));
    defaultRuntime.log("");
    defaultRuntime.log(`  Total Tests:   ${results.length}`);
    defaultRuntime.log(`  ${theme.success("Passed:")}      ${passed}`);
    defaultRuntime.log(`  ${theme.error("Failed:")}      ${failed}`);
    defaultRuntime.log(`  Pass Rate:    ${passRate.toFixed(1)}%`);
    defaultRuntime.log(`  Total Time:   ${(totalDuration / 1000).toFixed(2)}s`);
    defaultRuntime.log(`  Total Tokens: ${totalTokens}`);

    if (opts.verbose) {
      defaultRuntime.log("");
      defaultRuntime.log(theme.heading("Individual Results:"));
      for (const result of results) {
        const status = result.passed ? theme.success("✓") : theme.error("✗");
        defaultRuntime.log(`  ${status} ${result.name} (${result.duration}ms)`);
      }
    }
  }
}

/**
 * Analyze skill trigger description against sample prompts
 */
export async function analyzeSkillTrigger(
  workspaceDir: string,
  skillName: string,
  opts: TestOptions,
): Promise<void> {
  const skillPath = resolveSkillPath(workspaceDir, skillName);

  if (!skillPath) {
    throw new Error(`Skill "${skillName}" not found in workspace or bundled skills`);
  }

  // Read the skill's SKILL.md to get the description
  const skillMdPath = path.join(skillPath, "SKILL.md");
  if (!fs.existsSync(skillMdPath)) {
    throw new Error(`Skill "${skillName}" does not have a SKILL.md file`);
  }

  const skillContent = fs.readFileSync(skillMdPath, "utf-8");

  // Extract description from frontmatter using yaml parser (handles multiline block scalars)
  let description = "No description found";
  const frontmatterMatch = skillContent.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (frontmatterMatch) {
    try {
      const fm = yaml.parse(frontmatterMatch[1]);
      if (fm && typeof fm === "object" && !Array.isArray(fm)) {
        description = typeof fm.description === "string" ? fm.description : "No description found";
      }
    } catch {
      // Fall back to regex for malformed frontmatter
      const descMatch = skillContent.match(/description:\s*(.+)/);
      if (descMatch) {
        description = descMatch[1].trim();
      }
    }
 }

  // Load sample prompts from test cases
  const testCases = loadTestCases(skillPath);
  const samplePrompts = testCases.map((tc) => tc.prompt);

  if (samplePrompts.length === 0) {
    const message = `No sample prompts found. Add test cases to generate trigger analysis.`;
    if (opts.json) {
      defaultRuntime.writeJson({ error: message }, 2);
    } else {
      defaultRuntime.log(theme.warn(message));
    }
    return;
  }

// Simple keyword-based relevance scoring (placeholder)
// In production, this would use embeddings or LLM-based analysis
  const descWords = description.toLowerCase().split(/\s+/);
  const scoringWords = descWords.filter((w) => w.length > 3);
  const analysis = {
    relevanceScores: samplePrompts.map((prompt) => {
      const promptWords = prompt.toLowerCase().split(/\s+/);
      const matches = scoringWords.filter((w) => promptWords.includes(w)).length;
      return scoringWords.length === 0
        ? 0
        : Math.min(100, Math.round((matches / scoringWords.length) * 100));
    }),
    falsePositives: [] as string[],
    falseNegatives: [] as string[],
    suggestions: [] as string[],
  };

  // Generate suggestions based on analysis
  const avgScore =
    analysis.relevanceScores.reduce((a, b) => a + b, 0) / analysis.relevanceScores.length;

  if (avgScore < 50) {
    analysis.suggestions.push("Consider adding more specific keywords to the skill description");
    analysis.suggestions.push("Include common trigger phrases that match your test prompts");
  }

  if (avgScore < 30) {
    analysis.suggestions.push("The description may be too generic. Add domain-specific terms.");
  }

  // Note: false positive detection requires a separate corpus of non-triggering prompts.
// samplePrompts from the skill's own test cases are all intended triggers by definition.
// The check below flags prompts with very generic phrasing that could match many skills —
// this indicates the skill description may need more specific trigger keywords.
  const genericPhrases = ["help", "can you", "please", "what is", "how to"];
  for (const prompt of samplePrompts) {
    const hasGeneric = genericPhrases.some((w) => prompt.toLowerCase().includes(w));
    if (hasGeneric && avgScore < 60) {
      analysis.suggestions.push(
        "Some test prompts use generic phrasing (e.g. 'help me'). Consider adding more specific trigger keywords to distinguish from general-purpose skills."
      );
      break;
    }
  }

  // Check for false negatives (prompts that should trigger but might not)
  for (let i = 0; i < samplePrompts.length; i++) {
    if (analysis.relevanceScores[i] < 30) {
      analysis.falseNegatives.push(samplePrompts[i].slice(0, 50) + "...");
    }
  }

  const triggerAnalysis: TriggerAnalysis = {
    skill: skillName,
    description,
    samplePrompts,
    analysis,
  };

  if (opts.json) {
    defaultRuntime.writeJson(triggerAnalysis, 2);
  } else {
    defaultRuntime.log(theme.heading(`Trigger Analysis for "${skillName}"`));
    defaultRuntime.log("");
    defaultRuntime.log(theme.heading("Description:"));
    defaultRuntime.log(`  ${description}`);
    defaultRuntime.log("");
    defaultRuntime.log(theme.heading("Relevance Scores:"));
    for (let i = 0; i < samplePrompts.length; i++) {
      const score = analysis.relevanceScores[i];
      const color = score >= 50 ? theme.success : score >= 30 ? theme.warn : theme.error;
      defaultRuntime.log(`  ${color(`${score}%`)} - ${samplePrompts[i].slice(0, 50)}...`);
    }

    if (analysis.suggestions.length > 0) {
      defaultRuntime.log("");
      defaultRuntime.log(theme.heading("Suggestions:"));
      for (const suggestion of analysis.suggestions) {
        defaultRuntime.log(`  → ${suggestion}`);
      }
    }

    if (opts.verbose) {
      if (analysis.falsePositives.length > 0) {
        defaultRuntime.log("");
        defaultRuntime.log(theme.warn("Potential False Positives:"));
        for (const fp of analysis.falsePositives) {
          defaultRuntime.log(`  - ${fp}`);
        }
      }

      if (analysis.falseNegatives.length > 0) {
        defaultRuntime.log("");
        defaultRuntime.log(theme.warn("Potential False Negatives:"));
        for (const fn of analysis.falseNegatives) {
          defaultRuntime.log(`  - ${fn}`);
        }
      }
    }
  }
}
