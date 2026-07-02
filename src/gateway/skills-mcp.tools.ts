// Skills MCP bridge tool registry.
// Enumerates the agent's workspace skills as MCP tools and runs each one as a
// background, one-shot agent turn. Tool calls return quickly with a job handle;
// the `skill-result` meta tool fetches the final output once the run settles.
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { agentCommandFromIngress } from "../agents/agent-command.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import { resolveSandboxPath } from "../agents/sandbox-paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { defaultRuntime } from "../runtime.js";
import type { SkillEntry } from "../skills/types.js";
import {
  filterWorkspaceSkillEntries,
  loadWorkspaceSkillEntries,
} from "../skills/loading/workspace.js";
import type { SkillsMcpRuntimeConfig } from "./skills-mcp.config.js";

/** Meta tool always present (independent of allow/deny) to drain background jobs. */
const SKILL_RESULT_TOOL_NAME = "skill-result";
/** Grace window so very fast skills can return inline on the first tool call. */
const INLINE_WAIT_MS = 2_500;
/** Default and ceiling blocking wait for `skill-result` polling. */
const DEFAULT_RESULT_WAIT_MS = 30_000;
const MAX_RESULT_WAIT_MS = 50_000;
/** Background jobs are process-local and expire so the map cannot grow forever. */
const JOB_TTL_MS = 60 * 60 * 1000;
/** Workspace subdir that holds per-job uploaded files; removed after the run. */
const UPLOAD_DIR_NAME = ".skills-mcp-uploads";
/** Upload guards for this network entry: bound count and total decoded size. */
const MAX_UPLOAD_FILES = 50;
const MAX_UPLOAD_TOTAL_BYTES = 25 * 1024 * 1024;

type SkillUploadFile = { path: string; content: string; encoding: "utf8" | "base64" };

type SkillJobStatus = "running" | "done" | "error";

type SkillJob = {
  id: string;
  status: SkillJobStatus;
  result: string;
  error: string;
  createdAt: number;
  controller: AbortController;
  settled: Promise<void>;
  markSettled: () => void;
};

const jobs = new Map<string, SkillJob>();

/** JSON Schema fragment advertised to MCP clients for one tool. */
export type SkillsMcpToolSchemaEntry = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

/** Executable tool bound to a resolved skill (or the result meta tool). */
export type SkillsMcpTool = {
  name: string;
  schema: SkillsMcpToolSchemaEntry;
  execute: (args: Record<string, unknown>) => Promise<string>;
};

function pruneExpiredJobs(now: number): void {
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) {
      jobs.delete(id);
    }
  }
}

function createSkillJob(): SkillJob {
  const now = Date.now();
  pruneExpiredJobs(now);
  let markSettled: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    markSettled = resolve;
  });
  const job: SkillJob = {
    id: randomUUID(),
    status: "running",
    result: "",
    error: "",
    createdAt: now,
    controller: new AbortController(),
    settled,
    markSettled,
  };
  jobs.set(job.id, job);
  return job;
}

// Mirrors the OpenAI-compatible handler's payload-to-text projection so a skill
// run's final assistant text is what the MCP caller receives.
function resolveAgentResultText(result: unknown): string {
  const payloads = (result as { payloads?: Array<{ text?: string }> } | null)?.payloads;
  if (!Array.isArray(payloads)) {
    return "";
  }
  return payloads
    .map((entry) => (typeof entry.text === "string" ? entry.text : ""))
    .filter((text) => text.length > 0)
    .join("\n\n");
}

function buildSkillMessage(skillName: string, input: string, uploadedPaths: string[]): string {
  const parts = [
    `Use the "${skillName}" skill to complete the request. ` +
      "Read its SKILL.md first, then follow its instructions.",
  ];
  if (uploadedPaths.length > 0) {
    parts.push(
      `Uploaded files are available at these absolute paths:\n${uploadedPaths
        .map((filePath) => `- ${filePath}`)
        .join("\n")}`,
    );
  }
  const trimmed = input.trim();
  if (trimmed) {
    parts.push(`Input:\n${trimmed}`);
  }
  return parts.join("\n\n");
}

