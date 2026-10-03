import { resolve, sep } from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveIdentityPathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { ClawMigrationError } from "./migrate-errors.js";

export function clawMigrationPathsOverlap(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`);
}

export function assertPackageDestinationOutsideWorkspaces(params: {
  agentId: string;
  packageRoot: string;
  workspace: string;
  configuredAgents: Array<{ id: string }>;
  installs: Array<{ agentId: string; workspace: string }>;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): void {
  if (clawMigrationPathsOverlap(params.packageRoot, params.workspace)) {
    throw new ClawMigrationError(
      "package_destination_overlaps_workspace",
      `Generated package destination ${JSON.stringify(params.packageRoot)} overlaps the existing workspace ${JSON.stringify(params.workspace)}. Choose a workspace outside the local Claw package directory before migrating.`,
      "$.packageRoot",
    );
  }
  for (const other of params.configuredAgents) {
    if (other.id === params.agentId) {
      continue;
    }
    const otherWorkspace = resolveIdentityPathViaExistingAncestorSync(
      resolveAgentWorkspaceDir(params.config, other.id, params.env),
    );
    if (clawMigrationPathsOverlap(params.packageRoot, otherWorkspace)) {
      throw new ClawMigrationError(
        "package_destination_owned_by_agent",
        `Generated package destination ${JSON.stringify(params.packageRoot)} overlaps agent ${JSON.stringify(other.id)} workspace ${JSON.stringify(otherWorkspace)}. Move that workspace before migrating.`,
        "$.packageRoot",
      );
    }
  }
  const installOverlap = params.installs.find(
    (record) =>
      record.agentId !== params.agentId &&
      clawMigrationPathsOverlap(
        params.packageRoot,
        resolveIdentityPathViaExistingAncestorSync(record.workspace),
      ),
  );
  if (installOverlap) {
    throw new ClawMigrationError(
      "package_destination_owned_by_claw",
      `Generated package destination ${JSON.stringify(params.packageRoot)} overlaps Claw agent ${JSON.stringify(installOverlap.agentId)} workspace ${JSON.stringify(installOverlap.workspace)}. Move that workspace before migrating.`,
      "$.packageRoot",
    );
  }
}

export async function assertWorkspaceSnapshotUnchanged(
  workspace: string,
  expectedFiles: Array<{ path: string; contentDigest: string }>,
  readCurrentFiles: (workspace: string) => Promise<Array<{ name: string; digest: string }>>,
): Promise<void> {
  const currentFiles = await readCurrentFiles(workspace);
  const expected = new Map(expectedFiles.map((file) => [file.path, file.contentDigest]));
  const changed = currentFiles.find((file) => expected.get(file.name) !== file.digest);
  const missing = expectedFiles.find(
    (file) => !currentFiles.some((current) => current.name === file.path),
  );
  if (changed || missing || currentFiles.length !== expectedFiles.length) {
    const name = changed?.name ?? missing?.path ?? "selected prompt files";
    throw new ClawMigrationError(
      "workspace_file_changed_after_consent",
      `Existing workspace file ${JSON.stringify(name)} changed after consent. Rerun migrate to review the current workspace.`,
      `$.workspace.${name}`,
    );
  }
}
