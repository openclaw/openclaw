import fs from "node:fs/promises";
import path from "node:path";
import { canonicalPathFromExistingAncestor, type root as fsRoot } from "../infra/fs-safe.js";
import {
  captureAgentToolSourceExecutionGuard,
  runWithAgentToolSourceExecutionScope,
} from "./agent-tool-source-execution-guard.js";
import { toRelativeWorkspacePath } from "./path-policy.js";
import { resolveHostWorkspaceRoot, resolveHostRootAsync } from "./workspace-write-scope.js";

export async function writeHostWorkspaceFile(
  root: string,
  getRoot: (root: string) => ReturnType<typeof fsRoot>,
  absolutePath: string,
  content: string,
  abortSignal?: AbortSignal,
) {
  const assertCurrent = captureAgentToolSourceExecutionGuard(abortSignal);
  const selectedRoot = await resolveHostRootAsync(root, absolutePath);
  // Reject lexical escapes before opening the lazily created workspace root.
  const relative = toRelativeWorkspacePath(selectedRoot, absolutePath);
  const rootHandle = await getRoot(selectedRoot);
  // Absolute admitted paths preserve literal "~" workspace directories.
  await runWithAgentToolSourceExecutionScope(assertCurrent, async () => {
    await rootHandle.write(path.resolve(rootHandle.rootReal, relative), content, {
      mkdir: true,
      mutationSymlinks: "follow-parents-within-root",
      assertBeforeMutation: () => {
        assertCurrent();
        toRelativeWorkspacePath(resolveHostWorkspaceRoot(root, absolutePath), absolutePath);
      },
    });
  });
}

export async function toCanonicalRelativeWorkspacePath(
  root: string,
  absolutePath: string,
): Promise<string> {
  const lexicalRelative = toRelativeWorkspacePath(root, absolutePath);
  const lexicalPath = path.resolve(root, lexicalRelative);
  const parentPath = path.dirname(lexicalPath);
  const [rootReal, canonicalParentPath] = await Promise.all([
    fs.realpath(root),
    canonicalPathFromExistingAncestor(parentPath),
  ]);
  const canonicalPath = path.join(canonicalParentPath, path.basename(lexicalPath));
  return toRelativeWorkspacePath(rootReal, canonicalPath);
}
