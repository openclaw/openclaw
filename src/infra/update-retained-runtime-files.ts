import path from "node:path";
import { z } from "zod";
import { UpdateCandidatePluginTreePlanSchema } from "./update-candidate-plugin-tree-schema.js";
import { prepareUpdateCandidatePluginTrees } from "./update-candidate-plugin-tree.js";
import { createUpdateStateInspectionReporter } from "./update-candidate-state.diagnostics.js";
import { linkUpdateCandidatePluginTrees } from "./update-retained-runtime-tree.js";

export const RetainedRuntimeFilesSchema = z.object({
  plan: UpdateCandidatePluginTreePlanSchema,
  inventoryMs: z.number().nonnegative(),
  materializationMs: z.number().nonnegative(),
  linked: z.number().int().nonnegative(),
  copied: z.number().int().nonnegative(),
});

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
  return {
    plan,
    inventoryMs,
    materializationMs: Math.round(performance.now() - materializationStartedAt),
    ...counts,
  };
}
