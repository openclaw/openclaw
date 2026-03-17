/**
 * Workflow Test Utility for UI-Next
 *
 * Usage in React component:
 *
 * import { testWorkflowExecution } from '@/lib/workflow-test';
 *
 * const handleRun = async () => {
 *   const result = await testWorkflowExecution({
 *     workflowId: 'wf_1773719618692',
 *     gateway: request
 *   });
 *   console.log(result);
 * };
 */

import type { CronJob, CronRunsResult } from "./types";

export interface WorkflowTestResult {
  success: boolean;
  jobId?: string;
  workflowId: string;
  runId?: string;
  status?: "ok" | "error" | "skipped";
  durationMs?: number;
  tokenUsage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  error?: string;
  logs?: string[];
}

export interface TestWorkflowParams {
  workflowId: string;
  gateway: (method: string, params?: unknown) => Promise<unknown>;
  workflowName?: string;
  timeoutMs?: number;
}

/**
 * Test workflow execution end-to-end
 */
export async function testWorkflowExecution(
  params: TestWorkflowParams,
): Promise<WorkflowTestResult> {
  const { workflowId, gateway, workflowName, timeoutMs = 120000 } = params;
  const logs: string[] = [];

  const log = (message: string) => {
    logs.push(`[${new Date().toISOString()}] ${message}`);
    console.log(`[Workflow Test] ${message}`);
  };

  try {
    log(`Starting workflow test: ${workflowName || workflowId}`);

    // Step 1: Find cron job for this workflow
    log("Finding cron job...");
    const jobsResult = (await gateway("cron.list", { includeDisabled: false })) as {
      jobs: CronJob[];
    };
    const workflowJob = jobsResult.jobs.find(
      (job) =>
        job.name === `Workflow: ${workflowName || workflowId}` ||
        job.description?.includes(workflowId),
    );

    if (!workflowJob) {
      return {
        success: false,
        workflowId,
        error: `Cron job not found for workflow: ${workflowName || workflowId}`,
        logs,
      };
    }

    log(`Found cron job: ${workflowJob.id} (${workflowJob.name})`);

    // Step 2: Run the cron job
    log("Executing cron job...");
    const runResult = (await gateway("cron.run", { jobId: workflowJob.id })) as {
      success: boolean;
      workflowId?: string;
      stepResults?: Array<{ nodeId: string; success: boolean; error?: string }>;
      durationMs?: number;
      tokenUsage?: { totalTokens: number; inputTokens: number; outputTokens: number };
      error?: string;
    };

    if ("success" in runResult) {
      log(`Run completed: success=${runResult.success}`);

      if (!runResult.success) {
        return {
          success: false,
          jobId: workflowJob.id,
          workflowId,
          error: runResult.error,
          logs,
        };
      }

      // Step 3: Get token usage
      const tokenUsage = runResult.tokenUsage
        ? {
            input_tokens: runResult.tokenUsage.inputTokens,
            output_tokens: runResult.tokenUsage.outputTokens,
            total_tokens: runResult.tokenUsage.totalTokens,
          }
        : undefined;

      log(`Token usage: ${tokenUsage?.total_tokens || "N/A"} tokens`);
      log(`Duration: ${runResult.durationMs || 0}ms`);

      return {
        success: true,
        jobId: workflowJob.id,
        workflowId,
        status: "ok",
        durationMs: runResult.durationMs,
        tokenUsage,
        logs,
      };
    } else {
      log("Run initiated (async execution)");

      // For async execution, poll for results
      return await pollForCompletion(workflowJob.id, gateway, timeoutMs, logs);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`Error: ${errorMessage}`);

    return {
      success: false,
      workflowId,
      error: errorMessage,
      logs,
    };
  }
}

/**
 * Poll for workflow completion
 */
