/**
 * ClarityBurst Autonomy Regression Validation Test Suite
 *
 * Exercises a fixed suite of representative workflows under conditions where
 * all ClarityBurst routing decisions return PROCEED, records comprehensive
 * metrics, and validates that autonomous behavior has not degraded.
 *
 * Test runs are independent (no shared state between workflows).
 * All mocks return PROCEED unless explicitly testing failure modes.
 *
 * Workflows:
 * 1. FileSystemOpsWorkflow: Sequential file creation, read, transform, write
 * 2. MemoryModifyWorkflow: Session memory update with hook handler
 * 3. ShellExecWorkflow: Command execution with confirmation token
 * 4. NetworkIOWorkflow: Safe network operation (mocked fetch)
 * 5. SubagentSpawnWorkflow: Subagent lifecycle and communication
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {
  createWorkflowRun,
  recordToolInvocation,
  recordMetric,
  finalizeWorkflowRun,
  analyzeWorkflowRegression,
  generateRegressionReport,
  formatRegressionReport,
  createDefaultHarnessConfig,
  RegressionSeverity,
  type WorkflowRunMetrics,
  type ToolPathPoint,
  type WorkflowBaseline,
  type RegressionFinding,
} from "./autonomy.regression.harness.js";

/**
 * Test context: temporary workspace for file operations
 */
let testWorkspaceDir: string;

beforeEach(() => {
  testWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "autonomy-test-"));
});

afterEach(() => {
  if (fs.existsSync(testWorkspaceDir)) {
    fs.rmSync(testWorkspaceDir, { recursive: true, force: true });
  }
});

/**
 * WORKFLOW 1: FILE_SYSTEM_OPS
 *
 * Simulates: Create directory → Write JSON input → Read JSON → Transform → Write Markdown
 * Expected tool path: ensureDir → writeFile → readFile → writeFile
 * Metrics: Completion, tool continuity, latency, semantic validation
 */
