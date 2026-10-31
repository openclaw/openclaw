import fs from "node:fs/promises";
import path from "node:path";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { DEFAULT_MEMORY_FILENAME, DEFAULT_USER_FILENAME } from "../agents/workspace.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { formatErrorMessage } from "../infra/errors.js";
import { readMemoryArtifactProvenance } from "../memory/memory-artifact-provenance.js";
import { shortenHomePath } from "../utils.js";

export const MEMORY_PROVENANCE_CHECK_ID = "core/doctor/memory-provenance";
const DOCS_URL = "https://docs.openclaw.ai/concepts/memory-provenance";
const FIX_HINT =
  "Review the file content. Writes from non-owner or tainted turns, and tracked writes after a shell or external edit, record untrusted provenance; see the docs for how quarantine is cleared.";

async function fileExists(filePath: string): Promise<boolean> {
  return fs.stat(filePath).then(
    (stat) => stat.isFile(),
    () => false,
  );
}

/** Lists curated root memory files that automatic context excludes by provenance. */
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
    for (const relativePath of [DEFAULT_MEMORY_FILENAME, DEFAULT_USER_FILENAME]) {
      const filePath = path.join(workspaceDir, relativePath);
      let message: string;
      try {
        if (!(await fileExists(filePath))) {
          continue;
        }
        const provenance = await readMemoryArtifactProvenance({ workspaceDir, relativePath });
        if (provenance?.originClass !== "untrusted") {
          continue;
        }
        const writer = provenance.sessionKey ? `, session ${provenance.sessionKey}` : "";
        // The ledger keeps one row per file, so the quarantining write may be older.
        message = `${agentPrefix}${relativePath} is excluded from automatic context: its memory provenance is untrusted. Last recorded tracked write: ${new Date(provenance.observedAt).toISOString()}${writer}. The record names only the latest tracked write, not necessarily the write that quarantined the file.`;
      } catch (error) {
        message = `${agentPrefix}Memory provenance inspection failed for ${shortenHomePath(filePath)}: ${formatErrorMessage(error)}`;
      }
      findings.push({
        checkId: MEMORY_PROVENANCE_CHECK_ID,
        severity: "warning",
        // Normal Doctor output only lists fix-now warnings; this context is silently missing.
        category: "fix-now",
        docsUrl: DOCS_URL,
        message,
        path: filePath,
        fixHint: FIX_HINT,
      });
    }
  }
  return findings;
}