async function pollForCompletion(
  jobId: string,
  gateway: (method: string, params?: unknown) => Promise<unknown>,
  timeoutMs: number,
  logs: string[],
): Promise<WorkflowTestResult> {
  const startTime = Date.now();
  const pollInterval = 1000; // 1 second

  const log = (message: string) => {
    logs.push(`[${new Date().toISOString()}] ${message}`);
    console.log(`[Workflow Test] ${message}`);
  };

  log(`Polling for completion (timeout: ${timeoutMs}ms)...`);

  while (Date.now() - startTime < timeoutMs) {
    try {
      const runsResult = (await gateway("cron.runs", {
        jobId,
        limit: 1,
        sortDir: "desc",
      })) as CronRunsResult;

      if (runsResult.entries && runsResult.entries.length > 0) {
        const latestRun = runsResult.entries[0];

        if (latestRun.action === "finished") {
          log(`Run completed with status: ${latestRun.status}`);

          return {
            success: latestRun.status === "ok",
            jobId,
            workflowId: jobId,
            runId: latestRun.sessionId,
            status: latestRun.status as "ok" | "error" | "skipped",
            durationMs: latestRun.durationMs,
            tokenUsage: latestRun.usage
              ? {
                  input_tokens: latestRun.usage.input_tokens,
                  output_tokens: latestRun.usage.output_tokens,
                  total_tokens:
                    latestRun.usage.total_tokens ||
                    (latestRun.usage.input_tokens || 0) + (latestRun.usage.output_tokens || 0),
                }
              : undefined,
            error: latestRun.error,
            logs,
          };
        }
      }
    } catch (error) {
      log(`Poll error: ${error instanceof Error ? error.message : String(error)}`);
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  return {
    success: false,
    workflowId: jobId,
    error: "Timeout waiting for workflow completion",
    logs,
  };
}

/**
 * Get workflow execution history
 */
export async function getWorkflowHistory(
  workflowId: string,
  gateway: (method: string, params?: unknown) => Promise<unknown>,
  limit = 10,
) {
  try {
    // Find cron job
    const jobsResult = (await gateway("cron.list", { includeDisabled: true })) as {
      jobs: CronJob[];
    };
    const workflowJob = jobsResult.jobs.find(
      (job) => job.name === `Workflow: ${workflowId}` || job.description?.includes(workflowId),
    );

    if (!workflowJob) {
      return { error: "Workflow job not found", entries: [] };
    }

    // Get run history
    const runsResult = (await gateway("cron.runs", {
      jobId: workflowJob.id,
      limit,
      sortDir: "desc",
    })) as CronRunsResult;

    return {
      jobId: workflowJob.id,
      jobName: workflowJob.name,
      entries: runsResult.entries || [],
      total: runsResult.total,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      entries: [],
    };
  }
}

/**
 * Validate workflow configuration
 */
export function validateWorkflowConfig(
  nodes: any[],
  edges: any[],
): {
  valid: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check for trigger node
  const triggerNodes = nodes.filter((n) => n.type === "trigger");
  if (triggerNodes.length === 0) {
    errors.push("Workflow must have at least one trigger node");
  } else if (triggerNodes.length > 1) {
    warnings.push("Multiple trigger nodes detected");
  }

  // Check for action nodes
  const actionNodes = nodes.filter((n) => n.type === "action");
  if (actionNodes.length === 0) {
    errors.push("Workflow must have at least one action node");
  }

  // Check edges
  if (edges.length === 0 && actionNodes.length > 0) {
    warnings.push("No connections between nodes");
  }

  // Check for disconnected nodes
  const connectedNodeIds = new Set<string>();
  edges.forEach((edge) => {
    connectedNodeIds.add(edge.source);
    connectedNodeIds.add(edge.target);
  });

  nodes.forEach((node) => {
    if (!connectedNodeIds.has(node.id) && node.type !== "trigger") {
      warnings.push(`Node "${node.data?.label || node.id}" is not connected`);
    }
  });

  // Check prompt templates
  actionNodes.forEach((node) => {
    const prompt = node.data?.prompt as string;
    if (node.data?.actionType === "agent-prompt" && !prompt) {
      errors.push(`Node "${node.data?.label || node.id}" is missing prompt`);
    }

    // Check for {{input}} in multi-node workflows
    if (actionNodes.length > 1 && prompt && !prompt.includes("{{input}}")) {
      const hasIncomingEdge = edges.some((e) => e.target === node.id);
      if (hasIncomingEdge) {
        warnings.push(
          `Node "${node.data?.label || node.id}" has incoming connections but no {{input}} in prompt`,
        );
      }
    }
  });

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
