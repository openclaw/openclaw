import { isRecord as isJsonObject } from "@openclaw/normalization-core/record-coerce";
import type { ClawHubClawManifestSummary } from "../infra/clawhub-packages.js";
import { ClawHubSourceError } from "./clawhub-source-artifact.js";

export function parseClawManifestSummary(value: unknown): ClawHubClawManifestSummary {
  if (!isJsonObject(value) || value.schemaVersion !== 1) {
    throw new ClawHubSourceError(
      "clawhub_manifest_summary_missing",
      "ClawHub did not return a validated Claw summary.",
    );
  }
  const { agent, workspace, packages } = value;
  const isCount = (count: unknown): count is number =>
    typeof count === "number" && Number.isSafeInteger(count) && count >= 0;
  if (
    !isJsonObject(agent) ||
    typeof agent.id !== "string" ||
    !agent.id ||
    (agent.name !== undefined && typeof agent.name !== "string") ||
    (agent.description !== undefined && typeof agent.description !== "string") ||
    !isJsonObject(workspace) ||
    !Array.isArray(workspace.bootstrapFiles) ||
    !workspace.bootstrapFiles.every((file) => typeof file === "string") ||
    !isCount(workspace.fileCount) ||
    !isJsonObject(packages) ||
    !isCount(packages.skillCount) ||
    !isCount(packages.pluginCount) ||
    !isCount(value.mcpServerCount) ||
    !isCount(value.cronJobCount)
  ) {
    throw new ClawHubSourceError(
      "clawhub_manifest_summary_missing",
      "ClawHub did not return a validated Claw summary.",
    );
  }
  return {
    schemaVersion: 1,
    agent: {
      id: agent.id,
      ...(typeof agent.name === "string" ? { name: agent.name } : {}),
      ...(typeof agent.description === "string" ? { description: agent.description } : {}),
    },
    workspace: { bootstrapFiles: workspace.bootstrapFiles, fileCount: workspace.fileCount },
    packages: { skillCount: packages.skillCount, pluginCount: packages.pluginCount },
    mcpServerCount: value.mcpServerCount,
    cronJobCount: value.cronJobCount,
  };
}
