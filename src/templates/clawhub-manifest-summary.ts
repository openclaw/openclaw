import { isRecord as isJsonObject } from "@openclaw/normalization-core/record-coerce";
import { ClawHubSourceError } from "./clawhub-source-artifact.js";

export function parseTemplateManifestSummary(value: unknown): {
  name?: string;
  description?: string;
} {
  if (!isJsonObject(value) || value.schemaVersion !== 1) {
    throw new ClawHubSourceError(
      "clawhub_manifest_summary_missing",
      "ClawHub did not return a validated Template summary.",
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
      "ClawHub did not return a validated Template summary.",
    );
  }
  return {
    ...(agent.name !== undefined ? { name: agent.name } : {}),
    ...(agent.description !== undefined ? { description: agent.description } : {}),
  };
}
