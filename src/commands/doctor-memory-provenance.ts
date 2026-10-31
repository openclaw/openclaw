import fs from "node:fs/promises";
import path from "node:path";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { DEFAULT_MEMORY_FILENAME, DEFAULT_USER_FILENAME } from "../agents/workspace.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { formatErrorMessage } from "../infra/errors.js";
import { isMemoryOriginEligibleForAutomaticInjection } from "../memory-host-sdk/host/types.js";
import { readMemoryArtifactProvenance } from "../memory/memory-artifact-provenance.js";
import { classifyActiveMemoryWorkspacePaths } from "../plugins/memory-runtime.js";
import { shortenHomePath } from "../utils.js";

export const MEMORY_PROVENANCE_CHECK_ID = "core/doctor/memory-provenance";
const DOCS_URL = "https://docs.openclaw.ai/concepts/memory-provenance";
const FIX_HINT =
  "Review the file content. Writes from non-owner or tainted turns, and tracked writes after a shell or external edit, record untrusted provenance; see the docs for how quarantine is cleared.";
// Matches the opaque profile ids accepted for personal USER.md bootstrap files.
const PROFILE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

async function isFile(filePath: string): Promise<boolean> {
  return fs.stat(filePath).then(
    (stat) => stat.isFile(),
    () => false,
  );
}

/** Root MEMORY.md/USER.md plus personal users/<profile>/USER.md files present in the workspace. */
async function listCuratedMemoryFiles(workspaceDir: string): Promise<string[]> {
  const profileIds = await fs.readdir(path.join(workspaceDir, "users")).catch(() => []);
  const candidates = [
    DEFAULT_MEMORY_FILENAME,
    DEFAULT_USER_FILENAME,
    ...profileIds
      .filter((id) => PROFILE_ID_PATTERN.test(id))
      .toSorted()
      .map((id) => `users/${id}/${DEFAULT_USER_FILENAME}`),
  ];
  const present = await Promise.all(
    candidates.map(async (relativePath) =>
      (await isFile(path.join(workspaceDir, relativePath))) ? relativePath : undefined,
    ),
  );
  return present.filter((relativePath) => relativePath !== undefined);
}

function finding(filePath: string, message: string): HealthFinding {
  return {
    checkId: MEMORY_PROVENANCE_CHECK_ID,
    severity: "warning",
    // Normal Doctor output only lists fix-now warnings; this context is silently missing.
    category: "fix-now",
    docsUrl: DOCS_URL,
    message,
    path: filePath,
    fixHint: FIX_HINT,
  };
}

/** Lists curated memory files that automatic context excludes by provenance. */
export async function collectMemoryProvenanceExclusionFindings(
  cfg: OpenClawConfig,
): Promise<HealthFinding[]> {
  const agentIds = listAgentIds(cfg);
  const findings: HealthFinding[] = [];
  const seenWorkspaces = new Set<string>();
  for (const agentId of agentIds) {
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    if (seenWorkspaces.has(workspaceDir)) {
      continue;
    }
    seenWorkspaces.add(workspaceDir);
    const agentPrefix = agentIds.length > 1 ? `Agent "${agentId}": ` : "";
    try {
      const relativePaths = await listCuratedMemoryFiles(workspaceDir);
      if (relativePaths.length === 0) {
        continue;
      }
      // Ask the same classifier as the bootstrap gate so Doctor reports only real exclusions.
      const result = await classifyActiveMemoryWorkspacePaths({
        cfg,
        agentId,
        workspaceDir,
        relativePaths,
      });
      if (result.status !== "classified") {
        continue;
      }
      for (const { relativePath, originClass } of result.classifications) {
        if (isMemoryOriginEligibleForAutomaticInjection(originClass)) {
          continue;
        }
        const provenance = await readMemoryArtifactProvenance({ workspaceDir, relativePath });
        const lastWrite = provenance
          ? ` Last recorded tracked write: ${new Date(provenance.observedAt).toISOString()}${provenance.sessionKey ? `, session ${provenance.sessionKey}` : ""}. The record names only the latest tracked write, not necessarily the write that quarantined the file.`
          : "";
        findings.push(
          finding(
            path.join(workspaceDir, relativePath),
            `${agentPrefix}${relativePath} is excluded from automatic context: its memory provenance is ${originClass}.${lastWrite}`,
          ),
        );
      }
    } catch (error) {
      findings.push(
        finding(
          workspaceDir,
          `${agentPrefix}Memory provenance inspection failed for ${shortenHomePath(workspaceDir)}: ${formatErrorMessage(error)}`,
        ),
      );
    }
  }
  return findings;
}
