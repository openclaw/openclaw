import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { UpdateCandidatePluginTreePlanSchema } from "./update-candidate-plugin-tree-schema.js";
import { prepareUpdateCandidatePluginTrees } from "./update-candidate-plugin-tree.js";
import { createUpdateStateInspectionReporter } from "./update-candidate-state.diagnostics.js";
import { linkUpdateCandidatePluginTrees } from "./update-retained-runtime-tree.js";

export const RetainedRuntimeFilesSchema = z
  .object({
    relocations: UpdateCandidatePluginTreePlanSchema.shape.relocations,
    fileCount: z.number().int().nonnegative(),
    entries: z.number().int().nonnegative(),
    estimatedBytes: UpdateCandidatePluginTreePlanSchema.shape.bytes,
    inventoryMs: z.number().nonnegative(),
    materializationMs: z.number().nonnegative(),
    linked: z.number().int().nonnegative(),
    copied: z.number().int().nonnegative(),
  })
  .or(z.object({ unusableReason: z.string() }));

// Beside, never inside, the projected tree; the parent owns its private root.
const retainedRuntimeFileList = (privateRoot: string) =>
  path.join(privateRoot, "retained-files.json");

/** Large installations retain more file paths than worker stdout can carry. */
export async function readRetainedRuntimeFileList(
  privateRoot: string,
  reply: { fileCount: number },
): Promise<string[]> {
  const files = z
    .array(z.string())
    .parse(JSON.parse(await fs.readFile(retainedRuntimeFileList(privateRoot), "utf8")));
  if (files.length !== reply.fileCount) {
    throw new Error("Retained runtime file list does not match its worker reply");
  }
  return files;
}

export function projectRetainedRuntimePath(privateRoot: string, source: string): string {
  const base = path.parse(source).root;
  return path.join(
    privateRoot,
    "tree",
    Buffer.from(base).toString("hex"),
    path.relative(base, source),
  );
}

/** The parent owns cancellation, cleanup, and admission of these private files. */
export async function prepareRetainedRuntimeFiles(params: {
  privateRoot: string;
  sourceRoot: string;
  roots: string[];
  retainedDependencyRoot: string;
}) {
  const report = createUpdateStateInspectionReporter();
  report({ phase: "runtime retention attempt 1/1: dependency inventory" });
  const inventoryStartedAt = performance.now();
  const project = (source: string) => projectRetainedRuntimePath(params.privateRoot, source);
  const candidateRoot = project(params.sourceRoot);
  const plan = await prepareUpdateCandidatePluginTrees({
    roots: new Map(params.roots.map((source) => [source, project(source)])),
    project,
    targetStateDir: params.privateRoot,
    candidateRoot,
    retainedHostRoot: params.sourceRoot,
    retainedDependencyRoot: params.retainedDependencyRoot,
  });
  const inventoryMs = Math.round(performance.now() - inventoryStartedAt);
  report({
    phase: `runtime retention attempt 1/1: materializing ${plan.entries.length} entries (${plan.bytes} estimated bytes) after ${inventoryMs}ms inventory`,
  });
  const materializationStartedAt = performance.now();
  const counts = await linkUpdateCandidatePluginTrees(plan, {
    targetStateDir: params.privateRoot,
    candidateRoot,
    // Only this subprocess writes the private tree. Its parent kills and joins
    // the process before cleanup, then rechecks authority before using the result.
    assertCurrent() {},
  });
  if ("unusableReason" in counts) {
    return counts;
  }
  // Tree discovery stays in the worker. Returning the plan, or even its file
  // paths, can exceed stdout's capture limit after materialization succeeded.
  const files = plan.entries.filter((entry) => entry.kind === "file").map((entry) => entry.path);
  await fs.writeFile(retainedRuntimeFileList(params.privateRoot), JSON.stringify(files), {
    mode: 0o600,
    flag: "wx",
  });
  return {
    relocations: plan.relocations,
    fileCount: files.length,
    entries: plan.entries.length,
    estimatedBytes: plan.bytes,
    inventoryMs,
    materializationMs: Math.round(performance.now() - materializationStartedAt),
    ...counts,
  };
}
