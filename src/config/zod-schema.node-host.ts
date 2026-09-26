import path from "node:path";
import { z } from "zod";
import { NODE_WORKER_CAPACITY_MAX } from "../infra/node-runner-inventory.js";

export const NODE_HOST_FIELD_LABELS: Record<string, string> = {
  nodeHost: "Node Host",
  "nodeHost.autoUpdate": "Node Automatic Updates",
  "nodeHost.autoUpdate.enabled": "Node Automatic Updates Enabled",
  "nodeHost.agentRuns": "Node Agent Runs",
  "nodeHost.agentRuns.claude": "Node Claude Agent Runs",
  "nodeHost.agentRuns.claude.enabled": "Node Claude Agent Runs Enabled",
  "nodeHost.workerRuns": "Node Worker Runs",
  "nodeHost.workerRuns.enabled": "Node Worker Runs Enabled",
  "nodeHost.workerRuns.capacity": "Node Worker Run Capacity",
  "nodeHost.workerRuns.isolation": "Node Worker Run Isolation",
  "nodeHost.workerRuns.containerImage": "Node Worker Run Container Image",
  "nodeHost.workerRuns.nativeInferenceConfig": "Node Worker Native Inference Configuration",
  "nodeHost.browserProxy": "Node Browser Proxy",
  "nodeHost.browserProxy.enabled": "Node Browser Proxy Enabled",
  "nodeHost.browserProxy.allowProfiles": "Node Browser Proxy Allowed Profiles",
  "nodeHost.mcp": "Node Host MCP",
  "nodeHost.mcp.servers": "Node Host MCP Servers",
  "nodeHost.skills": "Node Host Skills",
  "nodeHost.skills.enabled": "Node Host Skills Enabled",
};

export const BrowserSnapshotDefaultsSchema = z
  .object({
    /** Default snapshot mode (applies when mode is not provided). */
    mode: z.literal("efficient").optional(),
  })
  .strict()
  .optional();

export const NodeHostAgentRunsSchema = z
  .object({
    claude: z
      .object({
        enabled: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

export const NodeHostWorkerRunsSchema = z
  .object({
    enabled: z.boolean().optional(),
    capacity: z.number().int().min(1).max(NODE_WORKER_CAPACITY_MAX).optional(),
    isolation: z.enum(["none", "container"]).optional(),
    containerImage: z.string().trim().min(1).optional(),
    nativeInferenceConfig: z
      .string()
      .min(1)
      .refine(
        (value) =>
          !value.includes("\0") && (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)),
        "Expected an absolute node-local configuration path",
      )
      .optional(),
  })
  .strict()
  .optional();
