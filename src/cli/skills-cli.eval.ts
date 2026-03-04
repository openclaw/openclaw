import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";
import { defaultRuntime } from "../runtime.js";
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
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const parsed = yaml.parse(content);
      if (Array.isArray(parsed)) {
        testCases.push(...parsed);
      } else if (parsed) {
        testCases.push(parsed as TestCase);
      }
    } catch (err) {
      defaultRuntime.log(theme.warn(`Failed to load test file ${file}: ${String(err)}`));
    }
  }

  return testCases;
}

/**
 * Run a single test case
 */
async function runTestCase(testCase: TestCase): Promise<TestResult> {
  const startTime = Date.now();

  // Placeholder: In a real implementation, this would call the LLM
  // For now, we'll simulate the test execution
  // In production, this would use the OpenAI/Anthropic API to run the prompt

  // Simulated response (placeholder)
  const actual = `Simulated response for: ${testCase.prompt.slice(0, 50)}...`;
  const duration = Date.now() - startTime;

  // Simple string matching for expected output
  const expected = Array.isArray(testCase.expected)
    ? testCase.expected.join(" | ")
    : testCase.expected;

  const passed =
    actual.toLowerCase().includes(expected.toLowerCase()) ||
    expected.toLowerCase().includes(actual.toLowerCase());

  return {
    name: testCase.name,
    passed,
    prompt: testCase.prompt,
    expected,
    actual,
    duration,
    tokens: Math.floor(Math.random() * 1000) + 100, // Placeholder
  };
}

/**
 * Resolve skill path - checks workspace first, then bundled skills
 */
function resolveSkillPath(workspaceDir: string, skillName: string): string | null {
  // Check workspace skills
  const workspacePath = path.join(workspaceDir, "skills", skillName);
  if (fs.existsSync(workspacePath)) {
    return workspacePath;
  }

  // Check bundled skills (relative to where openclaw is installed)
  const bundledPath = path.join(process.cwd(), "skills", skillName);
  if (fs.existsSync(bundledPath)) {
    return bundledPath;
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
      console.log(JSON.stringify({ error: message }, null, 2));
    } else {
      defaultRuntime.log(theme.warn(message));
    }
    return;
  }

  const results: TestResult[] = [];

  for (const testCase of testCases) {
    const result = await runTestCase(testCase);
    results.push(result);

    if (opts.verbose || !opts.json) {
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
    console.log(
      JSON.stringify(
        {
          skill: skillName,
          totalTests: results.length,
          passed,
          failed,
          passRate: `${((passed / results.length) * 100).toFixed(1)}%`,
          results,
        },
        null,
        2,
      ),
    );
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
      console.log(JSON.stringify({ error: message }, null, 2));
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
    console.log(JSON.stringify(benchmarkResult, null, 2));
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

  // Extract description from frontmatter
  const descriptionMatch = skillContent.match(/description:\s*(.+)/);
  const description = descriptionMatch ? descriptionMatch[1].trim() : "No description found";

  // Load sample prompts from test cases
  const testCases = loadTestCases(skillPath);
  const samplePrompts = testCases.map((tc) => tc.prompt);

  if (samplePrompts.length === 0) {
    const message = `No sample prompts found. Add test cases to generate trigger analysis.`;
    if (opts.json) {
      console.log(JSON.stringify({ error: message }, null, 2));
    } else {
      defaultRuntime.log(theme.warn(message));
    }
    return;
  }

  // Simple keyword-based relevance scoring (placeholder)
  // In production, this would use embeddings or LLM-based analysis
  const analysis = {
    relevanceScores: samplePrompts.map((prompt) => {
      const descWords = description.toLowerCase().split(/\s+/);
      const promptWords = prompt.toLowerCase().split(/\s+/);
      const matches = descWords.filter((w) => w.length > 3 && promptWords.includes(w)).length;
      return Math.min(100, Math.round((matches / descWords.length) * 100));
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

  // Check for false positives (prompts that might trigger incorrectly)
  const commonWords = ["help", "can you", "please", "what is", "how to"];
  for (const prompt of samplePrompts) {
    const hasCommon = commonWords.some((w) => prompt.toLowerCase().includes(w));
    if (hasCommon && avgScore < 60) {
      analysis.falsePositives.push(prompt.slice(0, 50) + "...");
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
    console.log(JSON.stringify(triggerAnalysis, null, 2));
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
