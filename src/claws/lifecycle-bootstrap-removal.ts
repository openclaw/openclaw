import fs from "node:fs";
import path from "node:path";
import { MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES } from "../agents/workspace-bootstrap-read.js";
import { openRootFileSync } from "../infra/boundary-file-read.js";
import { removeClawWorkspaceFile, type RemovedWorkspaceFile } from "./lifecycle-delete-support.js";
import type { ClawRemovePlanAction } from "./lifecycle-remove-contract.js";
import type { ClawStatusRecord } from "./lifecycle-status.js";
import { clawBootstrapPublicationMatches } from "./workspace-origin.js";

const BOOTSTRAP_RETAIN_REASONS: Partial<Record<ClawStatusRecord["bootstrapState"], string>> = {
  modified: "Local bootstrap content changed; preserve the file.",
  complete: "Native onboarding already consumed the bootstrap.",
  unowned: "This install never seeded BOOTSTRAP.md; preserve the file.",
};

export function clawBootstrapStateBlocksRemove(record: ClawStatusRecord): boolean {
  return Boolean(
    record.install.bootstrap &&
    (record.bootstrap.state === "unsafe" || record.bootstrap.state === "unknown"),
  );
}

export function planClawBootstrapRemoval(
  record: ClawStatusRecord,
): ClawRemovePlanAction | undefined {
  if (!record.install.bootstrap) {
    return undefined;
  }
  const blocked = clawBootstrapStateBlocksRemove(record);
  const reason = BOOTSTRAP_RETAIN_REASONS[record.bootstrap.state];
  return {
    kind: "bootstrap",
    id: record.bootstrap.path,
    action: record.bootstrap.state === "pending" ? "delete" : "retain",
    target: `${record.bootstrap.workspace}:${record.bootstrap.path}`,
    blocked,
    details: {
      expectedState: record.bootstrap.state,
      contentDigest: record.install.bootstrap.contentDigest,
      sourcePath: record.install.bootstrap.sourcePath,
      lifecycle: "native-seed-once",
    },
    ...(reason ? { reason } : {}),
  };
}

export async function removeClawBootstrap(
  record: ClawStatusRecord,
  assertCurrent: () => void,
): Promise<RemovedWorkspaceFile | undefined> {
  if (!record.install.bootstrap) {
    return undefined;
  }
  if (record.bootstrap.state === "pending") {
    let fd: number | undefined;
    try {
      let ownsFile: ((relativePath: string) => boolean) | undefined;
      if (record.workspaceOrigin.adopted) {
        const publication = record.workspaceOrigin.bootstrapPublication;
        assertCurrent();
        const opened = openRootFileSync({
          absolutePath: path.join(record.install.workspace, record.bootstrap.path),
          rootPath: record.install.workspace,
          boundaryLabel: "Claw bootstrap removal",
          symlinks: "reject",
          maxBytes: MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES,
        });
        if (!opened.ok) {
          return { path: record.bootstrap.path, action: "retainedUnowned" };
        }
        fd = opened.fd;
        const pinnedFd = fd;
        const original = fs.fstatSync(pinnedFd, { bigint: true });
        if (
          !publication ||
          !clawBootstrapPublicationMatches(
            record.install.workspace,
            publication,
            record.bootstrap.path,
            original,
          )
        ) {
          return { path: record.bootstrap.path, action: "retainedUnowned" };
        }
        // Check durable ownership before rename, then retain the live object through removal
        // and restoration. Namespace changes need not preserve a fallback birth timestamp.
        ownsFile = (relativePath) => {
          const current = fs.fstatSync(pinnedFd, { bigint: true });
          if (current.size !== original.size || current.mtimeNs !== original.mtimeNs) {
            return false;
          }
          return clawBootstrapPublicationMatches(
            record.install.workspace,
            { ...publication, birthtimeNs: current.birthtimeNs.toString() },
            relativePath,
            current,
          );
        };
      }
      return await removeClawWorkspaceFile(
        {
          workspace: record.bootstrap.workspace,
          path: record.bootstrap.path,
          contentDigest: record.install.bootstrap.contentDigest,
          state: "unchanged",
        },
        assertCurrent,
        MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES,
        ownsFile,
      );
    } finally {
      if (fd !== undefined) {
        fs.closeSync(fd);
      }
    }
  }
  if (record.bootstrap.state === "modified") {
    return { path: record.bootstrap.path, action: "retainedModified" };
  }
  if (record.bootstrap.state === "unowned") {
    return { path: record.bootstrap.path, action: "retainedUnowned" };
  }
  return { path: record.bootstrap.path, action: "missing" };
}
