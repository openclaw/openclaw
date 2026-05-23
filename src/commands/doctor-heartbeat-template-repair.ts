import fs from "node:fs/promises";
import path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveWorkspaceTemplateDir } from "../agents/workspace-templates.js";
import { DEFAULT_HEARTBEAT_FILENAME } from "../agents/workspace.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { writeTextAtomic } from "../infra/json-files.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";

const DIRTY_HEARTBEAT_TEMPLATE_LINES = new Set([
  "```markdown",
  "```",
  "# HEARTBEAT.md Template",
  "# Keep this file empty (or with only comments) to skip heartbeat API calls.",
  "# Add tasks below when you want the agent to check something periodically.",
  "## Related",
  "- [Heartbeat config](/gateway/config-agents)",
]);

const DIRTY_HEARTBEAT_TEMPLATE_BODY_LINES = [
  "# Keep this file empty (or with only comments) to skip heartbeat API calls.",
  "# Add tasks below when you want the agent to check something periodically.",
] as const;

const DIRTY_HEARTBEAT_DOC_WRAPPER_LINES = new Set([
  "```markdown",
  "# HEARTBEAT.md Template",
  "- [Heartbeat config](/gateway/config-agents)",
]);

export type HeartbeatTemplateRepairAnalysis =
  | { status: "clean" }
  | { status: "dirty-template" }
  | { status: "dirty-template-with-custom-content"; customLines: string[] };

export function analyzeHeartbeatTemplateForRepair(
  content: string,
): HeartbeatTemplateRepairAnalysis {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const hasDefaultTemplateBody = DIRTY_HEARTBEAT_TEMPLATE_BODY_LINES.every((line) =>
    lines.includes(line),
  );
  const hasDirtyDocWrapper = lines.some((line) => DIRTY_HEARTBEAT_DOC_WRAPPER_LINES.has(line));
  if (!hasDefaultTemplateBody || !hasDirtyDocWrapper) {
    return { status: "clean" };
  }
  const customLines = lines.filter((line) => !DIRTY_HEARTBEAT_TEMPLATE_LINES.has(line));
  if (customLines.length > 0) {
    return { status: "dirty-template-with-custom-content", customLines };
  }
  return { status: "dirty-template" };
}

async function readCleanHeartbeatTemplate(): Promise<string> {
  const templateDir = await resolveWorkspaceTemplateDir();
  const templatePath = path.join(templateDir, DEFAULT_HEARTBEAT_FILENAME);
  return await fs.readFile(templatePath, "utf-8");
}

export async function maybeRepairHeartbeatTemplate(params: {
  cfg: OpenClawConfig;
  shouldRepair: boolean;
}): Promise<void> {
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, resolveDefaultAgentId(params.cfg));
  const heartbeatPath = path.join(workspaceDir, DEFAULT_HEARTBEAT_FILENAME);
  let content: string;
  try {
    content = await fs.readFile(heartbeatPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return;
    }
    note(
      `Could not inspect ${shortenHomePath(heartbeatPath)}: ${formatErrorMessage(error)}`,
      "Heartbeat template",
    );
    return;
  }

  const analysis = analyzeHeartbeatTemplateForRepair(content);
  if (analysis.status === "clean") {
    return;
  }
  if (analysis.status === "dirty-template-with-custom-content") {
    note(
      [
        `${shortenHomePath(heartbeatPath)} contains an older heartbeat template wrapper plus custom content.`,
        "Doctor left it unchanged so it does not delete user tasks. Remove the fenced template and Related lines manually if they are not intentional.",
      ].join("\n"),
      "Heartbeat template",
    );
    return;
  }
  if (!params.shouldRepair) {
    note(
      [
        `${shortenHomePath(heartbeatPath)} contains an older heartbeat documentation template.`,
        'Run "openclaw doctor --fix" to replace it with the clean heartbeat template.',
      ].join("\n"),
      "Heartbeat template",
    );
    return;
  }

  try {
    const cleanTemplate = await readCleanHeartbeatTemplate();
    await writeTextAtomic(heartbeatPath, cleanTemplate, { mode: 0o600 });
    note(
      `Replaced ${shortenHomePath(heartbeatPath)} with the clean heartbeat template.`,
      "Doctor changes",
    );
  } catch (error) {
    note(
      `Could not repair ${shortenHomePath(heartbeatPath)}: ${formatErrorMessage(error)}`,
      "Heartbeat template",
    );
  }
}