function parseUploadFiles(value: unknown): SkillUploadFile[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error('"files" must be an array of { path, content, encoding? } objects.');
  }
  if (value.length > MAX_UPLOAD_FILES) {
    throw new Error(`Too many files: ${value.length} (max ${MAX_UPLOAD_FILES}).`);
  }
  const files: SkillUploadFile[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      throw new Error('Each "files" entry must be an object.');
    }
    const filePath = typeof entry.path === "string" ? entry.path.trim() : "";
    if (!filePath) {
      throw new Error('Each file requires a non-empty "path".');
    }
    if (typeof entry.content !== "string") {
      throw new Error(`File "${filePath}" requires a string "content".`);
    }
    const encoding = entry.encoding === "base64" ? "base64" : "utf8";
    files.push({ path: filePath, content: entry.content, encoding });
  }
  return files;
}

// Stage uploaded files under a per-job workspace subdir. Paths are sandbox-checked
// (no absolute paths, no `..` escape) because the bridge is a network entry, and
// the absolute on-disk paths are handed to the skill run via the prompt.
async function stageUploadedFiles(params: {
  workspaceDir: string;
  jobId: string;
  files: SkillUploadFile[];
}): Promise<{ dir: string; paths: string[] }> {
  const root = path.join(params.workspaceDir, UPLOAD_DIR_NAME, params.jobId);
  await mkdir(root, { recursive: true });
  const paths: string[] = [];
  let totalBytes = 0;
  try {
    for (const file of params.files) {
      const { resolved } = resolveSandboxPath({ filePath: file.path, cwd: root, root });
      const buffer = Buffer.from(file.content, file.encoding);
      totalBytes += buffer.byteLength;
      if (totalBytes > MAX_UPLOAD_TOTAL_BYTES) {
        throw new Error(`Uploaded files exceed ${MAX_UPLOAD_TOTAL_BYTES} bytes total.`);
      }
      await mkdir(path.dirname(resolved), { recursive: true });
      await writeFile(resolved, buffer);
      paths.push(resolved);
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { dir: root, paths };
}

function startSkillRun(params: {
  job: SkillJob;
  agentId: string;
  skillName: string;
  message: string;
  uploadDir?: string;
}) {
  const { job, agentId, skillName, message, uploadDir } = params;
  // The run uses its own AbortController so it survives the short HTTP request
  // that started it; the session key must carry the agent prefix or the run is
  // rejected for an agent/session mismatch.
  void agentCommandFromIngress(
    {
      message,
      agentId,
      sessionKey: `agent:${agentId}:skills-mcp-${skillName}`,
      deliver: false,
      disableMessageTool: true,
      senderIsOwner: false,
      allowModelOverride: false,
      cleanupBundleMcpOnRunEnd: true,
      abortSignal: job.controller.signal,
    },
    defaultRuntime,
  )
    .then((result) => {
      job.result = resolveAgentResultText(result);
      job.status = "done";
    })
    .catch((error: unknown) => {
      job.error = error instanceof Error ? error.message : String(error);
      job.status = "error";
    })
    .finally(() => {
      // Staged uploads only live for the duration of the run; remove them once it
      // settles so per-job upload dirs do not accumulate in the workspace.
      if (uploadDir) {
        void rm(uploadDir, { recursive: true, force: true }).catch(() => {});
      }
      job.markSettled();
    });
}

async function waitForJobSettlement(job: SkillJob, timeoutMs: number): Promise<void> {
  if (job.status !== "running" || timeoutMs <= 0) {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  try {
    await Promise.race([job.settled, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function formatRunningResponse(jobId: string): string {
  return JSON.stringify({
    status: "running",
    job_id: jobId,
    message:
      `Skill is still running. Call the "${SKILL_RESULT_TOOL_NAME}" tool with ` +
      `{ "job_id": "${jobId}" } to fetch the result.`,
  });
}

// Done -> final text; error -> throw so the caller marks the MCP result as an
// error; still running -> a JSON handle the client can poll with skill-result.
function resolveJobOutput(job: SkillJob): string {
  if (job.status === "done") {
    return job.result;
  }
  if (job.status === "error") {
    throw new Error(job.error || "Skill run failed.");
  }
  return formatRunningResponse(job.id);
}

function clampResultWaitMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_RESULT_WAIT_MS;
  }
  return Math.min(MAX_RESULT_WAIT_MS, Math.max(0, Math.floor(value)));
}

function buildSkillToolSchema(entry: SkillEntry): SkillsMcpToolSchemaEntry {
  return {
    name: entry.skill.name,
    description: entry.skill.description || `Run the ${entry.skill.name} skill.`,
    inputSchema: {
      type: "object",
      properties: {
        input: {
          type: "string",
          description: "Task input or instructions forwarded to the skill.",
        },
        files: {
          type: "array",
          description:
            "Optional files staged on disk before the skill runs; their absolute " +
            "paths are provided to the skill.",
          items: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: "Relative destination path (no absolute paths or '..').",
              },
              content: { type: "string", description: "File content." },
              encoding: {
                type: "string",
                enum: ["utf8", "base64"],
                description: "Content encoding; defaults to utf8. Use base64 for binary files.",
              },
            },
            required: ["path", "content"],
          },
        },
      },
      required: [],
    },
  };
}

function buildSkillResultToolSchema(): SkillsMcpToolSchemaEntry {
  return {
    name: SKILL_RESULT_TOOL_NAME,
    description:
      "Fetch the result of a previously started skill run by its job_id, " +
      "blocking up to wait_ms for completion.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "Job id returned by a skill tool call." },
        wait_ms: {
          type: "number",
          description: `Max blocking wait in ms (default ${DEFAULT_RESULT_WAIT_MS}, max ${MAX_RESULT_WAIT_MS}).`,
        },
      },
      required: ["job_id"],
    },
  };
}