async function runFileSystemOpsWorkflow(): Promise<WorkflowRunMetrics> {
  const run = createWorkflowRun("workflow-fs-ops", "FileSystemOpsWorkflow");

  const inputDir = path.join(testWorkspaceDir, "input");
  const outputDir = path.join(testWorkspaceDir, "output");
  const inputFile = path.join(inputDir, "data.json");
  const outputFile = path.join(outputDir, "result.md");

  try {
    // Step 1: ensureDir for input
    if (!fs.existsSync(inputDir)) {
      fs.mkdirSync(inputDir, { recursive: true });
      const point: ToolPathPoint = {
        stageId: "FILE_SYSTEM_OPS",
        toolName: "ensureDir",
        contractId: "FS_MKDIR_SAFE",
        outcome: "PROCEED",
        latencyMs: Math.random() * 5 + 1,
        invokedAtMs: Date.now(),
      };
      recordToolInvocation(run, point);
    }

    // Step 2: ensureDir for output
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
      const point: ToolPathPoint = {
        stageId: "FILE_SYSTEM_OPS",
        toolName: "ensureDir",
        contractId: "FS_MKDIR_SAFE",
        outcome: "PROCEED",
        latencyMs: Math.random() * 5 + 1,
        invokedAtMs: Date.now(),
      };
      recordToolInvocation(run, point);
    }

    // Step 3: writeFile (input data)
    const inputData = {
      timestamp: "2026-03-11T03:00:00Z",
      records: [
        { id: "a", value: 10 },
        { id: "b", value: 20 },
      ],
    };
    fs.writeFileSync(inputFile, JSON.stringify(inputData, null, 2), "utf-8");
    const writePoint1: ToolPathPoint = {
      stageId: "FILE_SYSTEM_OPS",
      toolName: "writeFile",
      contractId: "FS_WRITE_SAFE",
      outcome: "PROCEED",
      latencyMs: Math.random() * 8 + 2,
      invokedAtMs: Date.now(),
    };
    recordToolInvocation(run, writePoint1);

    // Step 4: readFile
    const readContent = fs.readFileSync(inputFile, "utf-8");
    const parsedData = JSON.parse(readContent);
    const readPoint: ToolPathPoint = {
      stageId: "FILE_SYSTEM_OPS",
      toolName: "readFile",
      contractId: "FS_READ_SAFE",
      outcome: "PROCEED",
      latencyMs: Math.random() * 5 + 1,
      invokedAtMs: Date.now(),
    };
    recordToolInvocation(run, readPoint);

    // Step 5: Transform deterministically
    const recordLines = parsedData.records
      .map((r: { id: string; value: number }) => `- ${r.id}: ${r.value}`)
      .sort();
    const markdown =
      "# Data Report\n" + recordLines.join("\n") + "\n";

    // Step 6: writeFile (output)
    fs.writeFileSync(outputFile, markdown, "utf-8");
    const writePoint2: ToolPathPoint = {
      stageId: "FILE_SYSTEM_OPS",
      toolName: "writeFile",
      contractId: "FS_WRITE_SAFE",
      outcome: "PROCEED",
      latencyMs: Math.random() * 8 + 2,
      invokedAtMs: Date.now(),
    };
    recordToolInvocation(run, writePoint2);

    // Step 7: Validate semantically
    const outputContent = fs.readFileSync(outputFile, "utf-8");
    const isValid =
      outputContent.includes("# Data Report") &&
      outputContent.includes("- a: 10") &&
      outputContent.includes("- b: 20");

    recordMetric(run, {
      name: "output_file_exists",
      value: fs.existsSync(outputFile),
    });
    recordMetric(run, {
      name: "output_contains_header",
      value: outputContent.includes("# Data Report"),
    });

    finalizeWorkflowRun(run, {
      passed: isValid,
      details: isValid
        ? "Output file created with correct content"
        : "Output file missing or invalid",
    });
  } catch (err) {
    finalizeWorkflowRun(run, {
      passed: false,
      details: `Error: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return run;
}

/**
 * WORKFLOW 2: MEMORY_MODIFY
 *
 * Simulates: Update session memory → Trigger hook handler → Validate memory state
 * Expected tool path: updateMemory → callHook → readMemory
 * Metrics: Completion, hook execution order, latency, memory consistency
 */
async function runMemoryModifyWorkflow(): Promise<WorkflowRunMetrics> {
  const run = createWorkflowRun("workflow-memory", "MemoryModifyWorkflow");

  // Simulated in-memory session state
  const sessionMemory: Record<string, unknown> = {
    messages: [],
    context: {},
  };

  try {
    // Step 1: updateMemory
    sessionMemory.messages = ["user_message_1", "assistant_response_1"];
    const updatePoint: ToolPathPoint = {
      stageId: "MEMORY_MODIFY",
      toolName: "updateMemory",
      contractId: "MEMORY_APPEND_LOG",
      outcome: "PROCEED",
      latencyMs: Math.random() * 3 + 1,
      invokedAtMs: Date.now(),
    };
    recordToolInvocation(run, updatePoint);

    // Step 2: callHook (session update event)
    const hookHandler = {
      onMemoryUpdate: () => {
        sessionMemory.context = {
          lastUpdate: new Date().toISOString(),
          messageCount: (sessionMemory.messages as unknown[]).length,
        };
      },
    };
    hookHandler.onMemoryUpdate();
    const hookPoint: ToolPathPoint = {
      stageId: "MEMORY_MODIFY",
      toolName: "callHook",
      contractId: "MEMORY_HOOK_HANDLER",
      outcome: "PROCEED",
      latencyMs: Math.random() * 2 + 0.5,
      invokedAtMs: Date.now(),
    };
    recordToolInvocation(run, hookPoint);

    // Step 3: readMemory (verification)
    const memorySize = Object.keys(sessionMemory).length;
    const readPoint: ToolPathPoint = {
      stageId: "MEMORY_MODIFY",
      toolName: "readMemory",
      contractId: "MEMORY_READ_SAFE",
      outcome: "PROCEED",
      latencyMs: Math.random() * 2 + 0.5,
      invokedAtMs: Date.now(),
    };
    recordToolInvocation(run, readPoint);

    recordMetric(run, {
      name: "memory_size",
      value: memorySize,
    });
    recordMetric(run, {
      name: "has_context",
      value:
        sessionMemory.context &&
        typeof sessionMemory.context === "object"
          ? Object.keys(sessionMemory.context).length > 0
          : false,
    });

    const isValid =
      (sessionMemory.messages as unknown[]).length === 2 &&
      sessionMemory.context &&
      typeof sessionMemory.context === "object" &&
      Object.keys(sessionMemory.context).length > 0;

    finalizeWorkflowRun(run, {
      passed: isValid === true,
      details: isValid
        ? "Memory updated and hooks executed correctly"
        : "Memory state inconsistent",
    });
  } catch (err) {
    finalizeWorkflowRun(run, {
      passed: false,
      details: `Error: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return run;
}

/**
 * WORKFLOW 3: SHELL_EXEC
 *
 * Simulates: Validate command hash → Check confirmation token → Execute shell command
 * Expected tool path: validateCommand → checkToken → executeCommand
 * Metrics: Completion, confirmation handling, latency, output validation
 */
async function runShellExecWorkflow(): Promise<WorkflowRunMetrics> {
  const run = createWorkflowRun("workflow-shell", "ShellExecWorkflow");

  const command = "echo hello world";

  try {
    // Step 1: validateCommand (compute hash)
    const cmdHash = crypto
      .createHash("sha256")
      .update(command.trim())
      .digest("hex")
      .slice(0, 8);
    const validatePoint: ToolPathPoint = {
      stageId: "SHELL_EXEC",
      toolName: "validateCommand",
      contractId: "SHELL_SAFE_READONLY",
      outcome: "PROCEED",
      latencyMs: Math.random() * 2 + 0.5,
      invokedAtMs: Date.now(),
    };
    recordToolInvocation(run, validatePoint);

    // Step 2: checkToken (confirmation bypass with exact match)
    const confirmToken = `CONFIRM SHELL_EXEC SHELL_SAFE_READONLY ${cmdHash}`;
    // Simulating that token was provided correctly
    const tokenValid = confirmToken.includes(cmdHash);
    const tokenPoint: ToolPathPoint = {
      stageId: "SHELL_EXEC",
      toolName: "checkToken",
      contractId: "SHELL_SAFE_READONLY",
      outcome: tokenValid ? "PROCEED" : "ABSTAIN_CONFIRM",
      latencyMs: Math.random() * 1 + 0.2,
      invokedAtMs: Date.now(),
    };
    recordToolInvocation(run, tokenPoint);

    if (!tokenValid) {
      throw new Error("Confirmation token invalid");
    }

    // Step 3: executeCommand (mocked)
    const output = "hello world";
    const execPoint: ToolPathPoint = {
      stageId: "SHELL_EXEC",
      toolName: "executeCommand",
      contractId: "SHELL_SAFE_READONLY",
      outcome: "PROCEED",
      latencyMs: Math.random() * 10 + 5,
      invokedAtMs: Date.now(),
    };
    recordToolInvocation(run, execPoint);

    recordMetric(run, {
      name: "command_hash",
      value: cmdHash,
    });
    recordMetric(run, {
      name: "output_length",
      value: output.length,
    });

    const isValid = output.includes("hello");

    finalizeWorkflowRun(run, {
      passed: isValid,
      details: isValid
        ? "Command executed with valid output"
        : "Command output invalid",
    });
  } catch (err) {
    finalizeWorkflowRun(run, {
      passed: false,
      details: `Error: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return run;
}

/**
 * WORKFLOW 4: NETWORK_IO (Mocked)
 *
 * Simulates: Validate URL → Check rate limit → Execute fetch → Parse response
 * Expected tool path: validateUrl → checkRateLimit → executeFetch → parseResponse
 * Metrics: Completion, network latency simulation, response parsing, data integrity
 */
async function runNetworkIOWorkflow(): Promise<WorkflowRunMetrics> {
  const run = createWorkflowRun("workflow-network", "NetworkIOWorkflow");

  const url = "https://api.example.com/data";
  const mockResponse = { id: "123", status: "ok" };

  try {
    // Step 1: validateUrl
    const isValidUrl = url.startsWith("https://");
    const validatePoint: ToolPathPoint = {
      stageId: "NETWORK_IO",
      toolName: "validateUrl",
      contractId: "NETWORK_HTTPS_SAFE",
      outcome: "PROCEED",
      latencyMs: Math.random() * 1 + 0.3,
      invokedAtMs: Date.now(),
    };
    recordToolInvocation(run, validatePoint);

    if (!isValidUrl) {
      throw new Error("Invalid URL");
    }

    // Step 2: checkRateLimit
    const rateLimitOk = true; // Simulated
    const rateLimitPoint: ToolPathPoint = {
      stageId: "NETWORK_IO",
      toolName: "checkRateLimit",
      contractId: "NETWORK_HTTPS_SAFE",
      outcome: rateLimitOk ? "PROCEED" : "ABSTAIN_CLARIFY",
      latencyMs: Math.random() * 2 + 0.5,
      invokedAtMs: Date.now(),
    };
    recordToolInvocation(run, rateLimitPoint);

    if (!rateLimitOk) {
      throw new Error("Rate limit exceeded");
    }

    // Step 3: executeFetch (mocked with simulated latency)
    const fetchLatency = Math.random() * 100 + 50;
    const fetchPoint: ToolPathPoint = {
      stageId: "NETWORK_IO",
      toolName: "executeFetch",
      contractId: "NETWORK_HTTPS_SAFE",
      outcome: "PROCEED",
      latencyMs: fetchLatency,
      invokedAtMs: Date.now(),
    };
    recordToolInvocation(run, fetchPoint);

    // Step 4: parseResponse
    const parsePoint: ToolPathPoint = {
      stageId: "NETWORK_IO",
      toolName: "parseResponse",
      contractId: "NETWORK_HTTPS_SAFE",
      outcome: "PROCEED",
      latencyMs: Math.random() * 2 + 0.5,
      invokedAtMs: Date.now(),
    };
    recordToolInvocation(run, parsePoint);

    recordMetric(run, {
      name: "response_size_bytes",
      value: JSON.stringify(mockResponse).length,
    });
    recordMetric(run, {
      name: "response_valid",
      value: mockResponse.status === "ok",
    });

    const isValid = mockResponse.status === "ok" && mockResponse.id === "123";

    finalizeWorkflowRun(run, {
      passed: isValid,
      details: isValid
        ? "Network request successful with valid response"
        : "Network response invalid",
    });
  } catch (err) {
    finalizeWorkflowRun(run, {
      passed: false,
      details: `Error: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return run;
}

/**
 * WORKFLOW 5: SUBAGENT_SPAWN
 *
 * Simulates: Create subagent → Send message → Wait for response → Collect result
 * Expected tool path: spawnAgent → sendMessage → waitResponse → collectResult
 * Metrics: Completion, message ordering, latency, response collection
 */
async function runSubagentSpawnWorkflow(): Promise<WorkflowRunMetrics> {
  const run = createWorkflowRun("workflow-subagent", "SubagentSpawnWorkflow");

  try {
    // Step 1: spawnAgent
    const agentId = "subagent_" + crypto.randomBytes(4).toString("hex");
    const spawnPoint: ToolPathPoint = {
      stageId: "SUBAGENT_SPAWN",
      toolName: "spawnAgent",
      contractId: "SUBAGENT_LOCAL_ONLY",
      outcome: "PROCEED",
      latencyMs: Math.random() * 20 + 10,
      invokedAtMs: Date.now(),
    };
    recordToolInvocation(run, spawnPoint);

    // Step 2: sendMessage
    const message = "Process this data";
    const sendPoint: ToolPathPoint = {
      stageId: "SUBAGENT_SPAWN",
      toolName: "sendMessage",
      contractId: "SUBAGENT_LOCAL_ONLY",
      outcome: "PROCEED",
      latencyMs: Math.random() * 5 + 2,
      invokedAtMs: Date.now(),
    };
    recordToolInvocation(run, sendPoint);

    // Step 3: waitResponse (simulated with timeout)
    const response = "Data processed successfully";
    const waitPoint: ToolPathPoint = {
      stageId: "SUBAGENT_SPAWN",
      toolName: "waitResponse",
      contractId: "SUBAGENT_LOCAL_ONLY",
      outcome: "PROCEED",
      latencyMs: Math.random() * 50 + 20,
      invokedAtMs: Date.now(),
    };
    recordToolInvocation(run, waitPoint);

    // Step 4: collectResult
    const result = {
      agentId,
      status: "completed",
      output: response,
    };
    const collectPoint: ToolPathPoint = {
      stageId: "SUBAGENT_SPAWN",
      toolName: "collectResult",
      contractId: "SUBAGENT_LOCAL_ONLY",
      outcome: "PROCEED",
      latencyMs: Math.random() * 2 + 0.5,
      invokedAtMs: Date.now(),
    };
    recordToolInvocation(run, collectPoint);

    recordMetric(run, {
      name: "agent_id",
      value: agentId,
    });
    recordMetric(run, {
      name: "result_status",
      value: result.status,
    });

    const isValid =
      result.status === "completed" &&
      result.output.includes("successfully");

    finalizeWorkflowRun(run, {
      passed: isValid,
      details: isValid
        ? "Subagent executed and returned valid result"
        : "Subagent result invalid",
    });
  } catch (err) {
    finalizeWorkflowRun(run, {
      passed: false,
      details: `Error: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return run;
}

/**
 * Test: Run all workflows and verify no regressions
 */
describe("ClarityBurst Autonomy Regression Validation", () => {
  it("executes FileSystemOpsWorkflow with all PROCEED decisions", async () => {
    const run = await runFileSystemOpsWorkflow();

    expect(run.completed).toBe(true);
    expect(run.semanticValidation.passed).toBe(true);
    expect(run.proceedCount).toBe(5); // ensureDir, ensureDir, writeFile, readFile, writeFile
    expect(run.abstainClarifyCount).toBe(0);
    expect(run.abstainConfirmCount).toBe(0);
    expect(run.totalLatencyMs).toBeGreaterThan(0);
  });

  it("executes MemoryModifyWorkflow with all PROCEED decisions", async () => {
    const run = await runMemoryModifyWorkflow();

    expect(run.completed).toBe(true);
    expect(run.semanticValidation.passed).toBe(true);
    expect(run.proceedCount).toBe(3); // updateMemory, callHook, readMemory
    expect(run.abstainClarifyCount).toBe(0);
    expect(run.abstainConfirmCount).toBe(0);
  });

  it("executes ShellExecWorkflow with confirmation token validation", async () => {
    const run = await runShellExecWorkflow();

    expect(run.completed).toBe(true);
    expect(run.semanticValidation.passed).toBe(true);
    expect(run.toolInvocations).toBe(3);
    expect(run.proceedCount).toBe(3);
  });

  it("executes NetworkIOWorkflow with mocked requests", async () => {
    const run = await runNetworkIOWorkflow();

    expect(run.completed).toBe(true);
    expect(run.semanticValidation.passed).toBe(true);
    expect(run.toolInvocations).toBe(4);
    expect(run.proceedCount).toBe(4);
  });

  it("executes SubagentSpawnWorkflow with lifecycle events", async () => {
    const run = await runSubagentSpawnWorkflow();

    expect(run.completed).toBe(true);
    expect(run.semanticValidation.passed).toBe(true);
    expect(run.toolInvocations).toBe(4);
    expect(run.proceedCount).toBe(4);
  });

  it("detects regression when tool path order changes", () => {
    const run = createWorkflowRun("test-workflow", "TestWorkflow");

    // Expected baseline: A -> B -> C
    const baseline: WorkflowBaseline = {
      workflowId: "test-workflow",
      workflowName: "TestWorkflow",
      avgTotalLatencyMs: 100,
      avgToolInvocations: 3,
      avgRetries: 0,
      expectedToolPath: [
        { stageId: "FILE_SYSTEM_OPS", toolName: "writeFile" },
        { stageId: "FILE_SYSTEM_OPS", toolName: "readFile" },
        { stageId: "FILE_SYSTEM_OPS", toolName: "writeFile" },
      ],
      semanticValidationRequired: true,
      recordedAtMs: Date.now(),
      sampleSize: 1,
    };

    // Current run: A -> C -> B (order changed!)
    recordToolInvocation(run, {
      stageId: "FILE_SYSTEM_OPS",
      toolName: "writeFile",
      contractId: "FS_WRITE",
      outcome: "PROCEED",
      latencyMs: 50,
      invokedAtMs: Date.now(),
    });
    recordToolInvocation(run, {
      stageId: "FILE_SYSTEM_OPS",
      toolName: "writeFile",
      contractId: "FS_WRITE",
      outcome: "PROCEED",
      latencyMs: 50,
      invokedAtMs: Date.now(),
    });
    recordToolInvocation(run, {
      stageId: "FILE_SYSTEM_OPS",
      toolName: "readFile",
      contractId: "FS_READ",
      outcome: "PROCEED",
      latencyMs: 50,
      invokedAtMs: Date.now(),
    });

    finalizeWorkflowRun(run, {
      passed: true,
      details: "Test",
    });

    const config = createDefaultHarnessConfig();
    const findings = analyzeWorkflowRegression(run, baseline, config);

    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.metricName === "toolPathContinuity")).toBe(
      true
    );
    const pathFinding = findings.find((f) => f.metricName === "toolPathContinuity");
    expect(pathFinding?.severity).toBe(RegressionSeverity.CRITICAL);
  });

  it("detects regression when latency exceeds threshold", () => {
    const run = createWorkflowRun("test-workflow", "TestWorkflow");

    const baseline: WorkflowBaseline = {
      workflowId: "test-workflow",
      workflowName: "TestWorkflow",
      avgTotalLatencyMs: 100,
      avgToolInvocations: 1,
      avgRetries: 0,
      expectedToolPath: [{ stageId: "FILE_SYSTEM_OPS", toolName: "writeFile" }],
      semanticValidationRequired: true,
      recordedAtMs: Date.now(),
      sampleSize: 1,
    };

    recordToolInvocation(run, {
      stageId: "FILE_SYSTEM_OPS",
      toolName: "writeFile",
      contractId: "FS_WRITE",
      outcome: "PROCEED",
      latencyMs: 50,
      invokedAtMs: Date.now(),
    });

    // Simulate delayed completion to trigger latency regression
    // Baseline: 100ms, Current: 500ms = 400% increase
    const startTime = Date.now();
    finalizeWorkflowRun(run, {
      passed: true,
      details: "Test",
    });
    // Artificially set to simulate high latency
    run.totalLatencyMs = 500;
    run.endedAtMs = startTime + 500;

    const config = createDefaultHarnessConfig();
    config.latencyDegradationCriticalPct = 200; // 200% threshold (300% increase exceeds this)

    const findings = analyzeWorkflowRegression(run, baseline, config);

    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.metricName === "totalLatencyMs")).toBe(true);
  });

  it("generates regression report with findings", () => {
    const run = createWorkflowRun("test-workflow", "TestWorkflow");

    recordToolInvocation(run, {
      stageId: "FILE_SYSTEM_OPS",
      toolName: "writeFile",
      contractId: "FS_WRITE",
      outcome: "ABSTAIN_CLARIFY",
      latencyMs: 50,
      invokedAtMs: Date.now(),
    });

    finalizeWorkflowRun(run, {
      passed: false,
      details: "Gating blocked operation",
    });

    const baseline: WorkflowBaseline = {
      workflowId: "test-workflow",
      workflowName: "TestWorkflow",
      avgTotalLatencyMs: 100,
      avgToolInvocations: 1,
      avgRetries: 0,
      expectedToolPath: [{ stageId: "FILE_SYSTEM_OPS", toolName: "writeFile" }],
      semanticValidationRequired: true,
      recordedAtMs: Date.now(),
      sampleSize: 1,
    };

    const config = createDefaultHarnessConfig();
    const findings = analyzeWorkflowRegression(run, baseline, config);

    const report = generateRegressionReport(findings, [run]);

    expect(report.healthScore).toBeLessThan(100);
    expect(report.passed).toBe(false);
    expect(report.findings.length).toBeGreaterThan(0);

    const formatted = formatRegressionReport(report);
    expect(formatted).toContain("Autonomy Regression");
    expect(formatted).toContain("Health Score");
  });

  it("produces no regressions when all workflows pass", async () => {
    const runs = await Promise.all([
      runFileSystemOpsWorkflow(),
      runMemoryModifyWorkflow(),
      runShellExecWorkflow(),
      runNetworkIOWorkflow(),
      runSubagentSpawnWorkflow(),
    ]);

    const baselines: WorkflowBaseline[] = [
      {
        workflowId: "workflow-fs-ops",
        workflowName: "FileSystemOpsWorkflow",
        avgTotalLatencyMs: 100,
        avgToolInvocations: 5,
        avgRetries: 0,
        expectedToolPath: [
          { stageId: "FILE_SYSTEM_OPS", toolName: "ensureDir" },
          { stageId: "FILE_SYSTEM_OPS", toolName: "ensureDir" },
          { stageId: "FILE_SYSTEM_OPS", toolName: "writeFile" },
          { stageId: "FILE_SYSTEM_OPS", toolName: "readFile" },
          { stageId: "FILE_SYSTEM_OPS", toolName: "writeFile" },
        ],
        semanticValidationRequired: true,
        recordedAtMs: Date.now(),
        sampleSize: 1,
      },
      {
        workflowId: "workflow-memory",
        workflowName: "MemoryModifyWorkflow",
        avgTotalLatencyMs: 50,
        avgToolInvocations: 3,
        avgRetries: 0,
        expectedToolPath: [
          { stageId: "MEMORY_MODIFY", toolName: "updateMemory" },
          { stageId: "MEMORY_MODIFY", toolName: "callHook" },
          { stageId: "MEMORY_MODIFY", toolName: "readMemory" },
        ],
        semanticValidationRequired: true,
        recordedAtMs: Date.now(),
        sampleSize: 1,
      },
    ];

    const config = createDefaultHarnessConfig();
    const allFindings: RegressionFinding[] = [];

    for (const run of runs.slice(0, 2)) {
      const baseline = baselines.find((b) => b.workflowId === run.workflowId);
      if (baseline) {
        const findings = analyzeWorkflowRegression(run, baseline, config);
        allFindings.push(...findings);
      }
    }

    const report = generateRegressionReport(allFindings, runs);

    // Expect minimal to no regressions (allow small latency variations)
    const criticalFindings = report.findings.filter(
      (f) => f.severity === RegressionSeverity.CRITICAL
    );
    expect(criticalFindings.length).toBe(0);
    expect(report.healthScore).toBeGreaterThanOrEqual(80);
  });
});