function createSkillResultTool(): SkillsMcpTool {
  const schema = buildSkillResultToolSchema();
  return {
    name: SKILL_RESULT_TOOL_NAME,
    schema,
    execute: async (args) => {
      const jobId = typeof args.job_id === "string" ? args.job_id.trim() : "";
      if (!jobId) {
        throw new Error(`${SKILL_RESULT_TOOL_NAME} requires a "job_id" string argument.`);
      }
      const job = jobs.get(jobId);
      if (!job) {
        throw new Error(`Unknown job_id: ${jobId}`);
      }
      await waitForJobSettlement(job, clampResultWaitMs(args.wait_ms));
      return resolveJobOutput(job);
    },
  };
}

/**
 * Builds the MCP tool set exposed by the bridge: one tool per eligible workspace
 * skill (after allow/deny filtering) plus the always-present `skill-result`
 * meta tool. Tools are sorted by name for deterministic `tools/list` output.
 */
export function buildSkillsMcpTools(
  cfg: OpenClawConfig,
  runtimeCfg: SkillsMcpRuntimeConfig,
): { tools: Map<string, SkillsMcpTool>; toolSchema: SkillsMcpToolSchemaEntry[] } {
  const agentId = runtimeCfg.agentId ?? resolveDefaultAgentId(cfg);
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const entries = filterWorkspaceSkillEntries(
    loadWorkspaceSkillEntries(workspaceDir, { config: cfg, agentId }),
    cfg,
  );
  const allow = new Set(runtimeCfg.allow);
  const deny = new Set(runtimeCfg.deny);

  const tools = new Map<string, SkillsMcpTool>();
  const sorted = [...entries].sort((a, b) => a.skill.name.localeCompare(b.skill.name));
  for (const entry of sorted) {
    const name = entry.skill.name;
    if (name === SKILL_RESULT_TOOL_NAME || tools.has(name)) {
      continue;
    }
    if (deny.has(name)) {
      continue;
    }
    if (allow.size > 0 && !allow.has(name)) {
      continue;
    }
    const schema = buildSkillToolSchema(entry);
    tools.set(name, {
      name,
      schema,
      execute: async (args) => {
        const input = typeof args.input === "string" ? args.input : "";
        const files = parseUploadFiles(args.files);
        const job = createSkillJob();
        let uploadDir: string | undefined;
        let uploadedPaths: string[] = [];
        if (files.length > 0) {
          try {
            const staged = await stageUploadedFiles({ workspaceDir, jobId: job.id, files });
            uploadDir = staged.dir;
            uploadedPaths = staged.paths;
          } catch (error) {
            // Staging failed before the run started; drop the job so it is not
            // left dangling as "running" until TTL prune.
            jobs.delete(job.id);
            job.markSettled();
            throw error;
          }
        }
        startSkillRun({
          job,
          agentId,
          skillName: name,
          message: buildSkillMessage(name, input, uploadedPaths),
          uploadDir,
        });
        await waitForJobSettlement(job, INLINE_WAIT_MS);
        return resolveJobOutput(job);
      },
    });
  }

  const resultTool = createSkillResultTool();
  tools.set(resultTool.name, resultTool);

  const toolSchema = [...tools.values()].map((tool) => tool.schema);
  return { tools, toolSchema };
}
